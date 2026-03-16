import fs from 'fs';
import path from 'path';
import os from 'os';

export interface Threat {
    address: string;
    actor: string;
    campaign: string;
    description: string;
    severity: 'CRITICAL' | 'HIGH';
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'edith-sentinel');
const THREATS_PATH = path.join(CONFIG_DIR, 'threats.json');

// SEED DATA - BASIC PROTECTION FOR KNOWN DRAINERS
const SEED_THREATS: Record<string, Threat> = {
    '0x00000000ec6a8330752b04f5b5f8f04f5b5f8f04': {
        address: '0x00000000ec6a8330752b04f5b5f8f04f5b5f8f04',
        actor: 'EtherHiding Campaign',
        campaign: 'Seaport Unpacking',
        description: 'Common unpacking contract for obfuscated Seaport drainers.',
        severity: 'CRITICAL'
    },
    '0x00007b0292ea917906d9fd9d9fd9d9fd9d9fd9fd': {
        address: '0x00007b0292ea917906d9fd9d9fd9d9fd9d9fd9fd',
        actor: 'Pink Drainer',
        campaign: 'Wallet Drainer v2',
        description: 'Entrypoint for the Pink Drainer malicious network.',
        severity: 'CRITICAL'
    }
};

export function getThreat(address: string | null): Threat | undefined {
    if (!address) return undefined;
    let threats = SEED_THREATS;

    try {
        if (fs.existsSync(THREATS_PATH)) {
            const data = JSON.parse(fs.readFileSync(THREATS_PATH, 'utf-8'));
            threats = { ...SEED_THREATS, ...data };
        }
    } catch (e) { }

    return threats[address.toLowerCase()];
}

export function addThreat(threat: Threat) {
    if (!threat || !threat.address) return;
    try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        let current = {};
        if (fs.existsSync(THREATS_PATH)) {
            current = JSON.parse(fs.readFileSync(THREATS_PATH, 'utf-8'));
        }
        const updated = { ...current, [threat.address.toLowerCase()]: threat };
        fs.writeFileSync(THREATS_PATH, JSON.stringify(updated, null, 2));
    } catch (e) { }
}

export async function syncThreats(customSource?: string): Promise<number> {
    const SOURCE_URL = customSource || 'https://raw.githubusercontent.com/anu-sin-theta/edith-skep3/main/threats_feed.json';
    try {
        const res = await fetch(SOURCE_URL);
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

        const data = await res.json() as Record<string, Threat>;
        const count = Object.keys(data).length;

        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        let current = {};
        if (fs.existsSync(THREATS_PATH)) {
            current = JSON.parse(fs.readFileSync(THREATS_PATH, 'utf-8'));
        }

        const updated = { ...current, ...data };
        fs.writeFileSync(THREATS_PATH, JSON.stringify(updated, null, 2));

        return count;
    } catch (err: any) {
        throw new Error(`Failed to sync threats: ${err.message}`);
    }
}
