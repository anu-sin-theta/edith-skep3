import { spawn, type ChildProcess } from 'child_process';
import { createPublicClient, createWalletClient, http, type Hex, encodeFunctionData, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

// Public free RPC - no API key required, works for forking
export const DEFAULT_FORK_RPC = 'https://ethereum.publicnode.com';
const LOCAL_ANVIL_RPC = 'http://127.0.0.1:8545';

export interface SimulationResult {
    txHash: Hex;
    status: 'success' | 'reverted';
    gasUsed: bigint;
    logs: any[];
    trace: any;
}

export class AnvilSimulator {
    private anvilProcess: ChildProcess | null = null;
    private remoteRpcUrl: string;
    private ready = false;

    constructor(remoteRpcUrl: string = DEFAULT_FORK_RPC) {
        this.remoteRpcUrl = remoteRpcUrl;
    }

    async startFork(blockNumber?: bigint): Promise<void> {
        const args = [
            '--fork-url', this.remoteRpcUrl,
            '--port', '8545',
        ];

        if (blockNumber) {
            args.push('--fork-block-number', blockNumber.toString());
        }

        const anvilBin = `${process.env.HOME}/.foundry/bin/anvil`;

        return new Promise((resolve, reject) => {
            try {
                this.anvilProcess = spawn(anvilBin, args, {
                    stdio: 'ignore',   // suppress all anvil output
                    detached: false,
                });

                this.anvilProcess.on('error', (err) => {
                    reject(new Error(`Failed to start Anvil: ${err.message}. Run: curl -L https://foundry.paradigm.xyz | bash && foundryup`));
                });

                this.anvilProcess.on('exit', (code) => {
                    if (!this.ready && code !== null && code !== 0) {
                        reject(new Error(`Anvil crashed on startup (Exit ${code}). The target RPC might be rate-limiting or down.`));
                    }
                });

                // Poll HTTP until Anvil is actually ready to accept connections
                const poll = async () => {
                    const maxMs = 20_000;
                    const interval = 300;
                    let elapsed = 0;
                    while (elapsed < maxMs) {
                        if (this.ready) return; // connected or rejected by exit
                        try {
                            const res = await fetch('http://127.0.0.1:8545', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
                                signal: AbortSignal.timeout(500),
                            });
                            if (res.ok) { this.ready = true; resolve(); return; }
                        } catch { /* not ready yet */ }
                        await new Promise(r => setTimeout(r, interval));
                        elapsed += interval;
                    }
                    if (!this.ready) reject(new Error('Anvil startup timed out after 20s. Check that port 8545 is free.'));
                };
                poll();

            } catch (e: any) {
                reject(new Error(`Anvil not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash`));
            }
        });
    }

    // Returns a viem client connected to the LOCAL Anvil node
    getClient() {
        return createPublicClient({
            chain: mainnet,
            transport: http(LOCAL_ANVIL_RPC),
        });
    }

    // Impersonate any address on the local fork (no private key needed)
    async impersonateAccount(address: Hex): Promise<void> {
        await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'anvil_impersonateAccount',
                params: [address],
            }),
        });
    }

    async stopImpersonating(address: Hex): Promise<void> {
        await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'anvil_stopImpersonatingAccount',
                params: [address],
            }),
        });
    }

    // Fund an account on local fork (for gas)
    async setBalance(address: Hex, ethAmount: bigint = 10n ** 18n): Promise<void> {
        await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'anvil_setBalance',
                params: [address, '0x' + ethAmount.toString(16)],
            }),
        });
    }

    // Send a raw transaction to local Anvil and mine it
    async simulateTransaction(params: {
        from: Hex;
        to: Hex;
        data?: Hex;
        value?: bigint;
    }): Promise<Hex> {
        const txParams: any = {
            from: params.from,
            to: params.to,
            data: params.data || '0x',
            value: params.value ? '0x' + params.value.toString(16) : '0x0',
            gas: '0x' + (3_000_000).toString(16),
        };

        const sendRes = await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 2,
                method: 'eth_sendTransaction',
                params: [txParams],
            }),
        });
        const sendData: any = await sendRes.json();
        if (sendData.error) throw new Error(`Simulation failed: ${sendData.error.message}`);

        // Explicitly mine a block to include the tx
        await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 3,
                method: 'evm_mine',
                params: [],
            }),
        });

        const txHash = sendData.result as Hex;

        // Poll until the receipt is available (Anvil indexes asynchronously)
        for (let i = 0; i < 20; i++) {
            const r = await fetch(LOCAL_ANVIL_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 10,
                    method: 'eth_getTransactionReceipt',
                    params: [txHash],
                }),
            });
            const rj: any = await r.json();
            if (rj.result !== null) break;
            await new Promise(res => setTimeout(res, 200));
        }

        return txHash;
    }

    async getBalance(address: Hex): Promise<bigint> {
        const res = await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 7,
                method: 'eth_getBalance',
                params: [address, 'latest'],
            }),
        });
        const data: any = await res.json();
        return BigInt(data.result || '0x0');
    }

    async traceStateDiff(txHash: Hex): Promise<any> {
        const res = await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 6,
                method: 'debug_traceTransaction',
                params: [txHash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }],
            }),
        });
        const data: any = await res.json();
        return data.result;
    }

    // Get the full EVM trace from LOCAL Anvil (this is free — it's your own node)
    async traceTransaction(txHash: Hex): Promise<any> {
        const res = await fetch(LOCAL_ANVIL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 4,
                method: 'debug_traceTransaction',
                params: [txHash, { tracer: 'callTracer' }],
            }),
        });
        const data: any = await res.json();
        if (data.error) {
            // Fallback to structLogs tracer
            const res2 = await fetch(LOCAL_ANVIL_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 5,
                    method: 'debug_traceTransaction',
                    params: [txHash, {}],
                }),
            });
            const data2: any = await res2.json();
            return data2.result;
        }
        return data.result;
    }

    async stop(): Promise<void> {
        if (this.anvilProcess) {
            this.anvilProcess.kill('SIGTERM');
            this.anvilProcess = null;
            this.ready = false;
        }
    }

    get isReady() {
        return this.ready;
    }
}
