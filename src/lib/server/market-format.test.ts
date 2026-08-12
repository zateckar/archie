import { describe, it, expect } from 'vitest';
import {
    ALERT_CATEGORIES,
    LOOKBACK_MONTHS,
    NO_PUBLIC_INFORMATION,
    PUBLIC_IDENTITY_FIELDS,
    SEVERITIES,
    VERDICTS,
    alertFingerprint,
    briefIsEmpty,
    buildAssessmentPrompt,
    buildResearchPrompt,
    buildSubject,
    normalizeAssessment,
    normalizeEventDate,
    researchInputHash,
    resolveSource,
    selectDue,
    severityRank,
    type MarketSubject,
    type PortfolioContext,
    type ResearchCandidate
} from './market-format';
import type { GroundedSource } from './providers';

/**
 * The tests that matter here are the containment ones: what may leave for a
 * search engine, and what a model is allowed to put in the database. The rest
 * is ordinary shaping.
 */

const SOURCES: GroundedSource[] = [
    { title: 'BleepingComputer — breach report', url: 'https://example.test/a' },
    { title: 'Vendor security advisory', url: 'https://example.test/b' }
];

function subject(over: Partial<MarketSubject> = {}): MarketSubject {
    return {
        factsheetId: 'fs-1',
        name: 'Confluence',
        alias: null,
        vendor: 'Atlassian',
        category: 'SaaS',
        label: 'Confluence (Atlassian)',
        ...over
    };
}

describe('buildSubject', () => {
    it('labels with the vendor when there is one', () => {
        const s = buildSubject({ id: 'x', fs_type: 'ITComponent', name: 'Jira', category: 'SaaS' }, 'Atlassian');
        expect(s.label).toBe('Jira (Atlassian)');
        expect(s.vendor).toBe('Atlassian');
    });

    it('falls back to the bare name when no vendor is recorded', () => {
        const s = buildSubject({ id: 'x', fs_type: 'ITComponent', name: 'Jira' }, null);
        expect(s.label).toBe('Jira');
        expect(s.vendor).toBeNull();
    });

    it('keeps an alias that adds a second identifier', () => {
        const s = buildSubject({ id: 'x', fs_type: 'Application', name: 'ERP Core', alias: 'SAP S/4HANA' }, null);
        expect(s.alias).toBe('SAP S/4HANA');
    });

    it('drops an alias that only repeats the name', () => {
        const s = buildSubject({ id: 'x', fs_type: 'Application', name: 'Jira', alias: ' jira ' }, null);
        expect(s.alias).toBeNull();
    });

    it('treats blank strings as absent rather than as empty values', () => {
        const s = buildSubject({ id: 'x', fs_type: 'Application', name: 'Jira', alias: '  ', category: '' }, '   ');
        expect(s.alias).toBeNull();
        expect(s.vendor).toBeNull();
        expect(s.category).toBeNull();
        expect(s.label).toBe('Jira');
    });

    it('never produces an empty name, even from an unnamed factsheet', () => {
        const s = buildSubject({ id: 'fs-42', fs_type: 'Application', name: '   ' }, null);
        expect(s.name).toBe('fs-42');
    });
});

describe('buildResearchPrompt — what leaves for a search engine', () => {
    // The one test in this file worth failing a release over. The grounded call
    // is the only outward-facing request in the app, and everything internal
    // must stay out of it.
    it('contains no internal portfolio data', () => {
        // Value-level rather than vocabulary-level: the prompt legitimately asks
        // about the VENDOR's ownership and end-of-life announcements, so banning
        // those words would be testing the wrong thing. What must never appear
        // is a value taken from our own record.
        const internal: PortfolioContext = {
            fsType: 'INTERNAL_TYPE_MARKER',
            lifecycle: 'INTERNAL_LIFECYCLE_MARKER',
            technicalFit: 'INTERNAL_FIT_MARKER',
            functionalFit: 'INTERNAL_FUNCTIONAL_MARKER',
            businessCriticality: 'INTERNAL_CRITICALITY_MARKER',
            timeClassification: 'INTERNAL_TIME_MARKER',
            endOfLifeDate: 'INTERNAL_EOL_MARKER',
            dependentApplications: 8675309,
            capabilities: 'INTERNAL_CAPABILITY_MARKER'
        };

        const prompt = buildResearchPrompt(subject({ name: 'Power Platform', vendor: 'Microsoft' }));
        for (const value of Object.values(internal)) {
            expect(prompt).not.toContain(String(value));
        }

        // And the vocabulary that could only come from the internal record, in
        // case a field is ever inlined into this prompt by hand.
        for (const term of ['criticality', 'TIME classification', 'Skoda', 'SKODA', 'Škoda']) {
            expect(prompt).not.toContain(term);
        }
    });

    it('carries every public identity field it was given', () => {
        const prompt = buildResearchPrompt(
            subject({ name: 'ERP Core', alias: 'SAP S/4HANA', vendor: 'SAP', category: 'On premise' })
        );
        expect(prompt).toContain('ERP Core');
        expect(prompt).toContain('SAP S/4HANA');
        expect(prompt).toContain('SAP');
        expect(prompt).toContain('On premise');
    });

    it('omits the optional identity lines that are absent', () => {
        const prompt = buildResearchPrompt(subject({ alias: null, vendor: null, category: null }));
        expect(prompt).not.toContain('Also known as:');
        expect(prompt).not.toContain('Vendor:');
        expect(prompt).not.toContain('Kind of product:');
    });

    it('gives the model an explicit way to say it found nothing', () => {
        expect(buildResearchPrompt(subject())).toContain(NO_PUBLIC_INFORMATION);
    });

    it('states the lookback window it asks about', () => {
        expect(buildResearchPrompt(subject())).toContain(String(LOOKBACK_MONTHS));
    });

    it('only reads fields on the documented allowlist', () => {
        // Guards the allowlist against drift: a field added to MarketSubject and
        // used in the prompt has to be added here consciously.
        expect([...PUBLIC_IDENTITY_FIELDS]).toEqual(['name', 'alias', 'vendor', 'category']);

        const full = buildResearchPrompt(
            subject({ name: 'N', alias: 'A', vendor: 'V', category: 'C' })
        );
        const identityOnly = buildResearchPrompt(
            subject({ name: 'N', alias: 'A', vendor: 'V', category: 'C', factsheetId: 'DIFFERENT', label: 'DIFFERENT' })
        );
        // Neither the internal id nor the display label reaches the prompt.
        expect(full).toBe(identityOnly);
        expect(full).not.toContain('DIFFERENT');
    });
});

describe('buildAssessmentPrompt', () => {
    const context: PortfolioContext = {
        fsType: 'ITComponent',
        lifecycle: 'active',
        technicalFit: 'unreasonable',
        businessCriticality: 'missionCritical',
        dependentApplications: 974,
        capabilities: 'Container Orchestration'
    };

    it('passes the internal record to the un-grounded call', () => {
        const prompt = buildAssessmentPrompt(subject(), 'A brief.', SOURCES, context);
        expect(prompt).toContain('missionCritical');
        expect(prompt).toContain('974');
        expect(prompt).toContain('Container Orchestration');
    });

    it('numbers the sources so the model can cite by index', () => {
        const prompt = buildAssessmentPrompt(subject(), 'A brief.', SOURCES, context);
        expect(prompt).toContain('[1] BleepingComputer — breach report');
        expect(prompt).toContain('[2] Vendor security advisory');
    });

    it('never shows the model a URL it could copy back', () => {
        const prompt = buildAssessmentPrompt(subject(), 'A brief.', SOURCES, context);
        expect(prompt).not.toContain('https://example.test/a');
        expect(prompt).toContain('Never write a URL');
    });

    it('handles a factsheet with nothing recorded beyond its type', () => {
        const prompt = buildAssessmentPrompt(subject(), 'A brief.', [], { fsType: 'Application' });
        expect(prompt).toContain('Type: Application');
        expect(prompt).toContain('(none reported)');
    });
});

describe('researchInputHash', () => {
    it('is stable for the same identity', () => {
        expect(researchInputHash(subject())).toBe(researchInputHash(subject()));
    });

    it('changes when the product or its vendor changes', () => {
        const base = researchInputHash(subject());
        expect(researchInputHash(subject({ name: 'Jira' }))).not.toBe(base);
        expect(researchInputHash(subject({ vendor: 'Broadcom' }))).not.toBe(base);
    });

    it('ignores fields that do not change what is being researched', () => {
        // A renamed owner or a reworded description must not spend a search.
        const base = researchInputHash(subject());
        expect(researchInputHash(subject({ factsheetId: 'other', label: 'other' }))).toBe(base);
    });
});

describe('selectDue — what gets billed', () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const NOW = 1_800_000_000_000;
    const OPTIONS = { now: NOW, ttlMs: 7 * DAY, errorRetryMs: 6 * HOUR, force: false };

    /** A candidate whose stored hash matches its identity — i.e. unchanged. */
    function candidate(over: Partial<ResearchCandidate> = {}): ResearchCandidate {
        const row: ResearchCandidate = {
            id: 'fs-1',
            fs_type: 'ITComponent',
            name: 'Confluence',
            alias: null,
            category: 'SaaS',
            vendor: 'Atlassian',
            input_hash: null,
            researched_at_ms: NOW - DAY,
            had_error: 0,
            ...over
        };
        if (over.input_hash === undefined) {
            row.input_hash = researchInputHash(buildSubject(row, row.vendor));
        }
        return row;
    }

    it('researches a factsheet that has never been researched', () => {
        const due = selectDue([candidate({ researched_at_ms: null, input_hash: null })], OPTIONS);
        expect(due).toHaveLength(1);
        expect(due[0].reason).toBe('new');
    });

    it('leaves a fresh assessment alone', () => {
        expect(selectDue([candidate()], OPTIONS)).toEqual([]);
    });

    it('refreshes once the TTL has elapsed', () => {
        const due = selectDue([candidate({ researched_at_ms: NOW - 8 * DAY })], OPTIONS);
        expect(due[0].reason).toBe('stale');
    });

    it('re-researches immediately when the product identity changed', () => {
        // A renamed factsheet or a changed vendor is a different question, and
        // waiting a week to ask it would leave the page confidently wrong.
        const due = selectDue([candidate({ input_hash: 'hash-of-a-different-product' })], OPTIONS);
        expect(due[0].reason).toBe('changed');
    });

    it('ignores changes that do not change what would be searched', () => {
        // Only name/alias/vendor/category feed the hash, so this stays quiet.
        const row = candidate();
        expect(selectDue([{ ...row, fs_type: 'Application' }], OPTIONS)).toEqual([]);
    });

    it('retries a failed attempt on the short clock, not the TTL', () => {
        const due = selectDue([candidate({ had_error: 1, researched_at_ms: NOW - 7 * HOUR })], OPTIONS);
        expect(due[0].reason).toBe('retry');
    });

    it('does not retry a failure instantly — one wasted call, not a loop', () => {
        expect(selectDue([candidate({ had_error: 1, researched_at_ms: NOW - HOUR })], OPTIONS)).toEqual([]);
    });

    it('force picks up even a fresh assessment', () => {
        const due = selectDue([candidate()], { ...OPTIONS, force: true });
        expect(due[0].reason).toBe('forced');
    });

    it('puts never-researched factsheets ahead of refreshes', () => {
        const rows = [
            candidate({ id: 'stale', researched_at_ms: NOW - 30 * DAY }),
            candidate({ id: 'forced' }),
            candidate({ id: 'new', researched_at_ms: null, input_hash: null }),
            candidate({ id: 'errored', had_error: 1, researched_at_ms: NOW - DAY }),
            candidate({ id: 'changed', input_hash: 'different' })
        ];
        const order = selectDue(rows, { ...OPTIONS, force: true }).map(c => c.row.id);
        expect(order).toEqual(['new', 'changed', 'errored', 'stale', 'forced']);
    });

    it('orders equally-due factsheets oldest first', () => {
        const rows = [
            candidate({ id: 'recent', researched_at_ms: NOW - 8 * DAY }),
            candidate({ id: 'ancient', researched_at_ms: NOW - 60 * DAY }),
            candidate({ id: 'middle', researched_at_ms: NOW - 20 * DAY })
        ];
        expect(selectDue(rows, OPTIONS).map(c => c.row.id)).toEqual(['ancient', 'middle', 'recent']);
    });

    it('hands back the subject and hash it decided with', () => {
        // The caller stores this hash; recomputing it there could disagree.
        const due = selectDue([candidate({ researched_at_ms: null, input_hash: null })], OPTIONS);
        expect(due[0].subject.label).toBe('Confluence (Atlassian)');
        expect(due[0].hash).toBe(researchInputHash(due[0].subject));
    });

    it('returns nothing for an empty portfolio', () => {
        expect(selectDue([], { ...OPTIONS, force: true })).toEqual([]);
    });
});

describe('normalizeEventDate', () => {
    it('accepts full dates, months and years', () => {
        expect(normalizeEventDate('2026-03-14')).toBe('2026-03-14');
        expect(normalizeEventDate('2026-03')).toBe('2026-03');
        expect(normalizeEventDate('2026')).toBe('2026');
    });

    it('rejects impossible dates that a naive parser would roll forward', () => {
        expect(normalizeEventDate('2026-02-31')).toBeNull();
        expect(normalizeEventDate('2026-13-01')).toBeNull();
    });

    it('rejects prose and empty values', () => {
        expect(normalizeEventDate('last spring')).toBeNull();
        expect(normalizeEventDate('')).toBeNull();
        expect(normalizeEventDate(null)).toBeNull();
        expect(normalizeEventDate(undefined)).toBeNull();
    });
});

describe('resolveSource — citations cannot be invented', () => {
    it('resolves a valid 1-based index', () => {
        expect(resolveSource(1, SOURCES)?.url).toBe('https://example.test/a');
        expect(resolveSource(2, SOURCES)?.url).toBe('https://example.test/b');
    });

    it('refuses an index outside the reported list', () => {
        expect(resolveSource(0, SOURCES)).toBeNull();
        expect(resolveSource(3, SOURCES)).toBeNull();
        expect(resolveSource(-1, SOURCES)).toBeNull();
    });

    it('refuses anything that is not an index, including a URL', () => {
        expect(resolveSource('https://attacker.test/', SOURCES)).toBeNull();
        expect(resolveSource(null, SOURCES)).toBeNull();
        expect(resolveSource(1.5, SOURCES)).toBeNull();
    });
});

describe('alertFingerprint', () => {
    it('is stable across rewording that is not a wording change', () => {
        expect(alertFingerprint('security', 'Critical RCE in Confluence Data Center'))
            .toBe(alertFingerprint('security', 'critical rce in confluence data center!'));
    });

    it('separates genuinely different events', () => {
        expect(alertFingerprint('security', 'RCE in Confluence'))
            .not.toBe(alertFingerprint('security', 'RCE in Jira'));
    });

    it('separates the same headline reported under a different category', () => {
        expect(alertFingerprint('security', 'Vendor acquired'))
            .not.toBe(alertFingerprint('ownership', 'Vendor acquired'));
    });

    it('folds diacritics so the same story does not fingerprint twice', () => {
        expect(alertFingerprint('financial', 'Škoda partner insolvent'))
            .toBe(alertFingerprint('financial', 'Skoda partner insolvent'));
    });
});

describe('severityRank', () => {
    it('orders critical first and unknown last', () => {
        expect(severityRank('critical')).toBeLessThan(severityRank('high'));
        expect(severityRank('high')).toBeLessThan(severityRank('medium'));
        expect(severityRank('medium')).toBeLessThan(severityRank('low'));
        expect(severityRank('nonsense')).toBeGreaterThan(severityRank('low'));
    });
});

describe('briefIsEmpty', () => {
    it('recognises the sentinel, including when the model decorates it', () => {
        expect(briefIsEmpty(NO_PUBLIC_INFORMATION)).toBe(true);
        expect(briefIsEmpty(`**${NO_PUBLIC_INFORMATION}**`)).toBe(true);
        expect(briefIsEmpty(`${NO_PUBLIC_INFORMATION}.\n`)).toBe(true);
    });

    it('treats a blank reply as empty', () => {
        expect(briefIsEmpty('   \n ')).toBe(true);
    });

    it('does not discard a real brief that happens to mention the sentinel', () => {
        const long = `Confluence is a wiki by Atlassian. ${'It is widely deployed. '.repeat(20)} The instruction ${NO_PUBLIC_INFORMATION} did not apply.`;
        expect(briefIsEmpty(long)).toBe(false);
    });
});

describe('normalizeAssessment', () => {
    const good = {
        identified: true,
        vendor: 'Atlassian',
        verdict: 'solid',
        confidence: 0.7,
        headline: 'Mature product with a serious 2026 vulnerability.',
        rationale: 'Widely deployed and well supported, but the CVE stream is heavy.',
        marketPosition: 'leader — dominant in its niche',
        strengths: ['Mature ecosystem', 'Strong integrations'],
        concerns: ['Frequent critical CVEs'],
        alternatives: [{ name: 'Notion', vendor: 'Notion Labs', why: 'Better editing', fit: 'comparable' }],
        alerts: [
            { severity: 'critical', category: 'security', title: 'RCE exploited in the wild', detail: 'Patch now.', date: '2026-03-14', sourceIndex: 1 }
        ]
    };

    it('passes a well-formed assessment through', () => {
        const result = normalizeAssessment(good, SOURCES);
        expect(result.identified).toBe(true);
        expect(result.verdict).toBe('solid');
        expect(result.confidence).toBe(0.7);
        expect(result.alternatives).toHaveLength(1);
        expect(result.alerts[0].sourceUrl).toBe('https://example.test/a');
        expect(result.alerts[0].sourceTitle).toBe('BleepingComputer — breach report');
    });

    it('collapses everything when the product was not identified', () => {
        // The important half: a model that says "not identified" and then lists a
        // breach is describing something it did not find.
        const result = normalizeAssessment(
            { ...good, identified: false },
            SOURCES
        );
        expect(result.identified).toBe(false);
        expect(result.verdict).toBe('unknown');
        expect(result.alerts).toEqual([]);
        expect(result.alternatives).toEqual([]);
        expect(result.headline).toBeNull();
    });

    it('treats a substanceless response as unidentified', () => {
        expect(normalizeAssessment({}, SOURCES).identified).toBe(false);
        expect(normalizeAssessment({ alerts: [] }, SOURCES).identified).toBe(false);
    });

    it('survives garbage without throwing', () => {
        for (const input of [null, undefined, 'a string', 42, []]) {
            expect(() => normalizeAssessment(input, SOURCES)).not.toThrow();
            expect(normalizeAssessment(input, SOURCES).identified).toBe(false);
        }
    });

    it('folds unknown enum values to a safe default rather than storing them', () => {
        const result = normalizeAssessment(
            {
                ...good,
                verdict: 'catastrophic',
                alerts: [{ severity: 'apocalyptic', category: 'meteor', title: 'Something happened' }],
                alternatives: [{ name: 'X', why: 'y', fit: 'sideways' }]
            },
            SOURCES
        );
        expect(VERDICTS).toContain(result.verdict);
        expect(result.verdict).toBe('unknown');
        expect(SEVERITIES).toContain(result.alerts[0].severity);
        expect(result.alerts[0].severity).toBe('medium');
        expect(ALERT_CATEGORIES).toContain(result.alerts[0].category);
        expect(result.alerts[0].category).toBe('other');
        expect(result.alternatives[0].fit).toBe('comparable');
    });

    it('accepts enum values the model spelled with spaces or hyphens', () => {
        const result = normalizeAssessment({ ...good, verdict: 'Best-in class' }, SOURCES);
        expect(result.verdict).toBe('best_in_class');
    });

    it('clamps confidence into range and drops non-numbers', () => {
        expect(normalizeAssessment({ ...good, confidence: 4 }, SOURCES).confidence).toBe(1);
        expect(normalizeAssessment({ ...good, confidence: -2 }, SOURCES).confidence).toBe(0);
        expect(normalizeAssessment({ ...good, confidence: 'high' }, SOURCES).confidence).toBeNull();
    });

    it('caps every unbounded array', () => {
        const result = normalizeAssessment(
            {
                ...good,
                strengths: Array.from({ length: 50 }, (_, i) => `strength ${i}`),
                concerns: Array.from({ length: 50 }, (_, i) => `concern ${i}`),
                alternatives: Array.from({ length: 50 }, (_, i) => ({ name: `alt ${i}`, why: 'because' })),
                alerts: Array.from({ length: 50 }, (_, i) => ({
                    severity: 'low', category: 'other', title: `event ${i}`
                }))
            },
            SOURCES
        );
        expect(result.strengths).toHaveLength(6);
        expect(result.concerns).toHaveLength(6);
        expect(result.alternatives).toHaveLength(5);
        expect(result.alerts).toHaveLength(8);
    });

    it('truncates a runaway string instead of storing it whole', () => {
        const result = normalizeAssessment({ ...good, headline: 'x'.repeat(5000) }, SOURCES);
        expect(result.headline!.length).toBeLessThanOrEqual(200);
        expect(result.headline!.endsWith('…')).toBe(true);
    });

    it('caps the stored source list', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ title: `s${i}`, url: `https://example.test/${i}` }));
        expect(normalizeAssessment(good, many).sources).toHaveLength(12);
    });

    it('resolves a citation beyond the stored cap', () => {
        // Regression: a real grounded call reports ~30 sources and the model
        // cites them by the numbering it was shown. Capping the list before
        // resolving silently dropped every citation past the twelfth — which is
        // most of them.
        const many = Array.from({ length: 30 }, (_, i) => ({ title: `s${i}`, url: `https://example.test/${i}` }));
        const result = normalizeAssessment(
            { ...good, alerts: [{ ...good.alerts[0], sourceIndex: 21 }] },
            many
        );
        expect(result.alerts[0].sourceUrl).toBe('https://example.test/20');
        expect(result.alerts[0].sourceTitle).toBe('s20');
        // ...while storage is still bounded.
        expect(result.sources).toHaveLength(12);
    });

    it('drops an alert whose citation does not exist, keeping the alert itself', () => {
        // Losing the alert would be worse: the event was still reported.
        const result = normalizeAssessment(
            { ...good, alerts: [{ ...good.alerts[0], sourceIndex: 99 }] },
            SOURCES
        );
        expect(result.alerts).toHaveLength(1);
        expect(result.alerts[0].sourceUrl).toBeNull();
    });

    it('refuses a URL the model supplied in place of an index', () => {
        const result = normalizeAssessment(
            { ...good, alerts: [{ ...good.alerts[0], sourceIndex: 'https://hallucinated.test/story' }] },
            SOURCES
        );
        expect(result.alerts[0].sourceUrl).toBeNull();
    });

    it('drops alerts and alternatives with no title or name at all', () => {
        const result = normalizeAssessment(
            {
                ...good,
                alerts: [{ severity: 'high', category: 'security', title: '   ' }],
                alternatives: [{ vendor: 'Nobody', why: 'unnamed' }]
            },
            SOURCES
        );
        expect(result.alerts).toEqual([]);
        expect(result.alternatives).toEqual([]);
    });

    it('merges duplicate reports of one event', () => {
        const result = normalizeAssessment(
            {
                ...good,
                alerts: [
                    { severity: 'critical', category: 'security', title: 'RCE exploited in the wild' },
                    { severity: 'high', category: 'security', title: 'RCE exploited in the wild.' }
                ]
            },
            SOURCES
        );
        expect(result.alerts).toHaveLength(1);
    });

    it('orders alerts by severity so the page never has to', () => {
        const result = normalizeAssessment(
            {
                ...good,
                alerts: [
                    { severity: 'low', category: 'other', title: 'Minor thing' },
                    { severity: 'critical', category: 'security', title: 'Major thing' },
                    { severity: 'medium', category: 'strategy', title: 'Middling thing' }
                ]
            },
            SOURCES
        );
        expect(result.alerts.map(a => a.severity)).toEqual(['critical', 'medium', 'low']);
    });

    it('reads the literal string "null" as an absent value', () => {
        // Models emit it when asked for "vendor or null" inside a JSON string.
        expect(normalizeAssessment({ ...good, vendor: 'null' }, SOURCES).vendor).toBeNull();
    });
});
