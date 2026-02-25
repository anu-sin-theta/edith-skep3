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

// NO SEED DATA - EMPTY DATABASE
const SEED_THREATS: Record<string, Threat> = {};

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
