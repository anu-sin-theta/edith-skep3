export interface Threat {
    address: string;
    actor: string;
    campaign: string;
    description: string;
    severity: 'CRITICAL' | 'HIGH';
}

export const KNOWN_THREATS: Record<string, Threat> = {
    // UNC5342 (EtherHiding) - BSC Payload Host
    '0x8eac3198dd72f3e07108c4c7cff43108ad48a71c': {
        address: '0x8eac3198dd72f3e07108c4c7cff43108ad48a71c',
        actor: 'UNC5342',
        campaign: 'EtherHiding / JADESNOW',
        description: 'Malicious BSC contract used to host second-stage JADESNOW malware payloads. Part of a campaign that hides malicious code within blockchain transactions.',
        severity: 'CRITICAL'
    },
    // UNC5342 - Attacker Wallet
    '0x9bc1355344b54dedf3e44296916ed15653844509': {
        address: '0x9bc1355344b54dedf3e44296916ed15653844509',
        actor: 'UNC5342',
        campaign: 'EtherHiding',
        description: 'Attacker-controlled wallet (Owner address) associated with the UNC5342 EtherHiding campaign.',
        severity: 'HIGH'
    }
};

export function checkThreat(address: string): Threat | undefined {
    return KNOWN_THREATS[address.toLowerCase()];
}
