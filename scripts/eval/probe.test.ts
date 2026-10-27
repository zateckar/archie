import { describe, it, expect } from 'vitest';
import { fragmentForProbe, pickDefiningClaim, isProbeableTopic } from './probe';

describe('fragmentForProbe', () => {
    it('never ends inside a parenthesis', () => {
        expect(fragmentForProbe('Effective June 1, 2023, placing emergency calls (such as 112) via Teams is not possible.'))
            .toBe('Effective June 1, 2023');
    });

    it('stops at the first clause boundary after enough words', () => {
        expect(fragmentForProbe('The use of WPA2/3-PSK requires technical requirement checks, and approval.'))
            .toBe('The use of WPA2/3-PSK requires technical requirement checks');
    });

    it('caps long sentences without trailing punctuation', () => {
        const f = fragmentForProbe('one two three four five six seven eight nine ten eleven twelve thirteen');
        expect(f?.split(' ')).toHaveLength(12);
    });

    it('rejects quotes too short to be distinctive', () => {
        expect(fragmentForProbe('NAC is mandatory.')).toBeNull();
        expect(fragmentForProbe('Teams calls (including emergency calls to the national dispatch centre of the Czech Republic) are logged.'))
            .toBeNull();
    });
});

describe('pickDefiningClaim', () => {
    const topic = { name: 'Network Access Control (NAC)', embedding: [1, 0] };

    it('picks a claim that defines the topic over a longer incidental rule', () => {
        const claims = [
            { claim_text: 'Emergency procedures must be created specifically for disabling Network Access Control in a crisis.', claim_type: 'assertion', embedding: [1, 0] },
            { claim_text: 'NAC is a mechanism that protects communication infrastructure against unauthorized access.', claim_type: 'assertion', embedding: [0.5, 1] }
        ];
        expect(pickDefiningClaim(topic, claims)?.claim_text).toMatch(/^NAC is/);
    });

    it('recognises Czech definitions and inflected names', () => {
        const claims = [{ claim_text: 'IT produkty jsou aplikace a služby provozované v rámci IT.', claim_type: 'assertion', embedding: null }];
        expect(pickDefiningClaim({ name: 'IT Produkt', embedding: null }, claims)).not.toBeNull();
    });

    it('returns null when no claim defines the topic', () => {
        const claims = [
            { claim_text: 'FIG acts as the activator for decommissioning when risks are identified.', claim_type: 'assertion', embedding: [1, 0] },
            { claim_text: 'FIG is the designated owner of changes for the key process.', claim_type: 'assertion', embedding: [1, 0] },
            { claim_text: 'FIG is responsible for confirming the completion of the shutdown.', claim_type: 'assertion', embedding: [1, 0] }
        ];
        expect(pickDefiningClaim({ name: 'FIG', embedding: [1, 0] }, claims)).toBeNull();
    });

    it('skips rule-edge and dated claims, returning null when nothing is left', () => {
        const claims = [
            { claim_text: 'Effective June 1, 2023, placing emergency calls is not possible.', claim_type: 'assertion', embedding: [1, 0] },
            { claim_text: 'If the switch fails, NAC must be disabled by the operator.', claim_type: 'condition', embedding: [1, 0] }
        ];
        expect(pickDefiningClaim(topic, claims)).toBeNull();
    });
});

describe('isProbeableTopic', () => {
    it('rejects document-code topics', () => {
        for (const n of ['Document ID.FI.001', 'PP 1.626', 'MP_1_808']) expect(isProbeableTopic(n), n).toBe(false);
        for (const n of ['Microsoft Teams', 'Hypercare', 'Network Access Control (NAC)']) expect(isProbeableTopic(n), n).toBe(true);
    });
});
