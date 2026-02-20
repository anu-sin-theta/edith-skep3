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

// ─── Shared Security Prompt ────────────────────────────────────────────────────

function buildPrompt(simulationReport: string): string {
    return `You are EDITH, an expert Web3 security auditor specializing in smart contract exploits, phishing transactions, and token drainers.

You are analyzing a SIMULATED transaction that was run in a sandboxed local Ethereum fork BEFORE the user signs it.

${simulationReport}

Your task:
1. Analyze the emitted events and call trace for malicious patterns.
2. Look specifically for:
   - INFINITE token approvals (drainer pattern)
   - DELEGATECALL to unknown/unverified contracts
   - Tokens being transferred OUT of the user's wallet unexpectedly
   - SELFDESTRUCT calls
   - Reentrancy patterns (repeated calls to same function)
   - Contract addresses that are proxies to unknown implementations

Give your response in EXACTLY this format:
VERDICT: [SAFE | RISKY | CRITICAL]
REASON: [2-4 sentences explaining your reasoning clearly for a non-technical user]
TECHNICAL_DETAIL: [1-2 sentences with technical specifics for advanced users]`;
}

function parseVerdict(raw: string, engine: string): AuditResult {
    const verdictMatch = raw.match(/VERDICT:\s*(SAFE|RISKY|CRITICAL)/i);
    const reasonMatch = raw.match(/REASON:\s*(.+?)(?=TECHNICAL_DETAIL:|$)/si);

    const verdict = (verdictMatch?.[1]?.toUpperCase() as Verdict) || 'RISKY';
    const reasoning = reasonMatch?.[1]?.trim() || raw.slice(0, 400);

    return { verdict, reasoning, raw, engine };
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
