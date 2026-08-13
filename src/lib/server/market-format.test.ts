import { describe, it, expect } from 'vitest';
import {
    ALERT_CATEGORIES,
    ALERT_WINDOW_MONTHS,
    LOOKBACK_MONTHS,
    MAX_PRODUCT_NAME_LENGTH,
    MAX_PRODUCT_NAME_WORDS,
    NO_PUBLIC_INFORMATION,
    PUBLIC_IDENTITY_FIELDS,
    SEVERITIES,
    VERDICTS,
    alertCutoffDate,
    alertFingerprint,
    applyIdentity,
    briefIsEmpty,
    buildAssessmentPrompt,
    buildIdentityPrompt,
    buildResearchPrompt,
    buildSubject,
    exposureScore,
    isCurrentEvent,
    normalizeAssessment,
    normalizeEventDate,
    normalizeIdentity,
    researchInputHash,
    resolveSource,
    selectDue,
    severityRank,
    stripLocalQualifiers,
    type IdentityInput,
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

/** Fixed "today" for every recency assertion, so none of them rot. */
const TODAY = Date.UTC(2026, 7, 13); // 2026-08-13

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

    it('cannot reach the description, which only the identity call sees', () => {
        // MarketSubject has no description field, so the free text is not merely
        // left out of this prompt — it is unreachable from it. The identity call
        // is the single controlled channel between the two, and it may return a
        // product NAME and nothing longer (see normalizeIdentity).
        const withDescription = subject() as MarketSubject & { description?: string };
        withDescription.description = 'INTERNAL_DESCRIPTION_MARKER';
        expect(buildResearchPrompt(withDescription)).not.toContain('INTERNAL_DESCRIPTION_MARKER');
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

    it('asks for alerts on the alert window, not the brief window', () => {
        const prompt = buildAssessmentPrompt(subject(), 'A brief.', SOURCES, context);
        expect(prompt).toContain(`last ${ALERT_WINDOW_MONTHS} months`);
        expect(prompt).toContain('Every alert MUST carry a date');
    });
});

describe('stripLocalQualifiers', () => {
    it('removes the organisation name wherever it sits in the name', () => {
        expect(stripLocalQualifiers('AWS Cloud Škoda')).toBe('AWS Cloud');
        expect(stripLocalQualifiers('SKODA OpenShift Container Platform')).toBe('OpenShift Container Platform');
        expect(stripLocalQualifiers('Skoda PostgreSQL platform')).toBe('PostgreSQL platform');
    });

    it('removes a hosting suffix', () => {
        expect(stripLocalQualifiers('Power BI SaaS Hosting')).toBe('Power BI');
        expect(stripLocalQualifiers('Exchange Online SaaS Hosting')).toBe('Exchange Online');
    });

    it('leaves a name that is already public alone', () => {
        expect(stripLocalQualifiers('MongoDB')).toBe('MongoDB');
        expect(stripLocalQualifiers('Adobe Experience Manager as a Cloud Service'))
            .toBe('Adobe Experience Manager as a Cloud Service');
    });

    it('keeps generic product words that real names are built from', () => {
        // Stripping "Platform" here would break more searches than it fixed.
        expect(stripLocalQualifiers('Power Platform')).toBe('Power Platform');
    });

    it('never strips a name down to nothing', () => {
        expect(stripLocalQualifiers('Škoda')).toBe('Škoda');
    });
});

describe('buildIdentityPrompt — the one call that sees the description', () => {
    const record: IdentityInput = {
        fsType: 'ITComponent',
        name: 'Skoda MongoDB platform',
        alias: null,
        vendor: null,
        category: 'itPlatform',
        description: 'Infrastructure for MongoDB'
    };

    it('shows the description, which is why this call exists', () => {
        const prompt = buildIdentityPrompt(record);
        expect(prompt).toContain('Infrastructure for MongoDB');
        expect(prompt).toContain('Skoda MongoDB platform');
    });

    it('states the bound the answer will be held to', () => {
        expect(buildIdentityPrompt(record)).toContain(String(MAX_PRODUCT_NAME_WORDS));
    });

    it('offers the in-house answer explicitly', () => {
        expect(buildIdentityPrompt(record)).toContain('inHouse');
    });

    it('omits the lines it has nothing for', () => {
        const bare = buildIdentityPrompt({ ...record, description: null, category: null });
        expect(bare).not.toContain('Description:');
        expect(bare).not.toContain('Recorded category:');
    });
});

describe('normalizeIdentity — what may become a search query', () => {
    it('accepts a plain product name', () => {
        const id = normalizeIdentity({ product: 'MongoDB', vendor: 'MongoDB Inc.', inHouse: false, note: 'named in description' });
        expect(id.product).toBe('MongoDB');
        expect(id.vendor).toBe('MongoDB Inc.');
        expect(id.inHouse).toBe(false);
    });

    // The containment tests. The description is internal free text, and a
    // product name is the only thing allowed to be derived from it — so an
    // answer shaped like prose is refused outright rather than trimmed, because
    // a trimmed sentence is still a sentence leaving the building.
    it('refuses an answer long enough to be prose', () => {
        const sentence = 'A big data platform built on Cloudera and used by the group for controlling and production analytics';
        expect(sentence.length).toBeGreaterThan(MAX_PRODUCT_NAME_LENGTH);
        expect(normalizeIdentity({ product: sentence }).product).toBeNull();
    });

    it('refuses an answer with too many words even when it is short', () => {
        const wordy = Array.from({ length: MAX_PRODUCT_NAME_WORDS + 1 }, () => 'a').join(' ');
        expect(wordy.length).toBeLessThan(MAX_PRODUCT_NAME_LENGTH);
        expect(normalizeIdentity({ product: wordy }).product).toBeNull();
    });

    it('refuses a multi-line answer', () => {
        expect(normalizeIdentity({ product: 'MongoDB\nInternal notes: owned by DBA team' }).product).toBeNull();
    });

    it('drops the product when the answer says the record is in-house', () => {
        // The two halves contradict each other; the in-house verdict is the one
        // that decides whether a billed search is spent.
        const id = normalizeIdentity({ product: 'Cloudera', inHouse: true });
        expect(id.inHouse).toBe(true);
        expect(id.product).toBeNull();
    });

    it('survives garbage without throwing', () => {
        for (const input of [null, undefined, 'a string', 42, []]) {
            expect(() => normalizeIdentity(input)).not.toThrow();
            expect(normalizeIdentity(input).product).toBeNull();
            expect(normalizeIdentity(input).inHouse).toBe(false);
        }
    });
});

describe('applyIdentity', () => {
    it('searches for the resolved product instead of the local label', () => {
        const local = subject({ name: 'Skoda PostgreSQL platform', vendor: null, label: 'Skoda PostgreSQL platform' });
        const resolved = applyIdentity(local, {
            product: 'PostgreSQL', vendor: 'PostgreSQL Global Development Group', inHouse: false, note: null
        });
        expect(resolved.name).toBe('PostgreSQL');
        expect(resolved.label).toBe('PostgreSQL (PostgreSQL Global Development Group)');
    });

    it('drops the local name rather than keeping it as a second identifier', () => {
        // Carrying "Skoda PostgreSQL platform" alongside "PostgreSQL" would drag
        // the search back to the label that found nothing.
        const local = subject({ name: 'Skoda PostgreSQL platform', alias: 'Skoda PostgreSQL platform' });
        const resolved = applyIdentity(local, { product: 'PostgreSQL', vendor: null, inHouse: false, note: null });
        expect(buildResearchPrompt(resolved)).not.toContain('Skoda');
    });

    it('keeps an alias that still says something the resolved name does not', () => {
        const local = subject({ name: 'Database', alias: 'Oracle' });
        const resolved = applyIdentity(local, { product: 'Oracle Database', vendor: 'Oracle', inHouse: false, note: null });
        expect(resolved.alias).toBe('Oracle');
    });

    it('leaves an in-house record exactly as it was', () => {
        const local = subject({ name: 'SKODA Flow Web Library' });
        expect(applyIdentity(local, { product: null, vendor: null, inHouse: true, note: null })).toEqual(local);
    });

    it('falls back to stripping local decoration when nothing was resolved', () => {
        // The floor: a failed or unhelpful identity call still leaves a better
        // search subject than the raw label, never a worse one.
        const local = subject({ name: 'Power BI SaaS Hosting', vendor: 'Microsoft' });
        const resolved = applyIdentity(local, { product: null, vendor: null, inHouse: false, note: null });
        expect(resolved.name).toBe('Power BI');
        expect(resolved.vendor).toBe('Microsoft');
    });

    it('changes nothing when there is no local decoration to strip', () => {
        const clean = subject({ name: 'MongoDB' });
        expect(applyIdentity(clean, { product: null, vendor: null, inHouse: false, note: null })).toEqual(clean);
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

    it('changes when the description changes', () => {
        // The description decides WHICH product gets searched for, so an edit to
        // it can turn an unresearchable record into a researchable one.
        const base = researchInputHash(subject(), 'Central log platform');
        expect(researchInputHash(subject(), 'Infrastructure for Elasticsearch')).not.toBe(base);
    });

    it('treats a blank description as no description', () => {
        expect(researchInputHash(subject(), '   ')).toBe(researchInputHash(subject()));
        expect(researchInputHash(subject(), null)).toBe(researchInputHash(subject()));
    });

    it('ignores fields that do not change what is being researched', () => {
        // A renamed owner or a re-rated fit must not spend a search.
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
            row.input_hash = researchInputHash(buildSubject(row, row.vendor), row.description);
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

    it('re-researches when only the description changed', () => {
        const row = candidate({ description: 'Central log platform' });
        const edited = { ...row, description: 'Infrastructure for Elasticsearch' };
        expect(selectDue([edited], OPTIONS)[0].reason).toBe('changed');
    });

    it('leaves a factsheet with no public product alone for far longer', () => {
        // Re-asking "is this still an in-house system?" every seven days is what
        // starved the well-known products of a batch slot.
        const inHouse = candidate({ identified: 0, researched_at_ms: NOW - 30 * DAY });
        expect(selectDue([inHouse], { ...OPTIONS, unidentifiedTtlMs: 60 * DAY })).toEqual([]);
        expect(selectDue([inHouse], { ...OPTIONS, unidentifiedTtlMs: 14 * DAY })[0].reason).toBe('stale');
    });

    it('still refreshes an identified factsheet on the ordinary TTL', () => {
        const identified = candidate({ identified: 1, researched_at_ms: NOW - 8 * DAY });
        expect(selectDue([identified], { ...OPTIONS, unidentifiedTtlMs: 60 * DAY })[0].reason).toBe('stale');
    });

    it('does not let the longer clock swallow a failed attempt', () => {
        // A failure also stores identified = 0. Reading that as "in-house" would
        // park a transient provider error for two months.
        const failed = candidate({ identified: 0, had_error: 1, researched_at_ms: NOW - 7 * HOUR });
        expect(selectDue([failed], { ...OPTIONS, unidentifiedTtlMs: 60 * DAY })[0].reason).toBe('retry');
    });

    it('covers the heaviest factsheets first within a due reason', () => {
        // A capped first run reaching the platform that carries 974 applications
        // on day one is worth more than one that reaches it alphabetically.
        const rows = [
            candidate({ id: 'tail', name: 'Zeta', priority: 1, researched_at_ms: null, input_hash: null }),
            candidate({ id: 'platform', name: 'Alpha', priority: 974, researched_at_ms: null, input_hash: null }),
            candidate({ id: 'middle', name: 'Beta', priority: 40, researched_at_ms: null, input_hash: null })
        ];
        expect(selectDue(rows, OPTIONS).map(c => c.row.id)).toEqual(['platform', 'middle', 'tail']);
    });

    it('still falls back to oldest first when weights tie', () => {
        const rows = [
            candidate({ id: 'recent', priority: 5, researched_at_ms: NOW - 8 * DAY }),
            candidate({ id: 'ancient', priority: 5, researched_at_ms: NOW - 60 * DAY })
        ];
        expect(selectDue(rows, OPTIONS).map(c => c.row.id)).toEqual(['ancient', 'recent']);
    });

    it('hands back the subject and hash it decided with', () => {
        // The caller stores this hash; recomputing it there could disagree.
        const due = selectDue([candidate({ researched_at_ms: null, input_hash: null })], OPTIONS);
        expect(due[0].subject.label).toBe('Confluence (Atlassian)');
        expect(due[0].hash).toBe(researchInputHash(due[0].subject, due[0].row.description));
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

describe('exposureScore — severity weighted by blast radius', () => {
    it('keeps severity dominant at comparable reach', () => {
        expect(exposureScore('critical', 50)).toBeGreaterThan(exposureScore('high', 50));
        expect(exposureScore('high', 50)).toBeGreaterThan(exposureScore('medium', 50));
        expect(exposureScore('medium', 50)).toBeGreaterThan(exposureScore('low', 50));
    });

    it('ranks the wider-reaching of two equally severe alerts first', () => {
        expect(exposureScore('critical', 974)).toBeGreaterThan(exposureScore('critical', 9));
    });

    it('does not let a critical on 9 apps outrank a high on 187', () => {
        // Never mind: it should. This is the case the metric was added for, and
        // the answer is that a critical still wins — an actively exploited
        // vulnerability outranks a scheduled end of support even at 20x the
        // reach. What changes is that the reach is now visible and part of the
        // sort, rather than absent from both.
        expect(exposureScore('critical', 9)).toBeGreaterThan(exposureScore('high', 187));
    });

    it('lets reach cross a band boundary only at genuine scale', () => {
        // The documented crossover: a high needs on the order of a thousand
        // dependent applications to outrank a critical with none recorded.
        expect(exposureScore('high', 974)).toBeGreaterThan(exposureScore('critical', 0));
        expect(exposureScore('high', 100)).toBeLessThan(exposureScore('critical', 0));
    });

    it('never lets reach promote a low over a critical', () => {
        // The damping is what guarantees this: log10 of any realistic portfolio
        // cannot close a 100x weight gap.
        expect(exposureScore('low', 1_000_000)).toBeLessThan(exposureScore('critical', 0));
    });

    it('scores a zero-reach alert on its severity alone', () => {
        // No recorded dependants is not evidence that nothing depends on it.
        expect(exposureScore('critical', 0)).toBe(1000);
    });

    it('treats an unknown severity as below low rather than mid-scale', () => {
        expect(exposureScore('apocalyptic', 0)).toBeLessThan(exposureScore('low', 0));
    });

    it('survives a missing or nonsensical reach', () => {
        for (const reach of [0, -5, NaN, Infinity]) {
            expect(Number.isFinite(exposureScore('high', reach as number))).toBe(true);
        }
        expect(exposureScore('high', -5)).toBe(exposureScore('high', 0));
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
    /** Pinned to TODAY so the recency rule cannot make these tests rot. */
    const normalize = (raw: unknown, sources: GroundedSource[] = SOURCES) =>
        normalizeAssessment(raw, sources, { now: TODAY });

    /** A date comfortably inside the alert window relative to TODAY. */
    const RECENT = '2026-07-01';

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
        const result = normalize(good);
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
        const result = normalize(
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
        expect(normalize({}).identified).toBe(false);
        expect(normalize({ alerts: [] }).identified).toBe(false);
    });

    it('survives garbage without throwing', () => {
        for (const input of [null, undefined, 'a string', 42, []]) {
            expect(() => normalize(input)).not.toThrow();
            expect(normalize(input).identified).toBe(false);
        }
    });

    it('folds unknown enum values to a safe default rather than storing them', () => {
        const result = normalize(
            {
                ...good,
                verdict: 'catastrophic',
                alerts: [{ severity: 'apocalyptic', category: 'meteor', title: 'Something happened', date: RECENT }],
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
        const result = normalize({ ...good, verdict: 'Best-in class' });
        expect(result.verdict).toBe('best_in_class');
    });

    it('clamps confidence into range and drops non-numbers', () => {
        expect(normalize({ ...good, confidence: 4 }).confidence).toBe(1);
        expect(normalize({ ...good, confidence: -2 }).confidence).toBe(0);
        expect(normalize({ ...good, confidence: 'high' }).confidence).toBeNull();
    });

    it('caps every unbounded array', () => {
        const result = normalize(
            {
                ...good,
                strengths: Array.from({ length: 50 }, (_, i) => `strength ${i}`),
                concerns: Array.from({ length: 50 }, (_, i) => `concern ${i}`),
                alternatives: Array.from({ length: 50 }, (_, i) => ({ name: `alt ${i}`, why: 'because' })),
                alerts: Array.from({ length: 50 }, (_, i) => ({
                    severity: 'low', category: 'other', title: `event ${i}`, date: RECENT
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
        const result = normalize({ ...good, headline: 'x'.repeat(5000) });
        expect(result.headline!.length).toBeLessThanOrEqual(200);
        expect(result.headline!.endsWith('…')).toBe(true);
    });

    it('caps the stored source list', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ title: `s${i}`, url: `https://example.test/${i}` }));
        expect(normalize(good, many).sources).toHaveLength(12);
    });

    it('resolves a citation beyond the stored cap', () => {
        // Regression: a real grounded call reports ~30 sources and the model
        // cites them by the numbering it was shown. Capping the list before
        // resolving silently dropped every citation past the twelfth — which is
        // most of them.
        const many = Array.from({ length: 30 }, (_, i) => ({ title: `s${i}`, url: `https://example.test/${i}` }));
        const result = normalize(
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
        const result = normalize(
            { ...good, alerts: [{ ...good.alerts[0], sourceIndex: 99 }] },
            SOURCES
        );
        expect(result.alerts).toHaveLength(1);
        expect(result.alerts[0].sourceUrl).toBeNull();
    });

    it('refuses a URL the model supplied in place of an index', () => {
        const result = normalize(
            { ...good, alerts: [{ ...good.alerts[0], sourceIndex: 'https://hallucinated.test/story' }] },
            SOURCES
        );
        expect(result.alerts[0].sourceUrl).toBeNull();
    });

    it('drops alerts and alternatives with no title or name at all', () => {
        const result = normalize(
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
        const result = normalize(
            {
                ...good,
                alerts: [
                    { severity: 'critical', category: 'security', title: 'RCE exploited in the wild', date: RECENT },
                    { severity: 'high', category: 'security', title: 'RCE exploited in the wild.', date: RECENT }
                ]
            },
            SOURCES
        );
        expect(result.alerts).toHaveLength(1);
    });

    it('orders alerts by severity so the page never has to', () => {
        const result = normalize(
            {
                ...good,
                alerts: [
                    { severity: 'low', category: 'other', title: 'Minor thing', date: RECENT },
                    { severity: 'critical', category: 'security', title: 'Major thing', date: RECENT },
                    { severity: 'medium', category: 'strategy', title: 'Middling thing', date: RECENT }
                ]
            },
            SOURCES
        );
        expect(result.alerts.map(a => a.severity)).toEqual(['critical', 'medium', 'low']);
    });

    it('reads the literal string "null" as an absent value', () => {
        // Models emit it when asked for "vendor or null" inside a JSON string.
        expect(normalize({ ...good, vendor: 'null' }).vendor).toBeNull();
    });

    // ── Recency ─────────────────────────────────────────────────────────────
    // An alert claims something is a live risk. These are the tests that stop a
    // year-old patched CVE from making that claim.

    it('drops an event older than the alert window', () => {
        const result = normalize({
            ...good,
            alerts: [{ severity: 'critical', category: 'security', title: 'RCE patched long ago', date: '2025-10-14' }]
        });
        expect(result.alerts).toEqual([]);
        // The assessment itself survives — the history is still weighed, it is
        // simply not an alert.
        expect(result.identified).toBe(true);
        expect(result.verdict).toBe('solid');
    });

    it('drops an undated event, however serious it sounds', () => {
        const result = normalize({
            ...good,
            alerts: [{ severity: 'critical', category: 'data_breach', title: 'Customer data exposed' }]
        });
        expect(result.alerts).toEqual([]);
    });

    it('keeps a dated announcement about the future', () => {
        // An end-of-support date still to come is the most actionable alert
        // there is; a lower bound must not exclude it.
        const result = normalize({
            ...good,
            alerts: [{ severity: 'high', category: 'end_of_life', title: 'Support ends', date: '2027-11-10' }]
        });
        expect(result.alerts).toHaveLength(1);
    });

    it('keeps the current telling of an event whose stale twin came first', () => {
        // Fingerprints are claimed only by alerts that survive the date check,
        // so an undated retelling listed first cannot shadow the dated one.
        const result = normalize({
            ...good,
            alerts: [
                { severity: 'low', category: 'security', title: 'Zero-day exploited' },
                { severity: 'critical', category: 'security', title: 'Zero-day exploited', date: RECENT }
            ]
        });
        expect(result.alerts).toHaveLength(1);
        expect(result.alerts[0].severity).toBe('critical');
        expect(result.alerts[0].date).toBe(RECENT);
    });

    it('judges a coarse date by the last day it could mean', () => {
        // "2026" from a model that only knows the year must not be read as the
        // 1st of January and thrown away.
        expect(normalize({ ...good, alerts: [{ ...good.alerts[0], date: '2026' }] }).alerts).toHaveLength(1);
        expect(normalize({ ...good, alerts: [{ ...good.alerts[0], date: '2024' }] }).alerts).toEqual([]);
    });
});

describe('isCurrentEvent', () => {
    it('accepts an event inside the window and rejects one outside it', () => {
        expect(isCurrentEvent('2026-07-01', TODAY)).toBe(true);
        expect(isCurrentEvent('2025-10-14', TODAY)).toBe(false);
    });

    it('is inclusive at the cutoff itself', () => {
        expect(isCurrentEvent(alertCutoffDate(TODAY), TODAY)).toBe(true);
    });

    it('never treats an undated event as current', () => {
        expect(isCurrentEvent(null, TODAY)).toBe(false);
        expect(isCurrentEvent(undefined, TODAY)).toBe(false);
        expect(isCurrentEvent('', TODAY)).toBe(false);
    });

    it('widens a coarse date to its last instant', () => {
        // The cutoff for TODAY falls in February 2026, so the month it lands in
        // has to pass on the strength of its final day.
        expect(isCurrentEvent('2026-02', TODAY)).toBe(true);
        expect(isCurrentEvent('2025-12', TODAY)).toBe(false);
    });

    it('is far narrower than the brief it filters', () => {
        expect(ALERT_WINDOW_MONTHS).toBeLessThan(LOOKBACK_MONTHS);
    });
});

describe('alertCutoffDate', () => {
    it('steps back whole months in UTC', () => {
        expect(alertCutoffDate(Date.UTC(2026, 7, 13), 6)).toBe('2026-02-13');
        expect(alertCutoffDate(Date.UTC(2026, 1, 10), 6)).toBe('2025-08-10');
    });

    it('clamps rather than rolling forward out of a short month', () => {
        // 31 August minus six months is 28 February, not 3 March.
        expect(alertCutoffDate(Date.UTC(2026, 7, 31), 6)).toBe('2026-02-28');
    });
});
