import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { select, confirm } from '@inquirer/prompts';

// ─── Provider Definitions ────────────────────────────────────────────────────

export interface Provider {
    name: string;
    label: string;
    envKey: string;
    baseURL: string;
    supportsModelList: boolean;
    fallbackModels: string[];
    extraHeaders?: Record<string, string>;
}

export const PROVIDERS: Record<string, Provider> = {
    gemini: {
        name: 'gemini',
        label: 'Google Gemini',
        envKey: 'GEMINI_API_KEY',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        supportsModelList: true,
        fallbackModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    },
    openai: {
        name: 'openai',
        label: 'OpenAI',
        envKey: 'OPENAI_API_KEY',
        baseURL: 'https://api.openai.com/v1',
        supportsModelList: true,
        fallbackModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    },
    mistral: {
        name: 'mistral',
        label: 'Mistral',
        envKey: 'MISTRAL_API_KEY',
        baseURL: 'https://api.mistral.ai/v1',
        supportsModelList: true,
        fallbackModels: ['mistral-large-latest', 'mistral-medium', 'mistral-small-latest'],
    },
    claude: {
        name: 'claude',
        label: 'Anthropic Claude',
        envKey: 'ANTHROPIC_API_KEY',
        baseURL: 'https://api.anthropic.com/v1',
        supportsModelList: false,
        fallbackModels: [
            'claude-opus-4-5',
            'claude-sonnet-4-5',
            'claude-3-5-haiku-20241022',
            'claude-3-5-sonnet-20241022',
        ],
        extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
};

// ─── Config Persistence ──────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.config', 'edith-sentinel', 'brain.json');

export interface BrainConfig {
    provider: string;   // 'ollama' | 'gemini' | 'openai' | 'mistral' | 'claude'
    model: string;
}

export function loadConfig(): BrainConfig | null {
    try {
        if (fs.existsSync(CONFIG_PATH))
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch { /* corrupt — ignore */ }
    return null;
}

export function saveConfig(config: BrainConfig): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function clearConfig(): void {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

// ─── Environment Scanner ─────────────────────────────────────────────────────

export interface DetectedProvider {
    provider: Provider;
    key: string;
}

export function scanEnvironment(): DetectedProvider[] {
    return Object.values(PROVIDERS)
        .map(p => ({ provider: p, key: process.env[p.envKey] || '' }))
        .filter(p => p.key.length > 0);
}

// ─── Ollama Discovery ────────────────────────────────────────────────────────

export interface OllamaStatus {
    installed: boolean;
    running: boolean;
    models: string[];
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
    // Check binary
    let installed = false;
    try {
        execSync('which ollama', { stdio: 'ignore' });
        installed = true;
    } catch { /* not found */ }

    if (!installed) return { installed: false, running: false, models: [] };

    // Check if running + list models via REST API
    try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', {
            signal: AbortSignal.timeout(3000),
        });
        const data: any = await res.json();
        const models = (data.models || []).map((m: any) => m.name as string);
        return { installed: true, running: true, models };
    } catch {
        return { installed: true, running: false, models: [] };
    }
}

// Recommended models for auto-install (name, size description, good_for tag)
export const RECOMMENDED_OLLAMA_MODELS = [
    { name: 'qwen3:4b', size: '2.6 GB', tag: 'Fast & smart — recommended' },
    { name: 'mistral:7b', size: '4.1 GB', tag: 'Excellent reasoning' },
    { name: 'llama3.2:3b', size: '2.0 GB', tag: 'Lightweight & quick' },
    { name: 'phi4:latest', size: '9.1 GB', tag: 'Most powerful, needs more RAM' },
    { name: 'deepseek-r1:7b', size: '4.7 GB', tag: 'Strong analysis, chain-of-thought' },
];

// ─── Ollama Installer ────────────────────────────────────────────────────────

async function startOllamaServer(): Promise<boolean> {
    // Try to start `ollama serve` in background
    try {
        const proc = spawn('ollama', ['serve'], { stdio: 'ignore', detached: true });
        proc.unref();
        // Wait up to 6s for it to respond
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 300));
            try {
                await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) });
                return true;
            } catch { /* still starting */ }
        }
        return false;
    } catch {
        return false;
    }
}

async function pullOllamaModel(modelName: string, chalk: any): Promise<boolean> {
    return new Promise(resolve => {
        console.log(chalk.cyan(`\n  Pulling ${modelName} from Ollama registry...\n`));

        const proc = spawn('ollama', ['pull', modelName], { stdio: ['ignore', 'pipe', 'pipe'] });
        let lastLine = '';

        const printProgress = (data: Buffer) => {
            const line = data.toString().trim().split('\n').pop() || '';
            if (line && line !== lastLine) {
                process.stdout.write(`\r  ${chalk.gray(line.slice(0, 72).padEnd(72))}`);
                lastLine = line;
            }
        };

        proc.stdout?.on('data', printProgress);
        proc.stderr?.on('data', printProgress);

        proc.on('close', code => {
            process.stdout.write('\n');
            resolve(code === 0);
        });
        proc.on('error', () => resolve(false));
    });
}

async function installOllama(chalk: any): Promise<boolean> {
    const platform = os.platform();

    if (platform === 'linux') {
        console.log(chalk.cyan('\n  Installing Ollama (Linux)...\n'));
        try {
            execSync('curl -fsSL https://ollama.ai/install.sh | sh', { stdio: 'inherit' });
            return true;
        } catch {
            console.log(chalk.red('\n  Auto-install failed. Install manually:'));
            console.log(chalk.gray('  curl -fsSL https://ollama.ai/install.sh | sh'));
            return false;
        }
    } else if (platform === 'darwin') {
        console.log(chalk.yellow('\n  On macOS, install Ollama from: https://ollama.com/download'));
        console.log(chalk.gray('  Or: brew install ollama'));
        return false;
    } else {
        console.log(chalk.yellow('\n  Download Ollama from: https://ollama.com/download'));
        return false;
    }
}

// ─── Zero-Setup Fallback Flow ────────────────────────────────────────────────
// Called when NO remote API keys AND NO Ollama models are found

export async function runZeroSetupFlow(chalk: any): Promise<
    | { mode: 'ollama'; model: string }
    | { mode: 'remote'; provider: Provider; apiKey: string; model: string }
    | { mode: 'skip' }
> {
    console.log(chalk.yellow.bold('\n  No AI brain found.\n'));
    console.log(chalk.gray('  Edith needs an AI to analyze transactions.'));
    console.log(chalk.gray('  You can use a local model (private, free) or a cloud API.\n'));

    const choice = await select({
        message: '  How would you like to set up the AI brain?',
        choices: [
            { name: 'Install Ollama + download a model  (local, free, private)', value: 'install-ollama' },
            { name: 'Set up a cloud API key              (Gemini / OpenAI / Mistral / Claude)', value: 'setup-api' },
            { name: 'Skip AI analysis                    (parser warnings only, no verdict)', value: 'skip' },
        ],
    });

    // ── Option A: Install Ollama ───────────────────────────────────────────
    if (choice === 'install-ollama') {
        const status = await getOllamaStatus();

        let ollamaReady = status.running;

        if (!status.installed) {
            const doInstall = await confirm({
                message: '  Ollama is not installed. Install it now?',
                default: true,
            });
            if (!doInstall) return { mode: 'skip' };

            const installed = await installOllama(chalk);
            if (!installed) return { mode: 'skip' };
        }

        if (!ollamaReady) {
            console.log(chalk.cyan('\n  Starting Ollama server...'));
            ollamaReady = await startOllamaServer();
            if (!ollamaReady) {
                console.log(chalk.red('  Could not start Ollama. Run `ollama serve` manually and retry.'));
                return { mode: 'skip' };
            }
            console.log(chalk.green('  Ollama is running.\n'));
        }

        // Check if any models are already installed
        const freshStatus = await getOllamaStatus();
        let selectedModel: string;

        if (freshStatus.models.length > 0) {
            console.log(chalk.green(`\n  Found ${freshStatus.models.length} installed model(s).\n`));
            const useExisting = await confirm({
                message: '  Use an already-installed model?',
                default: true,
            });
            if (useExisting) {
                selectedModel = await select({
                    message: '  Select model:',
                    choices: freshStatus.models.map(m => ({ name: m, value: m })),
                });
            } else {
                selectedModel = await pickAndPullModel(chalk);
            }
        } else {
            console.log(chalk.yellow('  No models installed yet. Pick one to download:\n'));
            selectedModel = await pickAndPullModel(chalk);
        }

        const shouldSave = await confirm({ message: '  Save as default?', default: true });
        if (shouldSave) saveConfig({ provider: 'ollama', model: selectedModel });

        return { mode: 'ollama', model: selectedModel };
    }

    // ── Option B: Setup API Key ────────────────────────────────────────────
    if (choice === 'setup-api') {
        console.log(chalk.bold('\n  Set one of these in your shell and re-run edith:\n'));
        Object.values(PROVIDERS).forEach(p => {
            console.log(chalk.cyan(`  ${p.label}`));
            console.log(chalk.gray(`    export ${p.envKey}="your-key-here"`));
            console.log('');
        });
        console.log(chalk.gray('  After setting the key, run: edith brain\n'));
        return { mode: 'skip' };
    }

    return { mode: 'skip' };
}

async function pickAndPullModel(chalk: any): Promise<string> {
    const modelChoice = await select({
        message: '  Select a model to download:',
        choices: RECOMMENDED_OLLAMA_MODELS.map(m => ({
            name: `${m.name.padEnd(22)} ${chalk.gray(m.size.padEnd(10))} ${chalk.dim(m.tag)}`,
            value: m.name,
        })),
    });

    const pulled = await pullOllamaModel(modelChoice, chalk);
    if (!pulled) {
        console.log(chalk.red(`  Failed to pull ${modelChoice}. Check your internet connection.`));
        process.exit(1);
    }
    console.log(chalk.green(`\n  Model ready: ${modelChoice}\n`));
    return modelChoice;
}

// ─── Ollama Interactive Model Selector ───────────────────────────────────────

export async function runOllamaFlow(chalk: any): Promise<{ model: string } | null> {
    const status = await getOllamaStatus();

    if (!status.running) {
        if (status.installed) {
            console.log(chalk.cyan('\n  Starting Ollama server...'));
            const started = await startOllamaServer();
            if (!started) {
                console.log(chalk.red('  Could not start Ollama. Run `ollama serve` manually.'));
                return null;
            }
        } else {
            return null; // Not installed
        }
    }

    const freshStatus = await getOllamaStatus();

    if (freshStatus.models.length === 0) {
        console.log(chalk.yellow('\n  No Ollama models installed.\n'));
        const doPull = await confirm({ message: '  Download a recommended model now?', default: true });
        if (!doPull) return null;
        const model = await pickAndPullModel(chalk);
        return { model };
    }

    if (freshStatus.models.length === 1) {
        // Only one — use it automatically
        console.log(chalk.gray(`  Using: ${freshStatus.models[0]}\n`));
        return { model: freshStatus.models[0] };
    }

    // Multiple models — let user pick
    const model = await select({
        message: '  Select Ollama model:',
        choices: freshStatus.models.map(m => ({ name: m, value: m })),
    });
    return { model };
}

// ─── Remote Provider Fetch ───────────────────────────────────────────────────

function buildClient(provider: Provider, apiKey: string): OpenAI {
    return new OpenAI({
        apiKey,
        baseURL: provider.baseURL,
        defaultHeaders: provider.extraHeaders,
    });
}

async function fetchAvailableModels(provider: Provider, apiKey: string): Promise<string[]> {
    if (!provider.supportsModelList) return provider.fallbackModels;

    try {
        const client = buildClient(provider, apiKey);
        const list = await client.models.list();

        const ids = list.data.map(m => m.id).filter(id => {
            if (provider.name === 'gemini') return id.includes('gemini') && !id.includes('embedding') && !id.includes('vision');
            if (provider.name === 'openai') return /^(gpt-|o1|o3|chatgpt)/.test(id);
            if (provider.name === 'mistral') return !id.includes('embed');
            return true;
        });

        return ids.sort().length > 0 ? ids.sort() : provider.fallbackModels;
    } catch {
        return provider.fallbackModels;
    }
}

export function createProviderClient(provider: Provider, apiKey: string): OpenAI {
    return buildClient(provider, apiKey);
}

// ─── Interactive Brain Setup Flow (remote providers) ─────────────────────────

export async function runBrainFlow(chalk: any): Promise<BrainConfig & { apiKey: string }> {
    console.log(chalk.bold.hex('#00FFAA')('\n  EDITH BRAIN — Remote AI Configuration\n'));

    const allProviders = Object.values(PROVIDERS);
    const detected = scanEnvironment();

    console.log(chalk.white('  Scanning environment for API keys...\n'));
    allProviders.forEach(p => {
        const key = process.env[p.envKey];
        if (key) {
            const masked = key.slice(0, 6) + '*'.repeat(Math.max(0, Math.min(12, key.length - 10))) + key.slice(-4);
            console.log(chalk.green(`    [set]  ${p.label.padEnd(20)} ${p.envKey} = ${chalk.gray(masked)}`));
        } else {
            console.log(chalk.gray(`    [---]  ${p.label.padEnd(20)} ${chalk.dim(p.envKey + ' not set')}  `));
        }
    });
    console.log('');

    if (detected.length === 0) {
        console.log(chalk.red.bold('  No API keys found in environment.\n'));
        allProviders.forEach(p =>
            console.log(chalk.gray(`    export ${p.envKey}="your-api-key-here"`)));
        console.log('');
        process.exit(1);
    }

    const providerChoice = await select({
        message: '  Select AI provider:',
        choices: detected.map(d => ({ name: d.provider.label, value: d.provider.name })),
    });

    const selectedProvider = PROVIDERS[providerChoice];
    const apiKey = process.env[selectedProvider.envKey]!;

    process.stdout.write(chalk.cyan(`\n  Fetching models from ${selectedProvider.label}...`));
    const models = await fetchAvailableModels(selectedProvider, apiKey);
    process.stdout.write(chalk.green(` ${models.length} found\n\n`));

    const modelChoice = await select({
        message: '  Select model:',
        choices: models.map(m => ({ name: m, value: m })),
        pageSize: 12,
    });

    const shouldSave = await confirm({ message: '  Save as default?', default: true });
    const config: BrainConfig = { provider: providerChoice, model: modelChoice };

    if (shouldSave) {
        saveConfig(config);
        console.log(chalk.green(`\n  ✅ Preference saved → ${CONFIG_PATH}`));
    }

    console.log(chalk.bold.hex('#00FFAA')(`\n  Active Brain: ${selectedProvider.label}  →  ${modelChoice}\n`));
    return { ...config, apiKey };
}
