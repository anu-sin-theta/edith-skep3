#!/usr/bin/env node
import { Command } from 'commander';
import chalk, { type ChalkInstance } from 'chalk';
import ora from 'ora';
import { AnvilSimulator, DEFAULT_FORK_RPC } from './simulator.js';
import { TransactionParser } from './parser.js';
import { SecurityAuditor, type Verdict } from './ai.js';
import { type Hex } from 'viem';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

const program = new Command();

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(target: string) {
    console.log(chalk.bold.hex('#00FFAA')(`
  ╔══════════════════════════════════════════════════════╗
  ║   🛡️  EDITH SENTINEL  ·  Transaction Firewall        ║
  ║   Privacy-First · Local AI · No Data Leaves Machine  ║
  ╠══════════════════════════════════════════════════════╣
  ║   Target : ${target.slice(0, 42).padEnd(42)} ║
  ║   Fork   : Ethereum Mainnet (via LlamaRPC)           ║
  ║   Engine : Anvil + Ollama (100% Local)               ║
  ╚══════════════════════════════════════════════════════╝
`));
}

// ─── Verdict Renderer ─────────────────────────────────────────────────────────
function printVerdict(verdict: Verdict, reasoning: string, warnings: string[]) {
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

    console.log('\n' + chalk.gray('─'.repeat(56)));

    if (warnings.length > 0) {
        console.log(chalk.yellow.bold('\n[PARSER WARNINGS]'));
        warnings.forEach(w => console.log(chalk.yellow(w)));
    }

    console.log(chalk.gray('\n─'.repeat(56)));
    console.log(chalk.cyan.bold('\n[🤖 AI SECURITY AUDIT — EDITH ANALYSIS]'));
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

// ─── Main scan command ────────────────────────────────────────────────────────
program
    .name('edith')
    .description('Edith Sentinel — AI-Powered Web3 Transaction Firewall')
    .version('2.0.0');

program
    .command('scan')
    .argument('<target>', 'Transaction hash (0x, 66 chars) or contract address (0x, 42 chars)')
    .option('--method <sig>', 'Function signature to simulate, e.g. "claimAirdrop()"', 'fallback()')
    .option('--from <address>', 'Wallet address to impersonate', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    .option('--value <wei>', 'ETH value to send in wei', '0')
    .option('--data <hex>', 'Raw calldata hex to send')
    .option('--rpc <url>', 'Remote RPC for mainnet fork (free public RPC used by default)', DEFAULT_FORK_RPC)
    .action(async (target: string, options) => {

        printBanner(target);

        const spinner = ora({ text: 'Forking Ethereum Mainnet locally...', color: 'cyan' }).start();
        const simulator = new AnvilSimulator(options.rpc);
        const parser = new TransactionParser();
        const auditor = new SecurityAuditor();

        try {
            // ── Step 1: Fork mainnet ──────────────────────────────────────────
            await simulator.startFork();

            const liveClient = createPublicClient({ chain: mainnet, transport: http(options.rpc) });
            const forkBlock = await simulator.getClient().getBlockNumber();
            spinner.succeed(chalk.greenBright(`Mainnet forked at block #${forkBlock} — Anvil running on localhost:8545`));

            // ── Step 2: Set up the simulation parameters ──────────────────────
            spinner.start('Preparing wallet impersonation...');

            const fromAddress = options.from as Hex;
            await simulator.impersonateAccount(fromAddress);
            await simulator.setBalance(fromAddress);  // Give gas money

            spinner.succeed(`Impersonating wallet: ${fromAddress}`);

            // ── Step 3: Build transaction ────────────────────────────────────
            let toAddress: Hex;
            let calldata: Hex | undefined;

            if (target.length === 66) {
                // It's a tx hash — fetch original tx calldata and replay it
                spinner.start('Fetching original transaction calldata from mainnet...');
                try {
                    const origTx = await liveClient.getTransaction({ hash: target as Hex });
                    toAddress = origTx.to as Hex;
                    calldata = origTx.input as Hex;
                    spinner.succeed(`Original tx found → To: ${toAddress}`);
                } catch {
                    spinner.fail('Transaction not found on mainnet.');
                    console.log(chalk.yellow('Tip: Make sure the tx hash exists on Ethereum mainnet.'));
                    await simulator.stop();
                    process.exit(1);
                }
            } else {
                // It's a contract address → simulate a method call
                toAddress = target as Hex;
                calldata = options.data as Hex | undefined;
                // If no raw data, encode the method signature minimally
                if (!calldata && options.method !== 'fallback()') {
                    // Simple 4-byte selector encoding
                    const { keccak256, toBytes, toHex } = await import('viem');
                    const selector = keccak256(toBytes(options.method)).slice(0, 10);
                    calldata = selector as Hex;
                }
                spinner.succeed(`Simulating call to ${toAddress} → ${options.method}`);
            }

            // ── Step 4: Simulate the transaction on local Anvil ───────────────
            spinner.start('Simulating transaction on local fork (this is sandboxed — nothing real happens)...');
            const simTxHash = await simulator.simulateTransaction({
                from: fromAddress,
                to: toAddress,
                data: calldata,
                value: BigInt(options.value),
            });
            spinner.succeed(chalk.cyan(`Simulation complete → Local tx: ${simTxHash}`));

            // ── Step 5: Get receipt + trace from LOCAL Anvil ──────────────────
            spinner.start('Extracting trace from local Anvil node...');
            const parsed = await parser.parseReceipt(simTxHash);
            const rawTrace = await simulator.traceTransaction(simTxHash);
            const trace = parser.parseTrace(rawTrace);

            // Merge trace suspicious ops into warnings
            const traceWarnings = trace?.suspiciousOps.map(op => `🔴 Suspicious opcode: ${op}`) || [];
            const allWarnings = [...(parsed.warnings || []), ...traceWarnings];

            spinner.succeed(`Trace extracted — ${(parsed.logs || []).length} events, ${trace?.calls?.length || 0} sub-calls`);

            // Print raw summary
            console.log(chalk.gray('\n[SIMULATION RESULT]'));
            console.log(chalk.white(`  Status   : ${parsed.status === 'success' ? chalk.green('SUCCESS') : chalk.red('REVERTED')}`));
            console.log(chalk.white(`  Gas Used : ${parsed.gasUsed}`));
            console.log(chalk.white(`  Events   : ${(parsed.logs || []).length}`));

            if (parsed.logs && parsed.logs.length > 0) {
                console.log(chalk.cyan('\n  [Events]'));
                parsed.logs.forEach(log => {
                    console.log(chalk.gray(`    • ${log.eventName} @ ${log.address}`));
                    if (log.decoded) {
                        Object.entries(log.decoded).forEach(([k, v]) => {
                            console.log(chalk.gray(`      ${k}: ${v}`));
                        });
                    }
                });
            }

            // ── Step 6: AI Analysis ───────────────────────────────────────────
            spinner.start('Sending trace to EDITH AI (local Ollama — private, no cloud)...');
            const report = parser.formatForAI(parsed, trace);
            const auditResult = await auditor.audit(report);
            spinner.stop();

            // ── Step 7: Print verdict ─────────────────────────────────────────
            printVerdict(auditResult.verdict, auditResult.reasoning, allWarnings);

        } catch (error: any) {
            spinner.fail(chalk.red('Fatal Error'));
            console.error(chalk.red('\n' + error.message));
            console.log(chalk.gray('\nStack: '), chalk.gray(error.stack?.split('\n').slice(0, 4).join('\n')));
        } finally {
            await simulator.stop();
            process.exit(0);
        }
    });

// ─── Quick test command (no RPC needed) ─────────────────────────────────────
program
    .command('test-ai')
    .description('Test the AI auditor without a real simulation')
    .action(async () => {
        console.log(chalk.cyan('Testing Ollama connection + AI auditor...\n'));
        const auditor = new SecurityAuditor();
        const mockReport = `
=== TRANSACTION SIMULATION REPORT ===
From: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
To:   0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
Value: 0.0 ETH
Status: SUCCESS
Gas Used: 46000

=== EMITTED EVENTS (Logs) ===
  - Event: Approval(address,address,uint256) on 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
    Decoded: {"owner":"0xf39...","spender":"0xdeadbeef...","amount":"INFINITE (Max Uint256)"}

=== CALL TRACE ===
{"type":"CALL","to":"0xA0b86991...","suspiciousOps":[],"numSubCalls":0}

=== PRE-DETECTED WARNINGS ===
⚠️  INFINITE APPROVAL granted to 0xdeadbeef... for token 0xA0b86991...
        `.trim();

        const spinner = ora('Querying local Ollama...').start();
        const result = await auditor.audit(mockReport);
        spinner.stop();

        console.log(chalk.yellow('Verdict:'), chalk.bold(result.verdict));
        console.log(chalk.white('Reason:'), result.reasoning);
    });

program.parse();
