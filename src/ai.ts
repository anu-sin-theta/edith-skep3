import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

export type Verdict = 'SAFE' | 'RISKY' | 'CRITICAL';

export interface AuditResult {
    verdict: Verdict;
    reasoning: string;
    raw: string;
}

export class SecurityAuditor {
    private model: string;

    constructor(model: string = 'qwen3:4b-instruct') {
        this.model = model;
    }

    async audit(simulationReport: string): Promise<AuditResult> {
        const prompt = `You are EDITH, an expert Web3 security auditor specializing in smart contract exploits, phishing transactions, and token drainers.

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

        try {
            const response = await ollama.chat({
                model: this.model,
                messages: [{ role: 'user', content: prompt }],
                options: {
                    temperature: 0.1,     // Low temp = more deterministic security analysis
                    num_predict: 512,
                },
            });

            const raw = response.message.content;
            return this.parseVerdict(raw);

        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                return {
                    verdict: 'RISKY',
                    reasoning: "AI analysis unavailable — Ollama is not running. Start it with: 'ollama serve'. Proceeding with parser warnings only.",
                    raw: '',
                };
            }
            return {
                verdict: 'RISKY',
                reasoning: `AI analysis error: ${error.message}`,
                raw: '',
            };
        }
    }

    private parseVerdict(raw: string): AuditResult {
        const verdictMatch = raw.match(/VERDICT:\s*(SAFE|RISKY|CRITICAL)/i);
        const reasonMatch = raw.match(/REASON:\s*(.+?)(?=TECHNICAL_DETAIL:|$)/si);

        const verdict = (verdictMatch?.[1]?.toUpperCase() as Verdict) || 'RISKY';
        const reasoning = reasonMatch?.[1]?.trim() || raw.slice(0, 300);

        return { verdict, reasoning, raw };
    }
}
