import { createPublicClient, http, type Hex, formatEther, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

const LOCAL_ANVIL_RPC = 'http://127.0.0.1:8545';

// Known ERC-20 event signatures
const KNOWN_TOPICS: Record<string, string> = {
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': 'Transfer(address,address,uint256)',
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': 'Approval(address,address,uint256)',
    '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': 'Deposit(address,uint256)',
    '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': 'Withdrawal(address,uint256)',
    '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31': 'ApprovalForAll(address,address,bool)',
    '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62': 'TransferSingle(address,address,address,uint256,uint256)',
    '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb': 'TransferBatch(address,address,address,uint256[],uint256[])'
};

// Suspicious patterns in traces
const SUSPICIOUS_OPCODES = ['DELEGATECALL', 'SELFDESTRUCT', 'CREATE2'];

export interface StateChange {
    address: string;
    balanceChange?: string;
    nonceChange?: boolean;
    storageModified?: boolean;
}

export interface ParsedTransaction {
    hash: Hex;
    to: string;
    from: string;
    value: string;
    status: 'success' | 'reverted';
    gasUsed: string;
    gasFee?: bigint;
    logs: ParsedLog[];
    trace: ParsedTrace | null;
    stateChanges?: StateChange[];
    balanceLoss?: { amount: bigint; formatted: string };
    tokenLosses?: { tokenAddress: string; amount: string; formatted: string }[];
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

import axios from 'axios';

export class TransactionParser {
    private client;
    private signatureCache: Record<string, string> = {};

    constructor(rpcUrl: string = LOCAL_ANVIL_RPC) {
        this.client = createPublicClient({
            chain: mainnet,
            transport: http(rpcUrl),
        });
    }

    async parseReceipt(txHash: Hex): Promise<Partial<ParsedTransaction>> {
        const receipt = await this.client.getTransactionReceipt({ hash: txHash });
        const tx = await this.client.getTransaction({ hash: txHash });

        const tokenLosses: { tokenAddress: string; amount: string; formatted: string }[] = [];

        const logs = receipt.logs.map((log): ParsedLog => {
            const topic0 = log.topics[0];
            const eventName = topic0 ? (KNOWN_TOPICS[topic0] || `Unknown(${topic0.slice(0, 10)}...)`) : 'Unknown';

            // Try to decode Transfer/Approval
            let decoded: Record<string, string> | undefined;
            if (topic0 === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                const from = '0x' + (log.topics[1] || '').slice(26);
                const to = '0x' + (log.topics[2] || '').slice(26);

                if (log.topics.length === 4) {
                    const tokenId = BigInt(log.topics[3] || '0x0').toString();
                    decoded = { from, to, tokenId };
                    if (from.toLowerCase() === tx.from.toLowerCase()) {
                        tokenLosses.push({
                            tokenAddress: log.address,
                            amount: '1',
                            formatted: `NFT ID ${tokenId}`
                        });
                    }
                } else {
                    const amount = BigInt(log.data || '0x0');
                    decoded = { from, to, amount: amount.toString() };

                    // Track if the sender is losing ERC20 tokens
                    if (from.toLowerCase() === tx.from.toLowerCase()) {
                        let decimals = 18; // fallback
                        // A quick heuristic for USDC/USDT which have 6 decimals
                        if (log.address.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ||
                            log.address.toLowerCase() === '0xdac17f958d2ee523a2206206994597c13d831ec7') {
                            decimals = 6;
                        }
                        tokenLosses.push({
                            tokenAddress: log.address,
                            amount: amount.toString(),
                            formatted: formatUnits(amount, decimals)
                        });
                    }
                }
            } else if (topic0 === '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925') {
                const owner = '0x' + (log.topics[1] || '').slice(26);
                const spender = '0x' + (log.topics[2] || '').slice(26);

                if (log.topics.length === 4) {
                    const tokenId = BigInt(log.topics[3] || '0x0').toString();
                    decoded = { owner, spender, tokenId };
                } else {
                    const amount = BigInt(log.data || '0x0');
                    const isInfinite = amount > BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
                    decoded = { owner, spender, amount: isInfinite ? 'INFINITE (Max Uint256)' : amount.toString() };
                }
            } else if (topic0 === '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31') {
                const owner = '0x' + (log.topics[1] || '').slice(26);
                const operator = '0x' + (log.topics[2] || '').slice(26);
                const approved = BigInt(log.data || '0x0') !== 0n;
                decoded = { owner, operator, approved: approved ? 'true' : 'false' };
            } else if (topic0 === '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62') {
                const operator = '0x' + (log.topics[1] || '').slice(26);
                const from = '0x' + (log.topics[2] || '').slice(26);
                const to = '0x' + (log.topics[3] || '').slice(26);
                const idHex = log.data.slice(0, 66);
                const valueHex = '0x' + log.data.slice(66);
                const id = BigInt(idHex || '0x0').toString();
                const value = BigInt(valueHex || '0x0').toString();
                decoded = { from, to, operator, id, value };

                if (from.toLowerCase() === tx.from.toLowerCase()) {
                    tokenLosses.push({
                        tokenAddress: log.address,
                        amount: value,
                        formatted: `${value} ERC-1155 NFT(s) ID ${id}`
                    });
                }
            } else if (topic0 === '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb') {
                const operator = '0x' + (log.topics[1] || '').slice(26);
                const from = '0x' + (log.topics[2] || '').slice(26);
                const to = '0x' + (log.topics[3] || '').slice(26);
                decoded = { from, to, operator, note: 'Batch transfer decoded info omitted' };
                if (from.toLowerCase() === tx.from.toLowerCase()) {
                    tokenLosses.push({
                        tokenAddress: log.address,
                        amount: 'unknown',
                        formatted: `Multiple ERC-1155 NFTs`
                    });
                }
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
            gasFee: receipt.gasUsed * (receipt.effectiveGasPrice || BigInt(0)),
            logs,
            tokenLosses,
            warnings,
        };
    }

    async parseTrace(rawTrace: any): Promise<ParsedTrace | null> {
        if (!rawTrace) return null;

        const suspiciousOps: string[] = [];
        const callStack = new Set<string>();

        const extractSuspicious = async (traceNode: any, parentTraceNode?: any): Promise<ParsedTrace> => {
            const nodeTo = traceNode.to?.toLowerCase() || '';
            if (nodeTo && callStack.has(nodeTo)) {
                suspiciousOps.push(`REENTRANCY LOOP detected at ${traceNode.to}`);
            }
            if (nodeTo) {
                callStack.add(nodeTo);
            }

            const childPromises = (traceNode.calls || []).map((node: any) => extractSuspicious(node, traceNode));
            const calls = await Promise.all(childPromises) as ParsedTrace[];

            if (nodeTo) {
                callStack.delete(nodeTo);
            }

            // Check for suspicious opcodes
            if (traceNode.type) {
                const typeUpper = traceNode.type.toUpperCase();
                if (SUSPICIOUS_OPCODES.includes(typeUpper)) {
                    if (typeUpper === 'DELEGATECALL') {
                        // Avoid false positives on standard forwarding proxies
                        const isStandardProxy = parentTraceNode &&
                            parentTraceNode.input === traceNode.input &&
                            parentTraceNode.type !== 'DELEGATECALL';
                        if (!isStandardProxy) {
                            suspiciousOps.push(`${traceNode.type} to ${traceNode.to}`);
                        }
                    } else {
                        suspiciousOps.push(`${traceNode.type} to ${traceNode.to}`);
                    }
                }
            }

            let decodedInput = `Raw: ${(traceNode.input || '0x').slice(0, 512)}...`;

            // Auto decoding using 4byte directory
            if (traceNode.input && traceNode.input.length >= 10 && traceNode.input !== '0x') {
                const selector = traceNode.input.slice(0, 10);
                if (!this.signatureCache[selector]) {
                    try {
                        const res = await axios.get(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`);
                        if (res.data && res.data.results && res.data.results.length > 0) {
                            this.signatureCache[selector] = res.data.results[0].text_signature;
                        } else {
                            this.signatureCache[selector] = `Unknown(${selector})`;
                        }
                    } catch (e) {
                        this.signatureCache[selector] = `Unknown(${selector})`;
                    }
                }
                decodedInput = `${this.signatureCache[selector]} | ${decodedInput}`;
            }

            return {
                type: traceNode.type || 'CALL',
                to: traceNode.to || 'unknown',
                from: traceNode.from || 'unknown',
                input: decodedInput,
                output: (traceNode.output || '0x').slice(0, 512),
                calls: calls.length > 0 ? calls : undefined,
                suspiciousOps,
            };
        };

        return await extractSuspicious(rawTrace, null);
    }

    parseStateDiff(rawDiff: any, impersonatedAddress: string): { stateChanges: StateChange[], balanceLoss?: { amount: bigint, formatted: string } } {
        if (!rawDiff) return { stateChanges: [] };

        const changes: StateChange[] = [];
        let balanceLoss: { amount: bigint, formatted: string } | undefined;

        const pre = rawDiff.pre || {};
        const post = rawDiff.post || {};

        const allAddresses = new Set([...Object.keys(pre), ...Object.keys(post)]);

        allAddresses.forEach(address => {
            const preState = pre[address] || { balance: '0x0', nonce: 0, storage: {} };
            const postState = post[address] || { balance: '0x0', nonce: 0, storage: {} };

            let balanceChange = undefined;
            const preBal = BigInt(preState.balance || '0x0');
            const postBal = BigInt(postState.balance || '0x0');

            if (preBal !== postBal) {
                const diff = postBal - preBal;
                const sign = diff > 0n ? '+' : '-';
                const absDiff = diff > 0n ? diff : -diff;
                balanceChange = `${sign}${formatEther(absDiff)} ETH`;

                if (address.toLowerCase() === impersonatedAddress.toLowerCase() && diff < 0n) {
                    balanceLoss = { amount: -diff, formatted: formatEther(-diff) };
                }
            }

            const storageModified = JSON.stringify(preState.storage || {}) !== JSON.stringify(postState.storage || {});
            const nonceChange = preState.nonce !== postState.nonce;

            if (balanceChange || storageModified || nonceChange) {
                changes.push({
                    address,
                    balanceChange,
                    nonceChange,
                    storageModified
                });
            }
        });

        return { stateChanges: changes, balanceLoss };
    }

    private detectWarningsFromLogs(logs: ParsedLog[], senderAddress: string): string[] {
        const warnings: string[] = [];

        for (const log of logs) {
            // Infinite approval detection or ApprovalForAll
            if (log.eventName.startsWith('Approval') && log.decoded?.amount === 'INFINITE (Max Uint256)') {
                warnings.push(`⚠️  INFINITE APPROVAL granted to ${log.decoded.spender} for token ${log.address}`);
            } else if (log.eventName === 'ApprovalForAll(address,address,bool)' && log.decoded?.approved === 'true') {
                warnings.push(`⚠️  APPROVAL FOR ALL (NFTs) granted to ${log.decoded.operator} on collection ${log.address}`);
            } else if (log.eventName === 'Approval(address,address,uint256)' && log.decoded?.tokenId) {
                warnings.push(`⚠️  NFT APPROVAL granted to ${log.decoded.spender} for token ID ${log.decoded.tokenId} on ${log.address}`);
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
            const cleanCode = contractCode.slice(0, 25000);
            codeSection = `\n=== TARGET CONTRACT CODE (Logic) ===\n${cleanCode}\n`;
        }

        const stateDiffSummary = (parsed.stateChanges || []).map(sc => {
            let s = `  - Account: ${sc.address}`;
            if (sc.balanceChange) s += ` | Balance: ${sc.balanceChange}`;
            if (sc.nonceChange) s += ` | Nonce changed`;
            if (sc.storageModified) s += ` | Storage modified`;
            return s;
        }).join('\n');

        return `
=== TRANSACTION SIMULATION REPORT ===
Hash: ${parsed.hash}
From: ${parsed.from}
To:   ${parsed.to}
Value: ${parsed.value}
Status: ${parsed.status?.toUpperCase()}
Gas Used: ${parsed.gasUsed}
Native Value Lost: ${parsed.balanceLoss ? parsed.balanceLoss.formatted + ' ETH' : '0 ETH'}
ERC20 Tokens Lost: ${(parsed.tokenLosses && parsed.tokenLosses.length > 0) ? parsed.tokenLosses.map(t => `${t.formatted} unit(s) of ${t.tokenAddress}`).join(', ') : 'None detected'}
${codeSection}
=== EMITTED EVENTS (Logs) ===
${logSummary || 'No events emitted.'}

=== STATE DIFFERENCES (Pre/Post) ===
${stateDiffSummary || 'No state changes.'}

=== CALL TRACE (Local Anvil) ===
${traceSummary}

=== PRE-DETECTED WARNINGS ===
${(parsed.warnings || []).join('\n') || 'None detected by parser.'}
    `.trim();
    }
}
