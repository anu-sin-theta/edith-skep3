#!/usr/bin/env node
import { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
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

const program = new Command();

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(target: string, engine: string) {
    console.log(chalk.bold.hex('#00FFAA')(`
  ╔══════════════════════════════════════════════════════╗
  ║   🛡️  EDITH SKEP3  ·  Transaction Firewall         ║
  ║   Privacy-First · Local EVM · Advanced Analysis      ║
  ╠══════════════════════════════════════════════════════╣
  ║   Target : ${target.slice(0, 42).padEnd(42)}         ║
  ║   Brain  : ${engine.slice(0, 42).padEnd(42)}         ║
  ╚══════════════════════════════════════════════════════╝
`));
}

// ─── Verdict Renderer ─────────────────────────────────────────────────────────
function printVerdict(verdict: Verdict, reasoning: string, warnings: string[], engine: string) {
    const colors: Record<Verdict, ChalkInstance> = {
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
    .version('2.2.0')
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
  `)
    .argument('<target>', 'Transaction hash (66 chars) or contract address (42 chars)')
    .option('--method <sig>', 'Function signature, e.g. "claimAirdrop()"', 'fallback()')
    .option('--from <address>', 'Wallet to impersonate', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    .option('--value <wei>', 'ETH value to send in wei', '0')
    .option('--data <hex>', 'Raw calldata hex')
    .option('--rpc <url_or_alias>', 'Remote RPC URL or alias (e.g. "llamarpc")', DEFAULT_FORK_RPC)
    .option('--brain', 'Use cloud AI (Gemini / OpenAI / Mistral / Claude). Runs setup flow if no saved preference.')
    .option('--ollama', 'Force local Ollama AI (overrides saved brain preference)')
    .option('--model <name>', 'Override AI model name')
    .option('-v, --verbose', 'Show detailed execution trace logs in the console')
    .action(async (target: string, options) => {

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

        // ── Resolve RPC Provider ───────────────────────────────────────────
        let activeRpc = options.rpc;
        if (activeRpc.toLowerCase() === 'llamarpc') {
            activeRpc = 'https://eth.llamarpc.com';
        } else if (activeRpc.toLowerCase() === 'publicnode') {
            activeRpc = DEFAULT_FORK_RPC;
        }

        printBanner(target, engineLabel);

        const spinner = ora({ text: `Forking Ethereum Mainnet locally (${activeRpc.split('://')[1]})...`, color: 'cyan' }).start();
        let simulator = new AnvilSimulator(activeRpc);
        const parser = new TransactionParser();
        const auditor = new SecurityAuditor(aiMode, {
            ollamaModel: aiMode === 'ollama' ? brainModel : undefined,
            provider: aiMode === 'remote' ? brainProvider : undefined,
            apiKey: aiMode === 'remote' ? brainApiKey : undefined,
            remoteModel: aiMode === 'remote' ? brainModel : undefined,
        });

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

            let toAddress: Hex;
            let calldata: Hex | undefined;
            let contractCode: string | undefined;

            const explorer = new ContractExplorer(process.env.ETHERSCAN_API_KEY || '');

            if (target.length === 66) {
                spinner.start('Fetching original tx calldata from mainnet...');
                try {
                    const liveClient = createPublicClient({ chain: mainnet, transport: http(activeRpc) });
                    const origTx = await liveClient.getTransaction({ hash: target as Hex });
                    toAddress = origTx.to as Hex;
                    calldata = origTx.input as Hex;
                    spinner.succeed(`Original tx found → ${toAddress}`);
                } catch {
                    spinner.fail('Transaction not found on mainnet.');
                    await simulator.stop(); process.exit(1);
                }
            } else {
                toAddress = target as Hex;
                calldata = options.data as Hex | undefined;
                if (!calldata && options.method !== 'fallback()') {
                    const { keccak256, toBytes } = await import('viem');
                    const selector = keccak256(toBytes(options.method)).slice(0, 10);
                    calldata = selector as Hex;
                }
                const methodLabel = options.method === 'fallback()' ? '(Plain/Fallback)' : options.method;
                spinner.succeed(`Simulating → ${toAddress}  ${methodLabel}`);
            }

            // Fetch Contract Details (Etherscan / Decompilation)
            spinner.start('Scanning contract logic...');
            const contractInfo = await explorer.getContractInfo(toAddress, activeRpc);

            if (contractInfo.sourceCode) {
                // We found something (Verified source, Decompiled code, or a Threat Report)
                contractCode = contractInfo.sourceCode;
                if (contractInfo.isVerified) {
                    spinner.succeed(contractInfo.name?.includes('🚨')
                        ? chalk.redBright.bold(contractInfo.name)
                        : `Verified source found: ${contractInfo.name || 'Unknown'}`);
                } else {
                    spinner.succeed('Decompiled logic recovered.');
                }
            } else if (!contractInfo.bytecode || contractInfo.bytecode === '0x' || contractInfo.bytecode === '0x0') {
                spinner.warn(chalk.yellow(`Target contract not found on this chain.`));
                console.log(chalk.gray(`  (Wait! If this is BSC/Polygon/etc, use: --rpc <url>)\n`));
                contractCode = undefined;
            } else {
                spinner.info('Contract unverified. Attempting decompilation...');
                contractCode = await explorer.decompile(toAddress, contractInfo.bytecode);
                if (contractCode) {
                    spinner.succeed('Decompiled logic recovered.');
                } else {
                    spinner.warn('No readable code found. AI will audit raw trace only.');
                }
            }

            spinner.start('Executing transaction on local fork...');
            const simTxHash = await simulator.simulateTransaction({
                from: fromAddress, to: toAddress, data: calldata, value: BigInt(options.value),
            });
            spinner.succeed(chalk.cyan(`Simulated tx: ${simTxHash}`));

            spinner.start('Extracting EVM trace and state diff from local Anvil...');
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

            let expectedValue = BigInt(options.value || '0');

            if (realEthLoss > BigInt(0) && expectedValue === BigInt(0)) {
                traceWarns.push(`🚨 UNEXPECTED BALANCE DRAIN: Lost ${formatEther(realEthLoss)} ETH to contract (Gas excluded)!`);
            } else if (realEthLoss > expectedValue) {
                traceWarns.push(`🚨 UNEXPECTED BALANCE DRAIN: Lost ${formatEther(realEthLoss)} ETH (Only intended to send ${formatEther(expectedValue)} ETH)!`);
            }

            if (parsed.tokenLosses && parsed.tokenLosses.length > 0) {
                parsed.tokenLosses.forEach(loss => {
                    traceWarns.push(`🚨 UNEXPECTED ERC20 DRAIN: Lost ${loss.formatted} unit(s) of Token ${loss.tokenAddress}!`);
                });
            }

            const allWarnings = [...(parsed.warnings || []), ...traceWarns];
            spinner.succeed(`Trace & Diff done — ${(parsed.logs || []).length} events, ${stateChanges.length} state updates`);

            console.log(chalk.gray('\n[SIMULATION RESULT]'));
            console.log(`  Status   : ${parsed.status === 'success' ? chalk.green('SUCCESS') : chalk.red('REVERTED')}`);
            console.log(`  Gas Used : ${chalk.white(parsed.gasUsed)}`);
            if (parsed.logs?.length) {
                console.log(chalk.cyan('\n  [Events]'));
                parsed.logs.forEach(log => {
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
