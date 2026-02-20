import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
        label: '✨ Google Gemini',
        envKey: 'GEMINI_API_KEY',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        supportsModelList: true,
        fallbackModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    },
    openai: {
        name: 'openai',
        label: '🟢 OpenAI',
        envKey: 'OPENAI_API_KEY',
        baseURL: 'https://api.openai.com/v1',
        supportsModelList: true,
        fallbackModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    },
    mistral: {
        name: 'mistral',
        label: '🔶 Mistral',
        envKey: 'MISTRAL_API_KEY',
        baseURL: 'https://api.mistral.ai/v1',
        supportsModelList: true,
        fallbackModels: ['mistral-large-latest', 'mistral-medium', 'mistral-small-latest'],
    },
    claude: {
        name: 'claude',
        label: '🔷 Anthropic Claude',
        envKey: 'ANTHROPIC_API_KEY',
        baseURL: 'https://api.anthropic.com/v1',
        supportsModelList: false,   // No standard models list endpoint
        fallbackModels: [
            'claude-opus-4-5',
            'claude-sonnet-4-5',
            'claude-3-5-haiku-20241022',
            'claude-3-5-sonnet-20241022',
        ],
        extraHeaders: {
            'anthropic-version': '2023-06-01',
        },
    },
};

// ─── Config Persistence ───────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.config', 'edith-sentinel', 'brain.json');

export interface BrainConfig {
    provider: string;
    model: string;
}

export function loadConfig(): BrainConfig | null {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch { /* corrupt config — ignore */ }
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

// ─── Environment Scanner ──────────────────────────────────────────────────────

export interface DetectedProvider {
    provider: Provider;
    key: string;
}

export function scanEnvironment(): DetectedProvider[] {
    return Object.values(PROVIDERS)
        .map(p => ({ provider: p, key: process.env[p.envKey] || '' }))
        .filter(p => p.key.length > 0);
}

// ─── Model Fetcher ────────────────────────────────────────────────────────────

function buildClient(provider: Provider, apiKey: string): OpenAI {
    return new OpenAI({
        apiKey,
        baseURL: provider.baseURL,
        defaultHeaders: provider.extraHeaders,
    });
}

async function fetchAvailableModels(provider: Provider, apiKey: string): Promise<string[]> {
    if (!provider.supportsModelList) {
        return provider.fallbackModels;
    }

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
        // Network failure or auth error — fall back to known good models
        return provider.fallbackModels;
    }
}

// ─── OpenAI-Compat Client Factory (used by SecurityAuditor) ──────────────────

export function createProviderClient(provider: Provider, apiKey: string): OpenAI {
    return buildClient(provider, apiKey);
}

// ─── Interactive Brain Setup Flow ─────────────────────────────────────────────

export async function runBrainFlow(chalk: any): Promise<BrainConfig & { apiKey: string }> {
    console.log(chalk.bold.hex('#00FFAA')('\n  🧠 EDITH BRAIN — Remote AI Configuration\n'));

    // ── Scan env vars ──────────────────────────────────────────────────────
    console.log(chalk.white('  Scanning environment for API keys...\n'));

    const allProviders = Object.values(PROVIDERS);
    const detected = scanEnvironment();

    allProviders.forEach(p => {
        const key = process.env[p.envKey];
        if (key) {
            const masked = key.slice(0, 6) + '*'.repeat(Math.min(12, key.length - 10)) + key.slice(-4);
            console.log(chalk.green(`    ✅  ${p.label.padEnd(28)} ${p.envKey} = ${chalk.gray(masked)}`));
        } else {
            console.log(chalk.gray(`    ❌  ${p.label.padEnd(28)} ${chalk.dim(p.envKey + ' — not set')}`));
        }
    });

    console.log('');

    if (detected.length === 0) {
        console.log(chalk.red.bold('  No API keys found. Please set at least one:\n'));
        allProviders.forEach(p => {
            console.log(chalk.gray(`    export ${p.envKey}="your-api-key-here"`));
        });
        console.log('');
        process.exit(1);
    }

    // ── Select provider ────────────────────────────────────────────────────
    const providerChoice = await select({
        message: '  Select AI provider:',
        choices: detected.map(d => ({
            name: d.provider.label,
            value: d.provider.name,
        })),
    });

    const selectedProvider = PROVIDERS[providerChoice];
    const apiKey = process.env[selectedProvider.envKey]!;

    // ── Fetch models ───────────────────────────────────────────────────────
    process.stdout.write(chalk.cyan(`\n  Fetching models from ${selectedProvider.label}...`));
    const models = await fetchAvailableModels(selectedProvider, apiKey);
    process.stdout.write(chalk.green(` ${models.length} found\n\n`));

    // ── Select model ───────────────────────────────────────────────────────
    const modelChoice = await select({
        message: '  Select model:',
        choices: models.map(m => ({ name: m, value: m })),
        pageSize: 12,
    });

    // ── Save preference ────────────────────────────────────────────────────
    const shouldSave = await confirm({
        message: '  Save as default for future scans?',
        default: true,
    });

    const config: BrainConfig = { provider: providerChoice, model: modelChoice };

    if (shouldSave) {
        saveConfig(config);
        console.log(chalk.green(`\n  ✅ Preference saved → ${CONFIG_PATH}`));
    }

    console.log(chalk.bold.hex('#00FFAA')(
        `\n  🧠 Active Brain: ${selectedProvider.label}  →  ${modelChoice}\n`
    ));

    return { ...config, apiKey };
}
