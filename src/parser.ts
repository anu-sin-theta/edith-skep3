import { createPublicClient, http, type Hex, formatEther, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

const LOCAL_ANVIL_RPC = 'http://127.0.0.1:8545';

// Known ERC-20 event signatures
const KNOWN_TOPICS: Record<string, string> = {
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': 'Transfer(address,address,uint256)',
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': 'Approval(address,address,uint256)',
    '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': 'Deposit(address,uint256)',
    '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': 'Withdrawal(address,uint256)',
};

// Suspicious patterns in traces
const SUSPICIOUS_OPCODES = ['DELEGATECALL', 'SELFDESTRUCT', 'CREATE2'];

export interface ParsedTransaction {
    hash: Hex;
    to: string;
    from: string;
    value: string;
    status: 'success' | 'reverted';
    gasUsed: string;
    logs: ParsedLog[];
    trace: ParsedTrace | null;
    warnings: string[];
}

export interface ParsedLog {
    address: string;
    eventName: string;
    raw: string;
    decoded?: Record<string, string>;
}

export interface ParsedTrace {
    type: string;
    to: string;
    from: string;
    input: string;
    output: string;
    calls?: ParsedTrace[];
    suspiciousOps: string[];
}

export class TransactionParser {
    private client;

    constructor(rpcUrl: string = LOCAL_ANVIL_RPC) {
        this.client = createPublicClient({
            chain: mainnet,
            transport: http(rpcUrl),
        });
    }

    async parseReceipt(txHash: Hex): Promise<Partial<ParsedTransaction>> {
        const receipt = await this.client.getTransactionReceipt({ hash: txHash });
        const tx = await this.client.getTransaction({ hash: txHash });

        const logs = receipt.logs.map((log): ParsedLog => {
            const topic0 = log.topics[0];
            const eventName = topic0 ? (KNOWN_TOPICS[topic0] || `Unknown(${topic0.slice(0, 10)}...)`) : 'Unknown';

            // Try to decode Transfer/Approval
            let decoded: Record<string, string> | undefined;
            if (topic0 === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                const from = '0x' + (log.topics[1] || '').slice(26);
                const to = '0x' + (log.topics[2] || '').slice(26);
                const amount = BigInt(log.data || '0x0');
                decoded = { from, to, amount: amount.toString() };
            } else if (topic0 === '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925') {
                const owner = '0x' + (log.topics[1] || '').slice(26);
                const spender = '0x' + (log.topics[2] || '').slice(26);
                const amount = BigInt(log.data || '0x0');
                const isInfinite = amount > BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
                decoded = { owner, spender, amount: isInfinite ? 'INFINITE (Max Uint256)' : amount.toString() };
            }

            return {
                address: log.address,
                eventName,
                raw: log.data,
                decoded,
            };
        });

        const warnings: string[] = this.detectWarningsFromLogs(logs, tx.from);

        return {
            hash: txHash,
            to: receipt.to || 'Contract Creation',
            from: receipt.from,
            value: formatEther(tx.value) + ' ETH',
            status: receipt.status === 'success' ? 'success' : 'reverted',
            gasUsed: receipt.gasUsed.toString(),
            logs,
            warnings,
        };
    }

    parseTrace(rawTrace: any): ParsedTrace | null {
        if (!rawTrace) return null;

        const suspiciousOps: string[] = [];

        const extractSuspicious = (traceNode: any): ParsedTrace => {
            const calls = (traceNode.calls || []).map(extractSuspicious);

            // Check for suspicious opcodes
            if (traceNode.type && SUSPICIOUS_OPCODES.includes(traceNode.type.toUpperCase())) {
                suspiciousOps.push(`${traceNode.type} to ${traceNode.to}`);
            }

            return {
                type: traceNode.type || 'CALL',
                to: traceNode.to || 'unknown',
                from: traceNode.from || 'unknown',
                input: (traceNode.input || '0x').slice(0, 64),
                output: (traceNode.output || '0x').slice(0, 64),
                calls: calls.length > 0 ? calls : undefined,
                suspiciousOps,
            };
        };

        return extractSuspicious(rawTrace);
    }

    private detectWarningsFromLogs(logs: ParsedLog[], senderAddress: string): string[] {
        const warnings: string[] = [];

        for (const log of logs) {
            // Infinite approval detection
            if (log.eventName.startsWith('Approval') && log.decoded?.amount === 'INFINITE (Max Uint256)') {
                warnings.push(`⚠️  INFINITE APPROVAL granted to ${log.decoded.spender} for token ${log.address}`);
            }

            // Transfer to unknown address (not sender)
            if (log.eventName.startsWith('Transfer') && log.decoded) {
                if (log.decoded.from.toLowerCase() === senderAddress.toLowerCase()) {
                    warnings.push(`⚠️  Token transfer FROM your wallet at ${log.address}`);
                }
            }
        }

        return warnings;
    }

    formatForAI(parsed: Partial<ParsedTransaction>, trace: ParsedTrace | null, contractCode?: string): string {
        const logSummary = (parsed.logs || []).map(l => {
            let str = `  - Event: ${l.eventName} on ${l.address}`;
            if (l.decoded) {
                str += `\n    Decoded: ${JSON.stringify(l.decoded)}`;
            }
            return str;
        }).join('\n');

        const traceSummary = trace ? JSON.stringify({
            type: trace.type,
            to: trace.to,
            suspiciousOps: trace.suspiciousOps,
            numSubCalls: (trace.calls || []).length,
        }, null, 2) : 'No trace available.';

        let codeSection = '';
        if (contractCode) {
            // Include a safe snippet of the code (AI has token limits)
            const cleanCode = contractCode.slice(0, 5000);
            codeSection = `\n=== TARGET CONTRACT CODE (Logic) ===\n${cleanCode}\n`;
        }

        return `
=== TRANSACTION SIMULATION REPORT ===
Hash: ${parsed.hash}
From: ${parsed.from}
To:   ${parsed.to}
Value: ${parsed.value}
Status: ${parsed.status?.toUpperCase()}
Gas Used: ${parsed.gasUsed}
${codeSection}
=== EMITTED EVENTS (Logs) ===
${logSummary || 'No events emitted.'}

=== CALL TRACE (Local Anvil) ===
${traceSummary}

=== PRE-DETECTED WARNINGS ===
${(parsed.warnings || []).join('\n') || 'None detected by parser.'}
    `.trim();
    }
}
