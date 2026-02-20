import { type Hex } from 'viem';
import { getThreat } from './intel.js';

export interface ContractInfo {
    sourceCode?: string;
    abi?: any[];
    name?: string;
    isVerified: boolean;
    bytecode: string;
}

export class ContractExplorer {
    private etherscanKey: string;

    constructor(etherscanKey: string) {
        this.etherscanKey = etherscanKey;
    }

    async getContractInfo(address: string, rpcUrl: string): Promise<ContractInfo> {
        // 0. Check Intelligence Database
        const threat = getThreat(address);
        if (threat) {
            return {
                isVerified: true,
                name: `🚨 SECURITY ALERT: ${threat.actor}`,
                sourceCode: `// !!! SECURITY ALERT: THREAT DETECTED !!!\n// Actor: ${threat.actor}\n// Description: ${threat.description}\n// Severity: ${threat.severity}`,
                bytecode: '0x',
            };
        }

        // 1. Fetch Bytecode from RPC
        const bytecode = await this.fetchBytecode(address, rpcUrl);

        if (!bytecode || bytecode === '0x' || bytecode === '0x0') {
            return { isVerified: false, bytecode: '0x', sourceCode: '// WARNING: No bytecode found at this address.' };
        }

        // 2. Perform Advanced Heuristic Analysis
        const heuristics = this.analyzeBytecode(bytecode);

        // 3. Resolve Chain ID
        let chainId = 1;
        if (rpcUrl.includes('binance') || rpcUrl.includes('bsc')) chainId = 56;

        // 4. Try Sourcify
        try {
            const url = `https://sourcify.dev/server/files/any/${chainId}/${address}`;
            const res = await fetch(url);
            if (res.ok) {
                const data: any = await res.json();
                if (data.status === 'full' || data.status === 'partial') {
                    const sourceCode = data.files
                        .filter((f: any) => f.name.endsWith('.sol'))
                        .map((f: any) => `// File: ${f.name}\n${f.content}`)
                        .join('\n\n');

                    return {
                        sourceCode: (heuristics.warning ? heuristics.warning + '\n\n' : '') + sourceCode,
                        name: `Sourcify Verified`,
                        isVerified: true,
                        bytecode,
                    };
                }
            }
        } catch (err) { }

        // 5. Try Etherscan (Only if on Ethereum Mainnet)
        if (this.etherscanKey && chainId === 1) {
            try {
                const url = `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&apikey=${this.etherscanKey}`;
                const res = await fetch(url);
                const data: any = await res.json();

                if (data.status === '1' && data.result[0]?.SourceCode) {
                    const res0 = data.result[0];
                    return {
                        sourceCode: res0.SourceCode,
                        abi: JSON.parse(res0.ABI),
                        name: res0.ContractName,
                        isVerified: true,
                        bytecode,
                    };
                }
            } catch (err) { }
        }

        // 6. Fallback to heuristics if unverified
        if (heuristics.isSuspicious) {
            return {
                isVerified: true,
                name: `🚨 SECURITY ALERT: ${heuristics.type}`,
                sourceCode: heuristics.warning,
                bytecode,
            };
        }

        return { isVerified: false, bytecode };
    }

    private analyzeBytecode(bytecode: string): { isSuspicious: boolean, type?: string, warning?: string } {
        const hex = bytecode.toLowerCase();

        const hasXOR = (hex.match(/18/g) || []).length > 2;
        const hasDelegateCall = hex.includes('f4');
        const hasSelfDestruct = hex.includes('ff');
        const hasAddrMask = hex.includes('ffffffffffffffffffffffffffffffffffffffff');

        const score = (hasXOR ? 2 : 0) + (hasDelegateCall ? 3 : 0) + (hasSelfDestruct ? 5 : 0) + (hasAddrMask ? 2 : 0);

        if (score >= 4 || (hasXOR && hex.length > 5000)) {
            return {
                isSuspicious: true,
                type: 'Malicious Signature',
                warning: `// !!! SECURITY ALERT: MALICIOUS PATTERN DETECTED !!!
// Pattern: Suspicious Bytecode Score (${score}/10)
// Evidence: ${hasXOR ? 'XOR-based obfuscation opcodes detected. ' : ''}${hasDelegateCall ? 'Hidden proxy delegation (DELEGATECALL). ' : ''}
//
// Risk: This contract uses low-level opcodes (XOR/Delegate) often associated with 
//       EtherHiding campaigns or drainers. Proceed with extreme caution.`
            };
        }

        return { isSuspicious: false };
    }

    private async fetchBytecode(address: string, rpcUrl: string): Promise<Hex> {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getCode',
                params: [address, 'latest'],
            }),
        });
        const data: any = await res.json();
        return data.result || '0x';
    }

    async decompile(address: string): Promise<string | undefined> {
        try {
            const url = `https://api.dedub.io/api/v1/decompile/${address}`;
            const res = await fetch(url);
            const data: any = await res.json();
            return data.decompiled;
        } catch (err) {
            return undefined;
        }
    }
}
