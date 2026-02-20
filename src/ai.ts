import { Ollama } from 'ollama';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createProviderClient, PROVIDERS, type Provider } from './brain.js';

export type Verdict = 'SAFE' | 'RISKY' | 'CRITICAL';

export interface AuditResult {
    verdict: Verdict;
    reasoning: string;
    raw: string;
    engine: string;   // what model/provider was used
}

function buildPrompt(simulationReport: string): string {
    return `Analyze this simulated Ethereum transaction:

${simulationReport}

TASKS:
1. Identify malicious patterns (Infinite approvals, drainers, suspicious calls).
2. If SUCCESS with 21,000 gas and NO events/calls, it's a plain ETH transfer (SAFE).
3. "fallback()" with no data/value is a "ping" (SAFE).

FORMAT:
VERDICT: [SAFE | RISKY | CRITICAL]
REASON: [Short, clear explanation for a user]
TECHNICAL_DETAIL: [One technical sentence]`;
}

function parseVerdict(raw: string, engine: string, simulationReport?: string): AuditResult {
    // 0. Save raw for debugging
    try {
        const logPath = path.join(os.homedir(), '.config', 'edith-sentinel', 'last-audit.raw');
        fs.writeFileSync(logPath, raw);
    } catch { }

    // 1. Strip thinking tags if present (e.g. <thought> blocks in some models)
    let cleanRaw = raw.replace(/<thought>[^]*?<\/thought>/gi, '').trim();
    if (!cleanRaw && raw) cleanRaw = raw; // Use original if everything was stripped

    // 2. Extract Verdict
    const verdictMatch = cleanRaw.match(/(?:\*\*)?VERDICT(?:\*\*)?:?\s*(SAFE|RISKY|CRITICAL)/i);
    let verdict = (verdictMatch?.[1]?.toUpperCase() as Verdict);

    // 3. Extract Reasoning
    const reasonMatch = cleanRaw.match(/(?:\*\*)?REASON(?:\*\*)?:?\s*([^]*?)(?=(?:\*\*)?TECHNICAL_DETAIL:?|$)/si);
    let reasoning = reasonMatch?.[1]?.trim() || '';

    // 4. Robust Fallbacks
    if (!verdict) {
        if (cleanRaw.includes('CRITICAL')) verdict = 'CRITICAL';
        else if (cleanRaw.includes('RISKY')) verdict = 'RISKY';
        else if (cleanRaw.includes('SAFE')) verdict = 'SAFE';
        else if (simulationReport?.includes('Gas Used: 21000')) verdict = 'SAFE'; // 21k is standard transfer
        else verdict = 'RISKY'; // default safety
    }

    if (!reasoning && cleanRaw) {
        // Just Use the whole cleaned text minus the verdict line
        reasoning = cleanRaw
            .replace(/(?:\*\*)?VERDICT(?:\*\*)?:?\s*(SAFE|RISKY|CRITICAL)/gi, '')
            .replace(/(?:\*\*)?TECHNICAL_DETAIL(?:\*\*)?:?\s*[^]*/gi, '')
            .trim();
    }

    if (!reasoning) reasoning = 'No detailed reasoning provided by AI. Review logs manually.';
    if (reasoning.length > 800) reasoning = reasoning.slice(0, 797) + '...';

    return { verdict, reasoning, raw: cleanRaw, engine };
}

// ─── Ollama Auditor (local) ────────────────────────────────────────────────────

export class OllamaAuditor {
    private ollama: Ollama;
    private model: string;

    constructor(model: string = 'qwen3:4b-instruct') {
        this.ollama = new Ollama({ host: 'http://127.0.0.1:11434' });
        this.model = model;
    }

    async audit(simulationReport: string): Promise<AuditResult> {
        const prompt = buildPrompt(simulationReport);

        try {
            const response = await this.ollama.chat({
                model: this.model,
                messages: [{ role: 'user', content: prompt }],
                options: { temperature: 0.1, num_predict: 512 },
            });
            return parseVerdict(response.message.content, `ollama/${this.model}`, simulationReport);

        } catch (error: any) {
            const isSimple = simulationReport?.includes('Gas Used: 21000');
            return {
                verdict: isSimple ? 'SAFE' : 'RISKY',
                reasoning: isSimple
                    ? `Ollama error, but transaction looks like a simple ETH transfer (21k gas).`
                    : `Ollama error: ${error.message}. Review logs manually.`,
                raw: '',
                engine: 'ollama/error',
            };
        }
    }
}

// ─── Remote Brain Auditor (Gemini / OpenAI / Mistral / Claude) ────────────────

export class RemoteAuditor {
    private client: OpenAI;
    private model: string;
    private provider: Provider;

    constructor(provider: Provider, apiKey: string, model: string) {
        this.provider = provider;
        this.model = model;
        this.client = createProviderClient(provider, apiKey);
    }

    async audit(simulationReport: string): Promise<AuditResult> {
        const prompt = buildPrompt(simulationReport);

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                max_tokens: 1024,
            });

            const content = response.choices[0]?.message?.content || '';
            return parseVerdict(content, `${this.provider.name}/${this.model}`, simulationReport);

        } catch (error: any) {
            const isSimple = simulationReport?.includes('Gas Used: 21000');
            return {
                verdict: isSimple ? 'SAFE' : 'RISKY',
                reasoning: isSimple
                    ? `AI Error (${this.provider.label}), but transaction looks like a simple ETH transfer (21k gas).`
                    : `Remote AI error (${this.provider.label}): ${error.message}. Review logs manually.`,
                raw: '',
                engine: `${this.provider.name}/error`,
            };
        }
    }
}

// ─── Unified SecurityAuditor (selected by mode) ────────────────────────────────

export type AuditMode = 'ollama' | 'remote';

export class SecurityAuditor {
    private auditor: OllamaAuditor | RemoteAuditor;
    public engine: string;

    constructor(mode: AuditMode, opts: {
        ollamaModel?: string;
        provider?: Provider;
        apiKey?: string;
        remoteModel?: string;
    } = {}) {
        if (mode === 'remote' && opts.provider && opts.apiKey && opts.remoteModel) {
            this.auditor = new RemoteAuditor(opts.provider, opts.apiKey, opts.remoteModel);
            this.engine = `${opts.provider.label} → ${opts.remoteModel}`;
        } else {
            this.auditor = new OllamaAuditor(opts.ollamaModel);
            this.engine = `Ollama → ${opts.ollamaModel || 'qwen3:4b-instruct'}`;
        }
    }

    async audit(simulationReport: string): Promise<AuditResult> {
        return this.auditor.audit(simulationReport);
    }
}
