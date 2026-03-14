# How Skep3 Works

Skep3 (formerly Edith Sentinel) is a local-first transaction firewall that uses a combination of deterministic EVM simulation and AI-powered semantic analysis to protect your wallet.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
                         SKEP3 CORE ENGINE                            
│                                                                      │
│   CLI Entry (index.ts)                                               │
│   └── Commander.js Context                                           │
│         │                                                            │
│         ├──► AnvilSimulator (simulator.ts)                           │
│         │     ├── Spawns Anvil (Foundry/Rust EVM)                    │
│         │     ├── Forks Network State via RPC                        │
│         │     ├── anvil_impersonateAccount (Zero-Key Simulation)     │
│         │     └── debug_traceTransaction                             │
│         │                                                            │
│         ├──► TransactionParser (parser.ts)                           │
│         │     ├── Decodes ERC-20/721/1155 Events                     │
│         │     ├── Detects Opcodes (DELEGATECALL/SELFDESTRUCT)        │
│         │     ├── Dynamic Decimal Resolution (readContract)          │
│         │     └── Formats Audit Report for AI                        │
│         │                                                            │
│         └──► SecurityAuditor (ai.ts)                                 │
│               ├── Local Ollama (qwen3:4b-instruct)                   │
│               └── Remote Providers (Gemini/OpenAI/Claude)            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## The Simulation Workflow

### 1. Lazy State Forking
Instead of downloading the entire blockchain, Skep3 uses **Anvil** to create a "Copy-on-Write" fork. 
- When a transaction touches a contract (e.g., USDC), Anvil fetches its bytecode and storage slots on-demand via RPC.
- All state changes are kept in your machine's RAM and never broadcast to the real network.

### 2. Impersonation (No Private Keys)
Skep3 uses "Cheat Codes" to simulate transactions.
- By calling `anvil_impersonateAccount(yourAddress)`, we can execute a transaction *as if* it was signed by you.
- Your private keys never leave your secure wallet; we only work with the public transaction payload.

### 3. Three-Layer Analysis
- **Layer 1: Deterministic Rules**: Hardcoded logic for known threats like Infinite Approvals (`amount == MaxUint256`).
- **Layer 2: Trace Heuristics**: Walking the EVM call tree to find hidden `DELEGATECALL` logic or obfuscated XOR loops.
- **Layer 3: AI Semantic Reasoning**: The LLM analyzes the *intent* of the code. It notices if a contract claims to be an "Airdrop" but secretly performs a "Drain."

## Proxy Mode (Intercepting Wallets)
Skep3 can act as a local RPC server (`http://127.0.0.1:9545`).
- You point your MetaMask/Phantom to this local URL.
- Every time you click "Sign" in your browser, Skep3 intercepts the raw transaction bytes.
- It runs the full simulation and AI audit, then prompts you in the terminal: **"Do you want to broadcast this?"**
- Only if you approve, the transaction is forwarded to the real blockchain.
