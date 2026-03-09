#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import chalk, { type Chalk } from 'chalk';
import ora from 'ora';
import { AnvilSimulator, DEFAULT_FORK_RPC } from './simulator.js';
import { TransactionParser } from './parser.js';
import { SecurityAuditor, type Verdict } from './ai.js';
import {
    runBrainFlow,
    runOllamaFlow,
    runZeroSetupFlow,
    loadConfig,
    clearConfig,
    scanEnvironment,
    getOllamaStatus,
    PROVIDERS,
} from './brain.js';
import { confirm } from '@inquirer/prompts';
import { type Hex, formatEther } from 'viem';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { ContractExplorer } from './explorer.js';

const EVM_PUBLIC_RPCS = [
    'https://ethereum.publicnode.com',
    'https://base.publicnode.com',
    'https://arbitrum.publicnode.com',
    'https://optimism.publicnode.com',
    'https://bsc.publicnode.com',
    'https://polygon.publicnode.com',
];

async function autoDiscoverEvmRpc(targetStr: string): Promise<string | null> {
    if (targetStr.length === 66) {
        // Fast-ping all chains for tx hash
        const checks = EVM_PUBLIC_RPCS.map(async (rpc) => {
            try {
                const res = await fetch(rpc, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [targetStr] })
                });
                const data: any = await res.json();
                if (data.result) return rpc;
            } catch { }
            return null;
        });
        const results = await Promise.all(checks);
        return results.find(r => r !== null) || null;
    } else if (targetStr.length === 42) {
        // Try finding contract code (verified deploy) on chains
        const checks = EVM_PUBLIC_RPCS.map(async (rpc) => {
            try {
                const res = await fetch(rpc, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [targetStr, 'latest'] })
                });
                const data: any = await res.json();
                if (data.result && data.result !== '0x' && data.result !== '0x0') return rpc;
            } catch { }
            return null;
        });
        const results = await Promise.all(checks);
        return results.find(r => r !== null) || null;
    }
    return null;
}

const program = new Command();

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(target: string, engine: string) {
    console.log(chalk.bold.hex('#00FFAA')(`
  ╔══════════════════════════════════════════════════════╗
    🛡️  EDITH SKEP3  ·  Transaction Firewall        
    Privacy-First · Local EVM · Advanced Analysis      
  ╠══════════════════════════════════════════════════════╣
    Target : ${target.slice(0, 42).padEnd(42)}         
    Brain  : ${engine.slice(0, 42).padEnd(42)}         
  ╚══════════════════════════════════════════════════════╝
`));
}

// ─── Verdict Renderer ─────────────────────────────────────────────────────────
function printVerdict(verdict: Verdict, reasoning: string, warnings: string[], engine: string) {
    const colors: Record<Verdict, Chalk> = {
        SAFE: chalk.bold.greenBright,
        RISKY: chalk.bold.yellow,
        CRITICAL: chalk.bold.redBright,
    };
    const icons: Record<Verdict, string> = {
        SAFE: '✅',
        RISKY: '⚠️ ',
        CRITICAL: '🚨',
    };

    if (warnings.length > 0) {
        console.log('\n' + chalk.gray('─'.repeat(56)));
        console.log(chalk.yellow.bold('\n[PARSER WARNINGS]'));
        warnings.forEach(w => console.log(chalk.yellow(w)));
    }

    console.log('\n' + chalk.gray('─'.repeat(56)));
    console.log(chalk.cyan.bold(`\n[SECURITY AUDIT — ${engine}]`));
    console.log(chalk.white('\n' + reasoning));
    console.log('\n' + colors[verdict](`${icons[verdict]} VERDICT: ${verdict}`));
    console.log(chalk.gray('─'.repeat(56) + '\n'));

    if (verdict === 'CRITICAL') {
        console.log(chalk.bgRed.white.bold('  ██ DO NOT SIGN THIS TRANSACTION ██  '));
        console.log(chalk.red('  High probability of asset theft or drainer contract.\n'));
    } else if (verdict === 'RISKY') {
        console.log(chalk.bgYellow.black.bold('  ⚠  PROCEED WITH CAUTION  ⚠  '));
        console.log(chalk.yellow('  Review the details above before signing.\n'));
    } else {
        console.log(chalk.green('  Transaction simulation shows no obvious red flags.\n'));
    }
}

// ─── Splash (no-args) ────────────────────────────────────────────────────────
function printSplash() {
    console.log(chalk.hex('#00FFAA')([
        '',
        '  ███████╗██████╗ ██╗████████╗██╗  ██╗',
        '  ██╔════╝██╔══██╗██║╚══██╔══╝██║  ██║',
        '  █████╗  ██║  ██║██║   ██║   ███████║',
        '  ██╔══╝  ██║  ██║██║   ██║   ██╔══██║',
        '  ███████╗██████╔╝██║   ██║   ██║  ██║',
        '  ╚══════╝╚═════╝ ╚═╝   ╚═╝   ╚═╝  ╚═╝',
        '',
    ].join('\n')));

    console.log(chalk.hex('#00CC88')([
        '  ███████╗██╗  ██╗███████╗██████╗ ██████╗ ',
        '  ██╔════╝██║ ██╔╝██╔════╝██╔══██╗╚════██╗',
        '  ███████╗█████╔╝ █████╗  ██████╔╝ █████╔╝',
        '  ╚════██║██╔═██╗ ██╔══╝  ██╔═══╝  ╚═══██╗',
        '  ███████║██║  ██╗███████╗██║     ██████╔╝',
        '  ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═════╝ ',
        '',
    ].join('\n')));

    console.log(chalk.gray('  Privacy-First  ·  Local EVM Fork  ·  Advanced Security Analysis'));
    console.log(chalk.gray('                                v2.4 | anubhav singh | https://anufied.me\n'));

    console.log(chalk.white('  USAGE\n'));
    console.log(chalk.cyan('    edith scan') + chalk.gray(' <contract|txhash>   ') + chalk.white('Simulate and audit a transaction'));
    console.log(chalk.cyan('    edith brain') + chalk.gray('                     ') + chalk.white('Configure AI provider (Gemini, OpenAI, Mistral, Claude)'));
    console.log(chalk.cyan('    edith test-ai') + chalk.gray('                   ') + chalk.white('Verify AI connection with a mock scan'));
    console.log(chalk.cyan('    edith --help') + chalk.gray('                    ') + chalk.white('Show full help\n'));

    console.log(chalk.white('  EXAMPLES\n'));
    console.log(chalk.gray('    edith scan 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --method "approve(address,uint256)"'));
    console.log(chalk.gray('    edith scan 0xTxHash --brain'));
    console.log(chalk.gray('    edith brain --status\n'));
}

// ─── CLI Setup ────────────────────────────────────────────────────────────────
program
    .name('edith')
    .description('Edith Sentinel — AI-Powered Web3 Transaction Firewall')
    .version(version)
    .action(() => {
        // No subcommand given — show splash instead of error
        printSplash();
    });

// ════════════════════════════════════════════════════════════════════════════════
// COMMAND: edith scan
// ════════════════════════════════════════════════════════════════════════════════
program
    .command('scan')
    .summary('Simulate and audit a transaction before signing')
    .description(`
  Simulate a transaction in a local Ethereum fork and get an AI security verdict.

  EXAMPLES:
    edith scan 0xContractAddress --method "claimAirdrop()"
    edith scan 0xTxHash
    edith scan 0xContract --brain            (use cloud AI)
    edith scan 0xContract --ollama           (force local Ollama)
    edith scan 0xContract --brain --rpc https://your-rpc.com
    edith scan "base58string..." --solana    (Simulate Solana tx)
  `)
    .argument('[target]', 'Transaction hash/address (ETH) or Base58 encoded tx (Solana)')
    .option('--method <sig>', 'Function signature, e.g. "claimAirdrop()"', 'fallback()')
    .option('--from <address>', 'Wallet to impersonate', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    .option('--value <wei>', 'ETH value to send in wei', '0')
    .option('--data <hex>', 'Raw calldata hex')
    .option('--rpc <url_or_alias>', 'Remote RPC URL or alias (e.g. "llamarpc")', DEFAULT_FORK_RPC)
    .option('--brain', 'Use cloud AI (Gemini / OpenAI / Mistral / Claude). Runs setup flow if no saved preference.')
    .option('--ollama', 'Force local Ollama AI (overrides saved brain preference)')
    .option('--model <name>', 'Override AI model name')
    .option('-v, --verbose', 'Show detailed execution trace logs in the console')
    .option('--solana', 'Switch context to target Solana (base58 serialized tx)')
    .option('--skip-time <seconds>', 'Advance EVM time before simulation', '0')
    .option('--skip-blocks <blocks>', 'Advance EVM block number before simulation', '0')
    .option('--bundle <file>', 'Simulate multiple sequential transactions from a JSON file (fixes single-tx myopia)')
    .action(async (target: string | undefined, options) => {

        // ── Resolve AI mode ────────────────────────────────────────────────
        let aiMode: 'ollama' | 'remote' = 'ollama';
        let brainProvider: any = null;
        let brainApiKey: string = '';
        let brainModel: string = options.model || '';

        if (options.ollama) {
            // Discover installed Ollama models, let user pick
            const picked = await runOllamaFlow(chalk);
            if (!picked) {
                const fallback = await runZeroSetupFlow(chalk);
                if (fallback.mode === 'ollama') { aiMode = 'ollama'; brainModel = fallback.model; }
                else if (fallback.mode === 'remote') { aiMode = 'remote'; brainProvider = fallback.provider; brainApiKey = fallback.apiKey; brainModel = fallback.model; }
                else { console.log(chalk.yellow('  Proceeding without AI. Parser warnings only.\n')); }
            } else {
                aiMode = 'ollama';
                brainModel = options.model || picked.model;
            }
        } else if (options.brain) {
            // Check for saved preference first
            const saved = loadConfig();
            if (saved && !options.model) {
                const provider = PROVIDERS[saved.provider];
                const apiKey = process.env[provider?.envKey || ''];

                if (provider && apiKey) {
                    aiMode = 'remote';
                    brainProvider = provider;
                    brainApiKey = apiKey;
                    brainModel = saved.model;
                    console.log(chalk.gray(`  Using saved brain: ${provider.label} → ${saved.model}\n  (run 'edith brain' to change)\n`));
                } else {
                    // Saved provider but key missing — re-run setup
                    console.log(chalk.yellow(`  ⚠ Saved provider key not found in env. Re-running brain setup...\n`));
                    const result = await runBrainFlow(chalk);
                    aiMode = 'remote';
                    brainProvider = PROVIDERS[result.provider];
                    brainApiKey = result.apiKey;
                    brainModel = result.model;
                }
            } else {
                // No saved preference — run interactive setup
                const result = await runBrainFlow(chalk);
                aiMode = 'remote';
                brainProvider = PROVIDERS[result.provider];
                brainApiKey = result.apiKey;
                brainModel = result.model;
            }
        } else {
            // No flag — check saved config, else auto-detect
            const saved = loadConfig();
            if (saved) {
                if (saved.provider === 'ollama') {
                    const status = await getOllamaStatus();
                    if (status.running && status.models.includes(saved.model)) {
                        aiMode = 'ollama'; brainModel = options.model || saved.model;
                        console.log(chalk.gray(`  Using saved brain: Ollama → ${brainModel}\n`));
                    } else {
                        console.log(chalk.yellow(`  Saved Ollama model '${saved.model}' not found. Re-picking...\n`));
                        const picked = await runOllamaFlow(chalk);
                        if (picked) { aiMode = 'ollama'; brainModel = picked.model; }
                    }
                } else {
                    const provider = PROVIDERS[saved.provider];
                    const apiKey = process.env[provider?.envKey || ''];
                    if (provider && apiKey) {
                        aiMode = 'remote'; brainProvider = provider;
                        brainApiKey = apiKey; brainModel = options.model || saved.model;
                        console.log(chalk.gray(`  Using saved brain: ${provider.label} → ${brainModel}\n`));
                    } else {
                        console.log(chalk.yellow(`  Saved provider key missing. Re-running setup...\n`));
                        const result = await runBrainFlow(chalk);
                        aiMode = 'remote'; brainProvider = PROVIDERS[result.provider];
                        brainApiKey = result.apiKey; brainModel = result.model;
                    }
                }
            } else {
                // Nothing saved — try Ollama first (privacy-first default)
                const ollamaStatus = await getOllamaStatus();
                if (ollamaStatus.running && ollamaStatus.models.length > 0) {
                    aiMode = 'ollama';
                    brainModel = options.model || ollamaStatus.models[0];
                    console.log(chalk.gray(`  Auto-selected: Ollama → ${brainModel}  (use --ollama to pick a different model)\n`));
                } else {
                    // Nothing configured at all — zero-setup flow
                    const fallback = await runZeroSetupFlow(chalk);
                    if (fallback.mode === 'ollama') { aiMode = 'ollama'; brainModel = fallback.model; }
                    else if (fallback.mode === 'remote') { aiMode = 'remote'; brainProvider = fallback.provider; brainApiKey = fallback.apiKey; brainModel = fallback.model; }
                    else { console.log(chalk.yellow('  Proceeding without AI. Parser warnings only.\n')); }
                }
            }
        }   // ── end flag resolution ────────────────────────────────────────

        const engineLabel = aiMode === 'remote'
            ? `${brainProvider.label} → ${brainModel}`
            : `Ollama → ${brainModel}`;

        let isSolana = options.solana === true;

        if (target && !target.startsWith('0x') && target.length > 50) {
            isSolana = true; // Auto-detect Base58/Base64 Solana payload
        }

        let activeRpc = options.rpc;
        let chainDetectedLabel = '';

        if (isSolana && activeRpc === DEFAULT_FORK_RPC) {
            activeRpc = 'https://api.mainnet-beta.solana.com';
        } else if (activeRpc.toLowerCase() === 'llamarpc') {
            activeRpc = 'https://eth.llamarpc.com';
        } else if (activeRpc === DEFAULT_FORK_RPC && target && !isSolana) {
            // Attempt auto chain discovery for EVM 
            const spinner = ora({ text: 'Auto-discovering EVM chain...', color: 'cyan' }).start();
            const discoveredRpc = await autoDiscoverEvmRpc(target);
            if (discoveredRpc) {
                activeRpc = discoveredRpc;
                const domain = new URL(activeRpc).hostname;
                chainDetectedLabel = chalk.green(` (Auto-detected: ${domain})`);
                spinner.succeed(`Located target on ${domain}`);
            } else {
                activeRpc = DEFAULT_FORK_RPC;
                spinner.stop();
            }
        }

        printBanner(target || 'Bundle Simulation', engineLabel);

        let simulator = new AnvilSimulator(activeRpc);
        const parser = new TransactionParser();
        const auditor = new SecurityAuditor(aiMode, {
            ollamaModel: aiMode === 'ollama' ? brainModel : undefined,
            provider: aiMode === 'remote' ? brainProvider : undefined,
            apiKey: aiMode === 'remote' ? brainApiKey : undefined,
            remoteModel: aiMode === 'remote' ? brainModel : undefined,
        });

        if (isSolana && target) {
            const spinner = ora({ text: `Simulating Solana transaction remotely via ${activeRpc.split('://')[1]}...`, color: 'cyan' }).start();
            try {
                const solResult = await simulator.simulateSolanaTransaction(target, activeRpc);
                spinner.succeed(solResult.err ? chalk.red(`Solana transaction will FAIL!`) : chalk.greenBright(`Solana transaction simulated successfully!`));

                const simLogs = solResult.logs || [];
                const solUnitsConsumed = solResult.unitsConsumed ? solResult.unitsConsumed : 0;

                console.log(chalk.gray('\n[SOLANA SIMULATION RESULT]'));
                console.log(`  Status   : ${solResult.err ? chalk.red(JSON.stringify(solResult.err)) : chalk.green('SUCCESS')}`);
                console.log(`  Compute  : ${chalk.white(solUnitsConsumed)} CUs`);

                let reportBuilder = `=== SOLANA SIMULATION REPORT ===\nEngine: Solana\nStatus: ${solResult.err ? 'REVERTED' : 'SUCCESS'}\nCompute: ${solUnitsConsumed}\n\n=== EMITTED LOGS ===\n`;
                if (simLogs.length) {
                    console.log(chalk.cyan('\n  [Detailed Logs]'));
                    simLogs.forEach((l: string) => {
                        console.log(chalk.gray(`    • ${l}`));
                        reportBuilder += `- ${l}\n`;
                    });
                } else {
                    reportBuilder += "No logs emitted.\n";
                }

                spinner.start(`Analyzing Solana logs with ${engineLabel}...`);
                const auditResult = await auditor.audit(reportBuilder);
                spinner.stop();
                printVerdict(auditResult.verdict, auditResult.reasoning, [], auditResult.engine);
                process.exit(0);
            } catch (e: any) {
                spinner.fail(`Failed to simulate Solana tx: ${e.message}`);
                process.exit(1);
            }
        }

        const spinner = ora({ text: `Forking Ethereum Mainnet locally (${activeRpc.split('://')[1]})...`, color: 'cyan' }).start();

        try {
            try {
                await simulator.startFork();
            } catch (err: any) {
                spinner.stop();
                if (activeRpc.includes('llamarpc')) {
                    console.log(chalk.red(`\n  ✖ LlamaRPC Node Failed: ${err.message}`));
                    const doFallback = await confirm({
                        message: '  Would you like to fall back to the default Public Node?',
                        default: true,
                    });

                    if (doFallback) {
                        activeRpc = DEFAULT_FORK_RPC;
                        simulator = new AnvilSimulator(activeRpc);
                        spinner.start(`Forking Ethereum Mainnet locally (${activeRpc.split('://')[1]})...`);
                        await simulator.startFork();
                    } else {
                        process.exit(1);
                    }
                } else {
                    throw err;
                }
            }

            const forkBlock = await simulator.getClient().getBlockNumber();
            spinner.succeed(chalk.greenBright(`Mainnet forked at block #${forkBlock}`));

            spinner.start('Preparing wallet impersonation...');
            const fromAddress = options.from as Hex;
            await simulator.impersonateAccount(fromAddress);
            await simulator.setBalance(fromAddress);
            spinner.succeed(`Impersonating: ${fromAddress}`);

            const explorer = new ContractExplorer(process.env.ETHERSCAN_API_KEY || '');
            const fs = await import('fs');

            let txsToRun: any[] = [];

            if (options.bundle) {
                let bundleStr = options.bundle;
                if (fs.existsSync(bundleStr)) {
                    bundleStr = fs.readFileSync(bundleStr, 'utf-8');
                }
                txsToRun = JSON.parse(bundleStr);
            } else if (target) {
                txsToRun = [{ target, method: options.method, data: options.data, value: options.value, skipTime: options.skipTime, skipBlocks: options.skipBlocks }];
            } else {
                throw new Error("Must specify [target] or --bundle");
            }

            // Resolve final target for contract logic scanning
            const lastTx = txsToRun[txsToRun.length - 1];
            let finalTargetAddr = (lastTx.target || lastTx.to) as string;
            if (finalTargetAddr && finalTargetAddr.length === 66) {
                spinner.start('Scanning mainnet for final target tx...');
                try {
                    const liveClient = createPublicClient({ chain: mainnet, transport: http(activeRpc) });
                    const origTx = await liveClient.getTransaction({ hash: finalTargetAddr as Hex });
                    finalTargetAddr = origTx.to as string;
                    spinner.succeed(`Target resolved to ${finalTargetAddr || 'Contract Creation'}`);
                } catch (e) {
                    spinner.succeed(`Could not fetch mainnet tx hash for final target.`);
                }
            }

            let contractCode: string | undefined;
            spinner.start('Scanning contract logic...');
            const contractInfo = finalTargetAddr ? await explorer.getContractInfo(finalTargetAddr as Hex, activeRpc) : { isVerified: false, bytecode: '0x', name: undefined, sourceCode: null };

            if (contractInfo.sourceCode) {
                contractCode = contractInfo.sourceCode;
                if (contractInfo.isVerified) {
                    spinner.succeed(contractInfo.name?.includes('🚨') ? chalk.redBright.bold(contractInfo.name) : `Verified source found: ${contractInfo.name || 'Unknown'}`);
                } else {
                    spinner.succeed('Decompiled logic recovered.');
                }
            } else if (!contractInfo.bytecode || contractInfo.bytecode === '0x' || contractInfo.bytecode === '0x0') {
                spinner.warn(chalk.yellow(`Target contract not found on this chain.`));
                contractCode = undefined;
            } else {
                spinner.info('Contract unverified. Attempting decompilation...');
                contractCode = finalTargetAddr ? await explorer.decompile(finalTargetAddr as Hex, contractInfo.bytecode) : undefined;
                if (contractCode) spinner.succeed('Decompiled logic recovered.');
                else spinner.warn('No readable code found. AI will audit raw trace only.');
            }

            spinner.start(`Executing simulation sequence (${txsToRun.length} txs) on local fork...`);

            let finalParsed: any = null;
            let finalTrace: any = null;
            let bundleWarnings: string[] = [];

            for (let i = 0; i < txsToRun.length; i++) {
                const txConf = txsToRun[i];
                let txTo: Hex | null = null;
                let txData: Hex | undefined = txConf.data as Hex;
                const tgt = txConf.target || txConf.to;

                if (tgt && tgt.length === 66) {
                    const liveClient = createPublicClient({ chain: mainnet, transport: http(activeRpc) });
                    const origTx = await liveClient.getTransaction({ hash: tgt as Hex });
                    txTo = origTx.to as Hex | null;
                    if (!txData) txData = origTx.input as Hex;
                } else if (tgt && tgt.length === 42) {
                    txTo = tgt as Hex;
                    if (!txData && txConf.method && txConf.method !== 'fallback()') {
                        const { keccak256, toBytes } = await import('viem');
                        const selector = keccak256(toBytes(txConf.method)).slice(0, 10);
                        txData = selector as Hex;
                    }
                }

                if (txConf.skipTime && Number(txConf.skipTime) > 0) {
                    spinner.text = `Advancing time by ${txConf.skipTime}s...`;
                    await simulator.advanceTime(Number(txConf.skipTime));
                }
                if (txConf.skipBlocks && Number(txConf.skipBlocks) > 0) {
                    spinner.text = `Advancing blocks by ${txConf.skipBlocks}...`;
                    await simulator.advanceBlocks(Number(txConf.skipBlocks));
                }

                spinner.text = `Executing transaction ${i + 1}/${txsToRun.length}...`;
                const simTxHash = await simulator.simulateTransaction({
                    from: fromAddress, to: txTo, data: txData, value: BigInt(txConf.value || '0'),
                });

                const parsed = await parser.parseReceipt(simTxHash);
                const rawTrace = await simulator.traceTransaction(simTxHash);
                const trace = await parser.parseTrace(rawTrace);
                const rawStateDiff = await simulator.traceStateDiff(simTxHash);
                const { stateChanges, balanceLoss } = parser.parseStateDiff(rawStateDiff, fromAddress);

                parsed.stateChanges = stateChanges;
                parsed.balanceLoss = balanceLoss;

                const traceWarns = trace?.suspiciousOps.map(op => `🔴 Suspicious opcode: ${op}`) || [];
                let realEthLoss = (balanceLoss?.amount || BigInt(0)) - (parsed.gasFee || BigInt(0));
                if (realEthLoss < BigInt(0)) realEthLoss = BigInt(0);

                let expectedValue = BigInt(txConf.value || '0');
                if (realEthLoss > BigInt(0) && expectedValue === BigInt(0)) {
                    traceWarns.push(`🚨 UNEXPECTED BALANCE DRAIN (Step ${i + 1}): Lost ${formatEther(realEthLoss)} ETH!`);
                } else if (realEthLoss > expectedValue) {
                    traceWarns.push(`🚨 UNEXPECTED BALANCE DRAIN (Step ${i + 1}): Lost ${formatEther(realEthLoss)} ETH!`);
                }

                if (parsed.tokenLosses && parsed.tokenLosses.length > 0) {
                    parsed.tokenLosses.forEach(loss => {
                        traceWarns.push(`🚨 UNEXPECTED ERC20/NFT DRAIN (Step ${i + 1}): Lost ${loss.formatted} of ${loss.tokenAddress}!`);
                    });
                }

                bundleWarnings = bundleWarnings.concat(parsed.warnings || []);
                bundleWarnings = bundleWarnings.concat(traceWarns);

                if (i === txsToRun.length - 1) {
                    finalParsed = parsed;
                    finalTrace = trace;
                    spinner.succeed(`Simulated ${txsToRun.length} tx(s). Final tx: ${simTxHash}`);
                }
            }

            const allWarnings = bundleWarnings;
            const parsed = finalParsed;
            const trace = finalTrace;
            const stateChanges = parsed.stateChanges || [];
            spinner.succeed(`Trace & Diff done — ${(parsed.logs || []).length} events, ${stateChanges.length} state updates`);

            console.log(chalk.gray('\n[SIMULATION RESULT]'));
            console.log(`  Status   : ${parsed.status === 'success' ? chalk.green('SUCCESS') : chalk.red('REVERTED')}`);
            console.log(`  Gas Used : ${chalk.white(parsed.gasUsed)}`);
            if (parsed?.logs?.length) {
                console.log(chalk.cyan('\n  [Events]'));
                parsed.logs.forEach((log: any) => {
                    console.log(chalk.gray(`    • ${log.eventName} @ ${log.address}`));
                    if (log.decoded) Object.entries(log.decoded).forEach(([k, v]) =>
                        console.log(chalk.gray(`      ${k}: ${v}`)));
                });
            }

            if (options.verbose) {
                console.log(chalk.cyan('\n  [Detailed Call Trace]'));
                console.log(chalk.gray(JSON.stringify(trace, null, 2)));

                if (parsed.stateChanges?.length) {
                    console.log(chalk.cyan('\n  [State Diffs]'));
                    console.log(chalk.gray(JSON.stringify(parsed.stateChanges, null, 2)));
                }
            }

            spinner.start(`Analyzing trace with ${engineLabel}...`);
            const report = parser.formatForAI(parsed, trace, contractCode);
            const auditResult = await auditor.audit(report);
            spinner.stop();

            printVerdict(auditResult.verdict, auditResult.reasoning, allWarnings, auditResult.engine);

        } catch (error: any) {
            spinner.fail(chalk.red('Fatal Error'));
            console.error(chalk.red(error.message));
        } finally {
            await simulator.stop();
            process.exit(0);
        }
    });  // end .action()

// ════════════════════════════════════════════════════════════════════════════════
// COMMAND: edith brain
// ════════════════════════════════════════════════════════════════════════════════
program
    .command('brain')
    .summary('Configure remote AI provider and model')
    .description(`
  Interactively select a cloud AI provider and model for security analysis.
  Scans your environment for API keys and lets you pick from available models.

  PROVIDERS SUPPORTED:
    Google Gemini   →  GEMINI_API_KEY
    OpenAI          →  OPENAI_API_KEY
    Mistral         →  MISTRAL_API_KEY
    Anthropic Claude →  ANTHROPIC_API_KEY

  EXAMPLES:
    edith brain               (setup or change provider)
    edith brain --status      (show current config)
    edith brain --reset       (clear saved preference)
  `)
    .option('--status', 'Show current saved brain configuration')
    .option('--reset', 'Clear saved brain preference (revert to Ollama)')
    .action(async (options) => {

        if (options.status) {
            const config = loadConfig();
            const detected = scanEnvironment();

            console.log(chalk.bold.hex('#00FFAA')('\n  EDITH BRAIN — Status\n'));

            if (config) {
                const provider = PROVIDERS[config.provider];
                const keyFound = !!process.env[provider?.envKey || ''];
                console.log(chalk.white(`  Saved Provider : ${provider?.label || config.provider}`));
                console.log(chalk.white(`  Saved Model    : ${config.model}`));
                console.log(keyFound
                    ? chalk.green(`  API Key        : [set]  ${provider?.envKey}`)
                    : chalk.red(`  API Key        : [!!!]  ${provider?.envKey} NOT found in environment`));
            } else {
                console.log(chalk.gray('  No saved preference. Currently using Ollama (local).\n'));
                console.log(chalk.gray('  Run `edith brain` or use `--brain` flag on scan to configure.\n'));
            }

            console.log(chalk.cyan('\n  Available API Keys in Environment:\n'));
            Object.values(PROVIDERS).forEach(p => {
                const key = process.env[p.envKey];
                key
                    ? console.log(chalk.green(`    [set]  ${p.label.padEnd(20)} ${p.envKey}`))
                    : console.log(chalk.gray(`    [---]  ${p.label.padEnd(20)} ${p.envKey}`));
            });

            const ethKey = process.env.ETHERSCAN_API_KEY;
            ethKey
                ? console.log(chalk.green(`    [set]  Etherscan            ETHERSCAN_API_KEY`))
                : console.log(chalk.gray(`    [---]  Etherscan            ETHERSCAN_API_KEY`));

            console.log('');
            return;
        }

        if (options.reset) {
            clearConfig();
            console.log(chalk.green('\n  [OK] Brain preference cleared. Will use Ollama by default.\n'));
            return;
        }

        // Full interactive setup
        await runBrainFlow(chalk);
    });

// ════════════════════════════════════════════════════════════════════════════════
// COMMAND: edith test-ai
// ════════════════════════════════════════════════════════════════════════════════
program
    .command('test-ai')
    .summary('Test AI connection with a mock malicious transaction')
    .option('--brain', 'Test using cloud AI instead of Ollama')
    .option('--ollama', 'Force local Ollama')
    .action(async (options) => {
        console.log(chalk.cyan('\n  Testing AI connection with mock drainer transaction...\n'));

        let auditor: SecurityAuditor;
        let label: string;

        if (options.brain) {
            const result = await runBrainFlow(chalk);
            auditor = new SecurityAuditor('remote', {
                provider: PROVIDERS[result.provider],
                apiKey: result.apiKey,
                remoteModel: result.model,
            });
            label = `${PROVIDERS[result.provider].label} → ${result.model}`;
        } else {
            auditor = new SecurityAuditor('ollama');
            label = 'Ollama → qwen3:4b-instruct';
        }

        const mockReport = `
=== TRANSACTION SIMULATION REPORT ===
From: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
To:   0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
Value: 0.0 ETH  |  Status: SUCCESS  |  Gas: 46000

=== EMITTED EVENTS ===
  - Approval(address,address,uint256) on 0xA0b86991...USDC
    Decoded: { owner: "0xYourWallet", spender: "0xDeadbeef...Drainer", amount: "INFINITE (Max Uint256)" }

=== CALL TRACE ===
{"type":"CALL","to":"0xA0b86991...","suspiciousOps":["DELEGATECALL to 0xUnknownImpl"],"numSubCalls":1}

=== PRE-DETECTED WARNINGS ===
⚠️  INFINITE APPROVAL granted to 0xDeadbeef...Drainer for USDC
🔴  Suspicious opcode: DELEGATECALL to 0xUnknownImpl
        `.trim();

        const spinner = ora(`Querying ${label}...`).start();
        const result = await auditor.audit(mockReport);
        spinner.stop();

        console.log(chalk.yellow('\n  Verdict :'), chalk.bold(result.verdict));
        console.log(chalk.white('  Reason  :'), result.reasoning);
        console.log(chalk.gray('  Engine  :'), result.engine);
        console.log('');
    });

program.parse();
