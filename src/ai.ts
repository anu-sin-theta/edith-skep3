import { Ollama } from 'ollama';
import OpenAI from 'openai';
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

function parseVerdict(raw: string, engine: string): AuditResult {
    // Robust regex to handle markdown bolding and variations (**VERDICT:**, VERDICT:, etc.)
    const verdictMatch = raw.match(/(?:\*\*)?VERDICT(?:\*\*)?:?\s*(SAFE|RISKY|CRITICAL)/i);
    const reasonMatch = raw.match(/(?:\*\*)?REASON(?:\*\*)?:?\s*([^]*?)(?=(?:\*\*)?TECHNICAL_DETAIL:?|$)/si);

    let verdict = (verdictMatch?.[1]?.toUpperCase() as Verdict) || 'RISKY';
    let reasoning = reasonMatch?.[1]?.trim() || '';

    // If regex failed to find structured reason, try to extract the main block of text
    if (!reasoning && raw) {
        reasoning = raw
            .replace(/(?:\*\*)?VERDICT(?:\*\*)?:\s*(SAFE|RISKY|CRITICAL)/gi, '')
            .replace(/(?:\*\*)?TECHNICAL_DETAIL(?:\*\*)?:?\s*[^]*/gi, '')
            .trim();
    }

    // Cap reasoning length
    if (reasoning.length > 800) reasoning = reasoning.slice(0, 797) + '...';

    return {
        verdict,
        reasoning: reasoning || 'No reasoning provided by AI. Review raw logs.',
        raw,
        engine
    };
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
            return parseVerdict(response.message.content, `ollama/${this.model}`);

        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                return {
                    verdict: 'RISKY',
                    reasoning: "Ollama is not running. Start it with: 'ollama serve'. Parser warnings above are the only analysis available.",
                    raw: '',
                    engine: 'ollama/unavailable',
                };
            }
            return {
                verdict: 'RISKY',
                reasoning: `Ollama error: ${error.message}`,
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
                max_tokens: 512,
            });

            const content = response.choices[0]?.message?.content || '';
            return parseVerdict(content, `${this.provider.name}/${this.model}`);

        } catch (error: any) {
            return {
                verdict: 'RISKY',
                reasoning: `Remote AI error (${this.provider.label}): ${error.message}. Falling back to parser warnings only.`,
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
