import { describe, it, expect } from 'vitest';
import {
    humanizeEnum,
    normalizeFactsheet,
    extractRelations,
    extractSubscriptions,
    buildFactsheetMarkdown,
    factsheetContentHash,
    factsheetFilename,
    factsheetUrl,
    endingMilestone,
    parseLifecyclePhases,
    RELATION_EXAMPLE_LIMIT,
    type LeanixNode
} from './leanix-format';

/**
 * Fixtures are built here rather than checked in from a live capture: the real
 * payload carries staff names and internal application names, and none of that
 * is needed to test shaping. The SHAPES below are the ones the API actually
 * returns (verified against the workspace) — relation connections nested under
 * `edges[].node.factSheet`, lifecycle as `{asString, phases[]}`, `leanixId` as an
 * ExternalId object rather than a string.
 */
const relConn = (items: { id: string; name: string; type: string }[]) => ({
    edges: items.map(factSheet => ({ node: { factSheet } }))
});

const itComponent = (over: Partial<LeanixNode> = {}): LeanixNode => ({
    id: 'fs-itc-1',
    type: 'ITComponent',
    name: 'Example Platform',
    displayName: 'Vendor Example Platform',
    description: 'A platform used for examples.',
    alias: 'EXPL',
    level: 2,
    updatedAt: '2026-08-06T14:52:20.413800733Z',
    category: 'itPlatform',
    technicalSuitability: 'fullyAppropriate',
    leanixId: { externalId: 'LX-0001' },
    completion: { completion: 0.82 },
    lifecycle: {
        asString: 'active',
        phases: [
            { phase: 'phaseIn', startDate: '2020-01-01' },
            { phase: 'active', startDate: '2021-06-01' },
            { phase: 'endOfLife', startDate: '2027-12-31' }
        ]
    },
    tags: [
        { id: 'tag-1', name: 'Enterprise', tagGroup: { name: 'SKODA Strategic IT Product' } }
    ],
    documents: { edges: [{ node: { name: 'Architecture overview', url: 'https://example.invalid/doc', documentType: 'link' } }] },
    subscriptions: {
        edges: [
            { node: { type: 'RESPONSIBLE', user: { displayName: 'Jane Doe' }, roles: [{ name: 'Product Manager' }] } },
            { node: { type: 'OBSERVER', user: { displayName: 'Sam Roe' }, roles: [{ name: 'Key User Business' }] } }
        ]
    },
    relITComponentToTechnologyStack: relConn([{ id: 'ts-1', name: 'Compute', type: 'TechnicalStack' }]),
    relITComponentToProvider: relConn([{ id: 'pv-1', name: 'Example Vendor', type: 'Provider' }]),
    ...over
});

describe('humanizeEnum', () => {
    it('turns LeanIX camelCase enums into prose', () => {
        expect(humanizeEnum('fullyAppropriate')).toBe('Fully appropriate');
        expect(humanizeEnum('businessCritical')).toBe('Business critical');
    });

    it('special-cases values that generic splitting would mangle', () => {
        // "itPlatform" would otherwise render as "It platform".
        expect(humanizeEnum('itPlatform')).toBe('IT platform');
        expect(humanizeEnum('endOfLife')).toBe('End of life');
        expect(humanizeEnum('phaseOut')).toBe('Phase out');
    });

    it('treats empty and missing values as absent, not as text', () => {
        expect(humanizeEnum(null)).toBeNull();
        expect(humanizeEnum('')).toBeNull();
        expect(humanizeEnum('   ')).toBeNull();
    });
});

describe('normalizeFactsheet', () => {
    it('flattens the nested API shapes into columns', () => {
        const row = normalizeFactsheet(itComponent());
        expect(row.id).toBe('fs-itc-1');
        expect(row.leanix_id).toBe('LX-0001');
        expect(row.lifecycle_state).toBe('active');
        expect(row.completion).toBe(0.82);
        expect(JSON.parse(row.tags!)).toEqual([
            { id: 'tag-1', name: 'Enterprise', group: 'SKODA Strategic IT Product' }
        ]);
    });

    it('lifts the end-of-life date out of the phase list', () => {
        // "When does this expire" is a portfolio question, and answering it from
        // a JSON blob in SQL would mean scanning every row's phases.
        expect(normalizeFactsheet(itComponent()).end_of_life_date).toBe('2027-12-31');
    });

    it('leaves end_of_life_date null when the phase is absent', () => {
        const row = normalizeFactsheet(
            itComponent({ lifecycle: { asString: 'active', phases: [{ phase: 'active', startDate: '2021-06-01' }] } })
        );
        expect(row.end_of_life_date).toBeNull();
    });

    it('normalizes blank strings to null so "not set" is one value, not two', () => {
        const row = normalizeFactsheet(itComponent({ alias: '   ', description: '', release: null }));
        expect(row.alias).toBeNull();
        expect(row.description).toBeNull();
        expect(row.release).toBeNull();
    });

    it('survives a factsheet with every optional field missing', () => {
        const bare: LeanixNode = { id: 'x', type: 'ITComponent', name: 'Bare' };
        const row = normalizeFactsheet(bare);
        expect(row.name).toBe('Bare');
        expect(row.lifecycle_phases).toBeNull();
        expect(row.documents).toBeNull();
        expect(row.completion).toBeNull();
    });
});

describe('extractRelations', () => {
    it('flattens every configured relation field', () => {
        const rels = extractRelations(itComponent());
        expect(rels).toContainEqual({
            from_id: 'fs-itc-1',
            rel_type: 'relITComponentToProvider',
            to_id: 'pv-1',
            to_name: 'Example Vendor',
            to_type: 'Provider'
        });
        expect(rels.filter(r => r.rel_type === 'relITComponentToTechnologyStack')).toHaveLength(1);
    });

    it('skips edges with no target factsheet instead of writing null ids', () => {
        const node = itComponent({
            relITComponentToProvider: { edges: [{ node: { factSheet: null } }, null] }
        } as Partial<LeanixNode>);
        expect(extractRelations(node).filter(r => r.rel_type === 'relITComponentToProvider')).toHaveLength(0);
    });
});

describe('extractSubscriptions', () => {
    it('records role and person but never an email', () => {
        const subs = extractSubscriptions(itComponent());
        expect(subs).toContainEqual({
            factsheet_id: 'fs-itc-1',
            subscription_type: 'RESPONSIBLE',
            role_name: 'Product Manager',
            display_name: 'Jane Doe'
        });
        expect(JSON.stringify(subs)).not.toContain('@');
    });

    it('expands a multi-role subscription into one row per role', () => {
        const node = itComponent({
            subscriptions: {
                edges: [
                    {
                        node: {
                            type: 'RESPONSIBLE',
                            user: { displayName: 'Jane Doe' },
                            roles: [{ name: 'Product Manager' }, { name: 'Service Manager' }]
                        }
                    }
                ]
            }
        });
        expect(extractSubscriptions(node)).toHaveLength(2);
    });

    it('deduplicates identical rows so the composite primary key cannot collide', () => {
        // SQLite treats NULLs as distinct in a unique index, so an unnamed and
        // unroled subscriber repeated across the payload would insert twice.
        const node = itComponent({
            subscriptions: {
                edges: [
                    { node: { type: 'OBSERVER', user: null, roles: [] } },
                    { node: { type: 'OBSERVER', user: null, roles: [] } }
                ]
            }
        });
        expect(extractSubscriptions(node)).toHaveLength(1);
    });
});

describe('buildFactsheetMarkdown', () => {
    const render = (node: LeanixNode = itComponent()) => {
        const row = normalizeFactsheet(node);
        return buildFactsheetMarkdown(row, extractRelations(node), extractSubscriptions(node));
    };

    it('leads with a self-describing sentence for retrieval', () => {
        const md = render();
        expect(md).toContain('# Example Platform');
        expect(md).toContain('**Example Platform** is a LeanIX it component factsheet in the IT platform category with lifecycle state Active.');
    });

    it('renders the requested portfolio attributes in prose form', () => {
        const md = render();
        expect(md).toContain('- **Technical fit:** Fully appropriate');
        expect(md).toContain('- **Lifecycle state:** Active');
        expect(md).toContain('- **End of life:** 2027-12-31');
        expect(md).toContain('- **Tags:** SKODA Strategic IT Product: Enterprise');
        expect(md).toContain('- **Technology capabilities:** Compute');
        expect(md).toContain('- **Vendor:** Example Vendor');
    });

    it('omits attributes that are not set rather than printing empty labels', () => {
        const md = render(itComponent({ technicalSuitability: null, description: null }));
        expect(md).not.toContain('Technical fit');
        expect(md).not.toContain('undefined');
        expect(md).not.toContain('null');
    });

    it('summarizes a high fan-out relation as a count plus examples', () => {
        // The live workspace has a platform with 974 dependent applications;
        // inlining those would swamp the document and the knowledge graph.
        const apps = Array.from({ length: 974 }, (_, i) => ({
            id: `app-${i}`,
            name: `Application ${i}`,
            type: 'Application'
        }));
        const md = render(itComponent({ relITComponentToApplication: relConn(apps) }));

        expect(md).toContain('974 in total, including Application 0');
        expect(md).toContain(`(and ${974 - RELATION_EXAMPLE_LIMIT} more)`);
        expect(md).not.toContain('Application 500');
        // The whole point of the cap: the document stays a document.
        expect(md.length).toBeLessThan(4000);
    });

    it('lists a small relation set in full', () => {
        const apps = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, name: `App ${i}`, type: 'Application' }));
        const md = render(itComponent({ relITComponentToApplication: relConn(apps) }));
        expect(md).toContain('- **Used by applications:** App 0, App 1, App 2');
        expect(md).not.toContain('in total');
    });

    it('includes responsible ROLES but no person names', () => {
        const md = render();
        expect(md).toContain('- **Responsible roles:** Product Manager');
        expect(md).not.toContain('Jane Doe');
        expect(md).not.toContain('Sam Roe');
    });

    it('never leaves a run of blank lines that would split a chunk oddly', () => {
        expect(render()).not.toMatch(/\n{3,}/);
    });

    it('carries a link back to LeanIX when the workspace URL is known', () => {
        // A chat answer citing this factsheet should be able to hand the reader
        // the source, so the link lives in the document, not only in the UI.
        const node = itComponent();
        const md = buildFactsheetMarkdown(
            normalizeFactsheet(node),
            extractRelations(node),
            extractSubscriptions(node),
            'https://vwgroup.leanix.net/Volkswagen'
        );
        expect(md).toContain('- **Open in LeanIX:** https://vwgroup.leanix.net/Volkswagen/factsheet/ITComponent/fs-itc-1');
    });

    it('omits the link rather than emitting a broken one when it is unknown', () => {
        expect(render()).not.toContain('Open in LeanIX');
    });
});

describe('factsheetContentHash', () => {
    it('is stable for identical rendered content', () => {
        const node = itComponent();
        const a = buildFactsheetMarkdown(normalizeFactsheet(node), extractRelations(node));
        const b = buildFactsheetMarkdown(normalizeFactsheet(itComponent()), extractRelations(itComponent()));
        expect(factsheetContentHash(a)).toBe(factsheetContentHash(b));
    });

    it('ignores remote edits that do not change what we ingest', () => {
        // updatedAt moves whenever anyone touches the factsheet in LeanIX,
        // including fields this integration never reads. Hashing the rendered
        // markdown is what keeps the daily sync from re-ingesting on such edits.
        const before = itComponent();
        const after = itComponent({ updatedAt: '2026-08-09T09:00:00.000Z' });
        const md = (n: LeanixNode) => buildFactsheetMarkdown(normalizeFactsheet(n), extractRelations(n));
        expect(factsheetContentHash(md(before))).toBe(factsheetContentHash(md(after)));
    });

    it('changes when a portfolio attribute changes', () => {
        const before = itComponent();
        const after = itComponent({ technicalSuitability: 'adequate' });
        const md = (n: LeanixNode) => buildFactsheetMarkdown(normalizeFactsheet(n), extractRelations(n));
        expect(factsheetContentHash(md(before))).not.toBe(factsheetContentHash(md(after)));
    });
});

describe('endingMilestone — which date the roadmap should actually plot', () => {
    /** Shorthand for the stored JSON column. */
    const phases = (...pairs: [string, string][]) =>
        JSON.stringify(pairs.map(([phase, startDate]) => ({ phase, startDate })));

    it('finds an ending that only the phases record', () => {
        // The five factsheets that appeared on no timeline at all: a dated
        // phase-out with the end_of_life_date column left unset.
        const m = endingMilestone({
            end_of_life_date: null,
            lifecycle_phases: phases(['active', '2017-01-01'], ['phaseOut', '2027-12-31'])
        });
        expect(m).toEqual({ date: '2027-12-31', kind: 'phaseOut', label: 'Phase-out' });
    });

    it('prefers the earlier phase-out to the later end-of-life column', () => {
        // The regression that mattered most: DevOps Server read as a 2030
        // problem while it had been phasing out since October 2025.
        const m = endingMilestone({
            end_of_life_date: '2030-10-08',
            lifecycle_phases: phases(['active', '2020-08-25'], ['phaseOut', '2025-10-14'])
        });
        expect(m?.date).toBe('2025-10-14');
        expect(m?.kind).toBe('phaseOut');
    });

    it('falls back to the column when the phases say nothing about an ending', () => {
        const m = endingMilestone({
            end_of_life_date: '2029-12-31',
            lifecycle_phases: phases(['active', '2020-01-01'])
        });
        expect(m).toEqual({ date: '2029-12-31', kind: 'endOfLife', label: 'End of life' });
    });

    it('breaks a same-day tie towards the phase that starts the work', () => {
        const m = endingMilestone({
            end_of_life_date: '2029-12-31',
            lifecycle_phases: phases(['phaseOut', '2029-12-31'], ['endOfLife', '2029-12-31'])
        });
        expect(m?.kind).toBe('phaseOut');
    });

    it('ignores phases that are not endings', () => {
        expect(endingMilestone({
            end_of_life_date: null,
            lifecycle_phases: phases(['plan', '2020-07-01'], ['phaseIn', '2020-07-31'], ['active', '2020-08-31'])
        })).toBeNull();
    });

    it('returns nothing for a factsheet with no dated ending', () => {
        expect(endingMilestone({ end_of_life_date: null, lifecycle_phases: null })).toBeNull();
        expect(endingMilestone({})).toBeNull();
    });

    it('trims a stored timestamp to a date', () => {
        expect(endingMilestone({ end_of_life_date: '2028-11-30T00:00:00Z' })?.date).toBe('2028-11-30');
    });
});

describe('parseLifecyclePhases', () => {
    it('survives unreadable or unexpected column contents', () => {
        for (const raw of [null, undefined, '', 'not json', '{}', '[1,2]', '[{"phase":"active"}]']) {
            expect(() => parseLifecyclePhases(raw)).not.toThrow();
            expect(parseLifecyclePhases(raw)).toEqual([]);
        }
    });

    it('drops entries whose date is too short to be a date', () => {
        expect(parseLifecyclePhases('[{"phase":"phaseOut","startDate":"2027"}]')).toEqual([]);
    });
});

describe('factsheetFilename / factsheetUrl', () => {
    it('strips characters that are illegal in a filename', () => {
        expect(factsheetFilename({ fs_type: 'ITComponent', name: 'A/B: C*?' })).toBe('LeanIX ITComponent — A-B- C--.md');
    });

    it('returns null when no workspace URL is configured', () => {
        // The .env holds an API gateway address, which is not a browsable URL —
        // guessing one produces citations that 404.
        expect(factsheetUrl({ id: 'x', fs_type: 'ITComponent' }, undefined)).toBeNull();
        expect(factsheetUrl({ id: 'x', fs_type: 'ITComponent' }, '  ')).toBeNull();
    });

    it('builds a factsheet deep link when configured', () => {
        expect(factsheetUrl({ id: 'x', fs_type: 'ITComponent' }, 'https://skoda.leanix.net/skoda/')).toBe(
            'https://skoda.leanix.net/skoda/factsheet/ITComponent/x'
        );
    });
});
