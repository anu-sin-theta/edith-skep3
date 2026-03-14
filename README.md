<div align="center">

<img src="assets/banner.png" alt="Skep3 Banner" width="100%" />

# SKEP3
### *The Privacy-First, AI-Powered Web3 Transaction Firewall*

> **Simulate before you sign. Know before you lose.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Foundry](https://img.shields.io/badge/Foundry-Anvil-orange?style=flat-square)](https://getfoundry.sh/)
[![Ollama](https://img.shields.io/badge/Ollama-Local%20AI-black?style=flat-square)](https://ollama.com/)
[![License](https://img.shields.io/badge/License-ISC-green?style=flat-square)]()
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-brightgreen?style=flat-square)]()

</div>

---

## 🛡️ Why Skep3?

Every year, billions of dollars are stolen via malicious smart contracts. Even experienced users struggle to read raw transaction data. **Skep3** acts as your personal blockchain bodyguard:

- **Infinite Approval Alerts**: Stop drainers from getting unlimited access to your tokens.
- **Hidden Logic Detection**: Catch `DELEGATECALL` and `SELFDESTRUCT` payloads.
- **AI-Powered Clarity**: Get a plain-English explanation of what a transaction *actually* does.
- **100% Private**: Using local LLMs (Ollama), No data—including your wallet address—ever leaves your computer.

---

## 🚀 Quick Start

### 1. Prerequisites
Ensure you have **Foundry** and **Ollama** installed:

```bash
# Install Foundry (Anvil)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Install Ollama
# Download from https://ollama.com
ollama pull qwen2.5:3b # Highly recommended for M1/M2/M3 Macs
```

### 2. Installation
Install Skep3 globally via NPM:

```bash
git clone https://github.com/anu-sin-theta/edith-skep3.git
cd edith-skep3
npm install && npm run build
npm link
```

---

## 💻 Usage

### Scan a Contract or Transaction
Analyze any contract interaction before you sign it in your wallet:

```bash
# Scan a specific contract method
edith scan 0xContractAddress --method "claimReward()"

# Analyze a past transaction hash to learn from it
edith scan 0xTransactionHash
```

### Proxy Mode (Real-time Protection)
Start a local firewall that intercepts all outgoing wallet transactions:

```bash
edith proxy
```
*Now, point your wallet (MetaMask/Phantom) to `http://127.0.0.1:9545`. Skep3 will audit every transaction and ask for your permission before broadcasting.*

### Configure Your AI
Switch between local Ollama models or remote providers (Gemini/OpenAI):

```bash
edith brain
```

---

## 📖 Documentation
- [How it Works (Technical Architecture)](working.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

---

<div align="center">

Built with ❤️ by [anu-sin-theta](https://anufied.me)

</div>
