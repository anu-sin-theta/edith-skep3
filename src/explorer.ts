import { type Hex } from 'viem';
import { checkThreat } from './threats.js';

export interface ContractInfo {
    sourceCode?: string;
    abi?: any;
    name?: string;
    isVerified: boolean;
    bytecode: Hex;
}

export class ContractExplorer {
    private etherscanKey: string;

    constructor(etherscanKey: string) {
        this.etherscanKey = etherscanKey;
    }

    async getContractInfo(address: string, rpcUrl: string): Promise<ContractInfo> {
        // 0. Check for known threats first!
        const threat = checkThreat(address);
        if (threat) {
            return {
                isVerified: true, // Treat as verified so we use the report as source
                name: `🚨 THREAT DETECTED: ${threat.actor}`,
                sourceCode: `// !!! THREAT INTELLIGENCE REPORT !!!
// Actor: ${threat.actor}
// Campaign: ${threat.campaign}
// Description: ${threat.description}
// Severity: ${threat.severity}

/* 
This address is a known malicious entity. The transaction logic is highly dangerous.
Even if the local simulation trace looks empty, this address is used to distribute
malicious payloads (e.g. ${threat.campaign}).
*/`,
                bytecode: '0x', // Placeholder
            };
        }

        // 1. Fetch Bytecode from RPC
        const bytecode = await this.fetchBytecode(address, rpcUrl);

        if (!bytecode || bytecode === '0x' || bytecode === '0x0') {
            return { isVerified: false, bytecode: '0x', sourceCode: '// WARNING: No bytecode found at this address on the current chain/fork.' };
        }

        // 2. Resolve Chain ID from RPC (minimal effort)
        let chainId = 1; // Default to Ethereum
        if (rpcUrl.includes('binance') || rpcUrl.includes('bsc')) chainId = 56;
        if (rpcUrl.includes('polygon')) chainId = 137;
        if (rpcUrl.includes('arbitrum')) chainId = 42161;
        if (rpcUrl.includes('base')) chainId = 8453;

        // 3. Try Sourcify (Supports many chains without API key)
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
                        sourceCode,
                        name: `Sourcify Verified (Chain ${chainId})`,
                        isVerified: true,
                        bytecode,
                    };
                }
            }
        } catch (err) { }

        // 4. Try Etherscan (Only if on Ethereum Mainnet or key is provided)
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
            } catch (err) {
                console.error(' [warn] Etherscan fetch failed:', err);
            }
        }

        return { isVerified: false, bytecode };
    }

    private async fetchBytecode(address: string, rpcUrl: string): Promise<Hex> {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getCode',
                params: [address, 'latest']
            })
        });
        const data: any = await res.json();
        return data.result;
    }

    /**
     * Optional: Fetch decompiled code from a public API if unverified.
     * api.dedub.io is a popular one.
     */
    async decompile(address: string): Promise<string | undefined> {
        try {
            const url = `https://api.dedub.io/v1/decompile/${address}`;
            const res = await fetch(url);
            if (!res.ok) return undefined;
            const data: any = await res.json();
            return data.decompiled_source || data.source;
        } catch {
            return undefined;
        }
    }
}
