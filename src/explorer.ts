import { type Hex } from 'viem';

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
        // 1. Fetch Bytecode from RPC
        const bytecode = await this.fetchBytecode(address, rpcUrl);

        // 2. Try Fetching from Etherscan
        if (this.etherscanKey) {
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
