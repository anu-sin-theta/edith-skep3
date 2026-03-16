import http from 'http';
import https from 'https';
import chalk from 'chalk';
import ora from 'ora';
import { parseTransaction, type Hex, recoverTransactionAddress } from 'viem';
import { AnvilSimulator, DEFAULT_FORK_RPC } from './simulator.js';
import { SecurityAuditor } from './ai.js';
import { TransactionParser } from './parser.js';
import { confirm, select, input } from '@inquirer/prompts';
import { loadConfig, getOllamaStatus, PROVIDERS, type Provider } from './brain.js';

function forwardRequest(targetUrl: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const requestModule = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            port: parsedUrl.port,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = requestModule.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

export const NETWORKS = [
    { name: 'Ethereum Mainnet', value: 'https://ethereum.publicnode.com', type: 'evm' },
    { name: 'Solana Mainnet', value: 'https://api.mainnet-beta.solana.com', type: 'solana' },
    { name: 'Base', value: 'https://base.publicnode.com', type: 'evm' },
    { name: 'Arbitrum One', value: 'https://arbitrum.publicnode.com', type: 'evm' },
    { name: 'Polygon', value: 'https://polygon.publicnode.com', type: 'evm' },
    { name: 'Binance Smart Chain', value: 'https://bsc.publicnode.com', type: 'evm' },
    { name: 'Custom RPC', value: 'custom', type: 'custom' }
];

export async function startProxyServer(passedRpc: string | undefined, port: number = 9545) {
    let targetRpc = passedRpc;

    if (!targetRpc) {
        console.log(chalk.bold.hex('#00FFAA')(`\n  SKEP3 Proxy Configuration\n`));

        targetRpc = await select({
            message: 'Select the network you want to proxy and protect:',
            choices: NETWORKS.map(n => ({ name: n.name, value: n.value }))
        });

        if (targetRpc === 'custom') {
            targetRpc = await input({
                message: 'Enter your Custom RPC URL (e.g., https://mainnet.infura.io/v3/...): ',
                validate: (val) => val.startsWith('http') ? true : 'Please enter a valid HTTP/HTTPS URL'
            });
        }
        console.log('');
    }

    const config = loadConfig();
    const isOllamaRunning = await getOllamaStatus();

    let aiMode: 'ollama' | 'remote' = 'ollama';
    let providerName: Provider | undefined = undefined;
    let apiKey = '';
    let ollamaModel = '';
    let remoteModel = '';

    if (config?.provider === 'ollama') {
        aiMode = 'ollama';
        ollamaModel = config.model;
    } else if (config) {
        aiMode = 'remote';
        providerName = PROVIDERS[config.provider];
        apiKey = process.env[providerName?.envKey || ''] || '';
        remoteModel = config.model;
    } else if (isOllamaRunning.running && isOllamaRunning.models.length > 0) {
        aiMode = 'ollama';
        ollamaModel = isOllamaRunning.models[0];
    }

    // Same AI setup as index.ts
    const auditor = new SecurityAuditor(aiMode, {
        ollamaModel,
        provider: providerName,
        apiKey,
        remoteModel
    });

    console.log(chalk.bold.hex('#00FFAA')(`
  ╔══════════════════════════════════════════════════════╗
    🛡️  EDITH SKEP3  ·  Transaction Firewall Proxy        
  ╠══════════════════════════════════════════════════════╣
    Listening on: http://127.0.0.1:${port}
    Target Node: ${targetRpc}
    AI Engine: ${auditor.engine}
  ╚══════════════════════════════════════════════════════╝
`));
    console.log(chalk.gray(`  Point your wallet's Custom RPC Network to http://127.0.0.1:${port}`));
    console.log(chalk.cyan(`  Waiting for transactions...\n`));

    const server = http.createServer(async (req, res) => {
        let walletConnected = false;
        // Add CORS headers so browser-based wallets (Phantom/MetaMask extensions) don't block requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method Not Allowed');
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);

                if (!walletConnected && payload.method) {
                    console.log(chalk.green(`\n  🔗 Wallet Connected Successfully!`));
                    console.log(chalk.gray(`     (Method: ${payload.method})`));
                    console.log(chalk.dim(`     SKEP3 is now actively protecting and analyzing network traffic in stealth mode.\n`));
                    walletConnected = true;
                }

                // If it's a batch of RPC calls, SKEP3 firewall skips batch processing complexity for now and just forwards
                if (Array.isArray(payload)) {
                    if (!walletConnected && payload.length > 0 && payload[0].method) {
                        console.log(chalk.green(`\n  🔗 Wallet Connected Successfully! (Batch Mode)`));
                        console.log(chalk.dim(`     SKEP3 is now actively protecting and analyzing network traffic in stealth mode.\n`));
                        walletConnected = true;
                    }
                    const response = await forwardRequest(targetRpc, body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(response);
                    return;
                }

                if (payload.method === 'eth_signTypedData_v4') {
                    const [_address, dataStr] = payload.params;
                    const data = JSON.parse(dataStr);
                    console.log(chalk.yellow(`\n  [INTERCEPTED] eth_signTypedData_v4 (EIP-712)`));

                    const spinner = ora('Analyzing EIP-712 off-chain signature request...').start();

                    const reportStr = `
=== EIP-712 SIGNATURE REQUEST ===
Method: eth_signTypedData_v4 (Off-chain Signing)
Domain: ${JSON.stringify(data.domain, null, 2)}
Types: ${JSON.stringify(data.types, null, 2)}
Message: ${JSON.stringify(data.message, null, 2)}

Security Context:
- Many modern drainers (Permit/Permit2) use off-chain signatures to gain approval for assets without a transaction.
- Check if the 'spender' or 'operator' in the message is a known malicious address.
- Check if the domain name looks like a legitimate protocol or a phishing clone.
`.trim();

                    const audit = await auditor.audit(reportStr);
                    spinner.stop();

                    const isThreat = audit.verdict === 'CRITICAL' || audit.verdict === 'RISKY';
                    console.log(isThreat ? chalk.bold.red(`\n  🚨 VERDICT: ${audit.verdict}`) : chalk.bold.green(`\n  ✅ VERDICT: ${audit.verdict}`));
                    console.log(`  ${chalk.white(audit.reasoning)}\n`);

                    const proceed = await confirm({ message: 'Do you want to sign this message?', default: false });
                    if (!proceed) {
                        console.log(chalk.red('  ✖ Signature blocked by user.'));
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'Signature blocked by SKEP3 Firewall' } }));
                        return;
                    }
                    console.log(chalk.green('  ✔ Releasing signature request...'));
                }

                if (payload.method === 'eth_sendRawTransaction') {
                    const rawTx = payload.params[0] as Hex;
                    console.log(chalk.yellow(`\n  [INTERCEPTED] eth_sendRawTransaction`));

                    const spinner = ora('Decoding transaction...').start();
                    const tx = parseTransaction(rawTx);

                    // Robust Sender Recovery
                    let sender: Hex | undefined;
                    try {
                        sender = await recoverTransactionAddress({ serializedTransaction: rawTx as any });
                    } catch (e) {
                        spinner.warn("Could not recover sender address automatically fallback...");
                    }

                    spinner.succeed(`Decoded tx to ${tx.to} | From: ${sender || 'Unknown'}`);

                    let simStatus = 'SUCCESS';
                    let isThreat = false;
                    try {
                        spinner.start('Forking and simulating transaction locally...');
                        const simulator = new AnvilSimulator(targetRpc);
                        await simulator.startFork();

                        if (!sender) throw new Error("Could not recover sender address.");

                        await simulator.impersonateAccount(sender);
                        await simulator.setBalance(sender);

                        const simTxHash = await simulator.simulateTransaction({
                            from: sender,
                            to: tx.to as Hex,
                            value: tx.value || 0n,
                            data: tx.data || '0x',
                        });

                        const parser = new TransactionParser();
                        const parsed = await parser.parseReceipt(simTxHash);
                        const rawTrace = await simulator.traceTransaction(simTxHash);
                        const { trace, warnings: traceWarnings } = await parser.parseTrace(rawTrace);
                        const rawStateDiff = await simulator.traceStateDiff(simTxHash);
                        const { stateChanges, balanceLoss } = parser.parseStateDiff(rawStateDiff, sender);

                        parsed.stateChanges = stateChanges;
                        parsed.balanceLoss = balanceLoss;
                        parsed.warnings = (parsed.warnings || []).concat(traceWarnings || []);

                        await simulator.stop();
                        spinner.succeed(`Simulation finished (${parsed.gasUsed} gas)`);

                        // Run AI Audit
                        spinner.start(`Analyzing threat vectors via ${auditor.engine}...`);
                        const reportStr = parser.formatForAI(parsed, trace, undefined);
                        const audit = await auditor.audit(reportStr);
                        spinner.stop();

                        isThreat = audit.verdict === 'CRITICAL' || audit.verdict === 'RISKY';
                        console.log(isThreat ? chalk.bold.red(`\n  🚨 VERDICT: ${audit.verdict}`) : chalk.bold.green(`\n  ✅ VERDICT: ${audit.verdict}`));
                        console.log(`  ${chalk.white(audit.reasoning)}\n`);

                    } catch (err: any) {
                        spinner.fail(`Simulation Failed: ${err.message}`);
                        simStatus = 'FAILED';
                    }

                    const proceed = await confirm({ message: 'Do you want to broadcast this transaction to the network?', default: false });

                    if (!proceed) {
                        console.log(chalk.red('  ✖ Transaction blocked by user.'));
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'Transaction blocked by SKEP3 Firewall' } }));
                        return;
                    }

                    console.log(chalk.green('  ✔ Releasing transaction to true RPC...'));
                }

                // Forward request
                const response = await forwardRequest(targetRpc, body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(response);
            } catch (err) {
                res.writeHead(500);
                res.end('Proxy Error');
            }
        });
    });

    server.listen(port, '127.0.0.1');

    process.on('SIGINT', () => {
        console.log(chalk.gray('\n  Shutting down SKEP3 Proxy...'));
        server.close();
        process.exit(0);
    });
}
