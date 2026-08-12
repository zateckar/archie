import { db } from './db';
import { humanizeEnum, factsheetUrl } from './leanix-format';
import { getWorkspaceUrl } from './leanix';
import { VERDICT_LABELS, type Verdict } from './market-format';

/**
 * Drill-down behind every number on the portfolio page.
 *
 * Each aggregate in ./leanix-queries answers "how many"; this module answers
 * "which ones" for the same question. The two are deliberately written against
 * the same filters — a drill whose total disagrees with the bar it came from is
 * worse than no drill at all, because the number on screen is what an architect
 * would quote in a meeting. Where an aggregate restricts by factsheet type
 * (component category is components-only, TIME is applications-only), the drill
 * below repeats that restriction rather than reimplementing it loosely.
 *
 * Served on demand from an endpoint rather than shipped with the page. The
 * relation table holds ~5200 edges and one platform alone carries 974
 * applications; precomputing every drill would add hundreds of kilobytes to a
 * page load in order to answer a question most visitors never ask.
 */

/** One row in a drill result — a factsheet, or a group when drilling a count of distinct values. */
export interface DrillItem {
    /** Null for group rows (a vendor or capability name is not a factsheet). */
    id: string | null;
    name: string;
    type: string | null;
    lifecycle: string | null;
    url: string | null;
    /** Secondary line: a count for group rows, a category for factsheet rows. */
    note: string | null;
}

export interface DrillResult {
    title: string;
    subtitle: string;
    total: number;
    items: DrillItem[];
    truncated: boolean;
}

/**
 * Rows returned to the browser for one drill. Above this the panel stops being
 * readable long before it stops being expensive, and the total is still exact —
 * only the listing is cut, and the panel says so.
 */
const MAX_ITEMS = 500;

const NOT_SET = 'Not set';

function label(value: string | null | undefined): string {
    return humanizeEnum(value) ?? NOT_SET;
}

/**
 * Matches a column against a key, treating the empty key as SQL NULL.
 *
 * The breakdown queries group by a nullable column and hand the page a bucket
 * whose key is `''` for the null group (labelled "Not set"). Drilling that
 * bucket has to become `IS NULL`, not `= ''`, or the most interesting bucket on
 * a sparsely-filled portfolio silently returns nothing.
 */
function eqOrNull(column: string, key: string): { clause: string; params: string[] } {
    return key === ''
        ? { clause: `${column} IS NULL`, params: [] }
        : { clause: `${column} = ?`, params: [key] };
}

/** Factsheet rows, shaped for the panel. */
function factsheets(where: string, params: unknown[]): DrillItem[] {
    const workspace = getWorkspaceUrl();
    return (db.prepare(`
        SELECT id, name, fs_type, lifecycle_state, category
        FROM leanix_factsheets
        WHERE ${where}
        ORDER BY name COLLATE NOCASE
        LIMIT ${MAX_ITEMS}
    `).all(...params) as any[]).map(r => ({
        id: r.id,
        name: r.name,
        type: r.fs_type,
        lifecycle: label(r.lifecycle_state),
        url: factsheetUrl({ id: r.id, fs_type: r.fs_type }, workspace),
        note: r.fs_type === 'ITComponent' && r.category ? label(r.category) : null
    }));
}

function countWhere(where: string, params: unknown[]): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM leanix_factsheets WHERE ${where}`)
        .get(...params) as { c: number }).c;
}

/** A drill that resolves to a set of factsheets. */
function factsheetDrill(title: string, subtitle: string, where: string, params: unknown[]): DrillResult {
    const total = countWhere(where, params);
    const items = factsheets(where, params);
    return { title, subtitle, total, items, truncated: total > items.length };
}

/** Every factsheet on the far end of one relation type. */
function relationDrill(
    title: string,
    subtitle: string,
    where: string,
    params: unknown[]
): DrillResult {
    const workspace = getWorkspaceUrl();
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM leanix_relations r WHERE ${where}`)
        .get(...params) as { c: number }).c;

    // The far end is frequently a factsheet OUTSIDE the synced set — the 974
    // applications on Power Platform are not themselves tagged — so the name
    // comes from the denormalised edge and the lifecycle is only known for the
    // ones we happen to hold. The LeanIX link works either way: it is built from
    // the id and type the edge already carries.
    const rows = db.prepare(`
        SELECT r.to_id, r.to_name, r.to_type, f.lifecycle_state
        FROM leanix_relations r
        LEFT JOIN leanix_factsheets f ON f.id = r.to_id
        WHERE ${where}
        ORDER BY r.to_name COLLATE NOCASE
        LIMIT ${MAX_ITEMS}
    `).all(...params) as any[];

    return {
        title,
        subtitle,
        total,
        items: rows.map(r => ({
            id: r.to_id,
            name: r.to_name ?? r.to_id,
            type: r.to_type,
            lifecycle: r.lifecycle_state ? label(r.lifecycle_state) : null,
            url: factsheetUrl({ id: r.to_id, fs_type: r.to_type }, workspace),
            note: null
        })),
        truncated: total > rows.length
    };
}

/** Groups (vendors, capabilities) rather than factsheets. */
function groupDrill(
    title: string,
    subtitle: string,
    type: string,
    /** Singular; pluralised per row, since a long tail of 1s is the common shape. */
    unit: string,
    sql: string
): DrillResult {
    const rows = db.prepare(sql).all() as { name: string; count: number }[];
    return {
        title,
        subtitle,
        total: rows.length,
        items: rows.slice(0, MAX_ITEMS).map(r => ({
            id: null,
            name: r.name,
            type,
            lifecycle: null,
            url: null,
            note: `${r.count} ${unit}${r.count === 1 ? '' : 's'}`
        })),
        truncated: rows.length > MAX_ITEMS
    };
}

/** Which record-gap tile maps to which predicate — the same ones getDataQuality counts. */
const GAP_FILTERS: Record<string, { label: string; where: string }> = {
    no_description: {
        label: 'no description',
        where: "(description IS NULL OR description = '')"
    },
    no_technical_fit: {
        label: 'no technical fit',
        where: 'technical_fit IS NULL'
    },
    no_lifecycle: {
        label: 'no lifecycle state',
        where: 'lifecycle_state IS NULL'
    },
    no_responsible_owner: {
        label: 'no responsible owner',
        where: `NOT EXISTS (
            SELECT 1 FROM leanix_subscriptions s
            WHERE s.factsheet_id = leanix_factsheets.id AND s.subscription_type = 'RESPONSIBLE'
        )`
    },
    no_tech_capability: {
        label: 'no technology capability',
        where: `fs_type = 'ITComponent' AND NOT EXISTS (
            SELECT 1 FROM leanix_relations r
            WHERE r.from_id = leanix_factsheets.id AND r.rel_type = 'relITComponentToTechnologyStack'
        )`
    }
};

/**
 * Resolves one drill. Returns null for an unknown dimension so the endpoint can
 * answer 400 rather than an empty list, which would read as "nothing matches".
 */
export function drill(dimension: string, key: string, key2: string): DrillResult | null {
    switch (dimension) {
        case 'all':
            return factsheetDrill('All factsheets', 'Everything in the synced portfolio', '1 = 1', []);

        case 'type': {
            const noun = key === 'ITComponent' ? 'IT components' : 'Applications';
            return factsheetDrill(noun, `Factsheets of type ${key}`, 'fs_type = ?', [key]);
        }

        case 'lifecycle': {
            const { clause, params } = eqOrNull('lifecycle_state', key);
            return factsheetDrill(`Lifecycle: ${label(key || null)}`, 'Factsheets in this lifecycle state', clause, params);
        }

        case 'technicalFit': {
            const { clause, params } = eqOrNull('technical_fit', key);
            return factsheetDrill(`Technical fit: ${label(key || null)}`, 'Factsheets with this technical fit', clause, params);
        }

        case 'category': {
            // Components only — matches getCategoryBreakdown.
            const { clause, params } = eqOrNull('category', key);
            return factsheetDrill(
                `Category: ${label(key || null)}`,
                'IT components in this category',
                `fs_type = 'ITComponent' AND ${clause}`,
                params
            );
        }

        case 'time': {
            // Applications only — matches getTimeBreakdown.
            const { clause, params } = eqOrNull('time_classification', key);
            return factsheetDrill(
                `TIME: ${label(key || null)}`,
                'Applications with this TIME classification',
                `fs_type = 'Application' AND ${clause}`,
                params
            );
        }

        case 'criticality': {
            // One cell of the criticality x data-class matrix. Applications only.
            const crit = eqOrNull('business_criticality', key);
            const data = eqOrNull('data_class', key2);
            return factsheetDrill(
                `${label(key || null)} · ${label(key2 || null)}`,
                'Applications at this criticality and data classification',
                `fs_type = 'Application' AND ${crit.clause} AND ${data.clause}`,
                [...crit.params, ...data.params]
            );
        }

        case 'gap': {
            const gap = GAP_FILTERS[key];
            if (!gap) return null;
            return factsheetDrill(
                `Record gap: ${gap.label}`,
                `Factsheets with ${gap.label} recorded`,
                gap.where,
                []
            );
        }

        case 'verdict': {
            const verdictLabel = VERDICT_LABELS[key as Verdict] ?? 'Unknown';
            return factsheetDrill(
                `Market verdict: ${verdictLabel}`,
                'Factsheets the market research rated this way',
                `id IN (SELECT factsheet_id FROM leanix_market_research WHERE identified = 1 AND verdict = ?)`,
                [key]
            );
        }

        case 'platform': {
            const component = db.prepare('SELECT name FROM leanix_factsheets WHERE id = ?')
                .get(key) as { name: string } | undefined;
            if (!component) return null;
            return relationDrill(
                component.name,
                'Applications depending on this IT component',
                "r.from_id = ? AND r.rel_type = 'relITComponentToApplication'",
                [key]
            );
        }

        case 'vendor':
            return factsheetDrill(
                key,
                'IT components from this supplier',
                `id IN (
                    SELECT from_id FROM leanix_relations
                    WHERE rel_type = 'relITComponentToProvider' AND to_name = ?
                )`,
                [key]
            );

        case 'capability':
            return factsheetDrill(
                key,
                'IT components serving this technology capability',
                `id IN (
                    SELECT from_id FROM leanix_relations
                    WHERE rel_type = 'relITComponentToTechnologyStack' AND to_name = ?
                )`,
                [key]
            );

        case 'businessCapability':
            // The near end is an Application in the synced set, so this resolves
            // to real factsheets — unlike the capability itself, which lives
            // outside the tag and is only known here by name.
            return factsheetDrill(
                key,
                'Applications supporting this business capability',
                `id IN (
                    SELECT from_id FROM leanix_relations
                    WHERE rel_type = 'relApplicationToBusinessCapability' AND to_name = ?
                )`,
                [key]
            );

        case 'org':
            return factsheetDrill(
                key,
                'Factsheets owned by this organisation',
                `id IN (
                    SELECT from_id FROM leanix_relations
                    WHERE rel_type IN ('relApplicationToUserGroup', 'relITComponentToUserGroup')
                      AND to_name = ?
                )`,
                [key]
            );

        case 'role':
            return factsheetDrill(
                key,
                'Factsheets with this responsible role staffed',
                `id IN (
                    SELECT factsheet_id FROM leanix_subscriptions
                    WHERE subscription_type = 'RESPONSIBLE' AND role_name = ?
                )`,
                [key]
            );

        case 'vendors':
            return groupDrill(
                'Vendors',
                'Every distinct supplier behind the portfolio',
                'Vendor',
                'component',
                `SELECT to_name AS name, COUNT(DISTINCT from_id) AS count
                 FROM leanix_relations
                 WHERE rel_type = 'relITComponentToProvider' AND to_name IS NOT NULL
                 GROUP BY to_name ORDER BY count DESC, name COLLATE NOCASE`
            );

        case 'capabilities':
            return groupDrill(
                'Technology capabilities',
                'Every distinct capability the portfolio covers',
                'Capability',
                'component',
                `SELECT to_name AS name, COUNT(DISTINCT from_id) AS count
                 FROM leanix_relations
                 WHERE rel_type = 'relITComponentToTechnologyStack' AND to_name IS NOT NULL
                 GROUP BY to_name ORDER BY count DESC, name COLLATE NOCASE`
            );

        case 'capabilitySingletons':
            // The thin end of the coverage distribution — capabilities where a
            // single component is the whole answer. Invisible on a chart ranked
            // by component count, which is exactly why it is drillable here.
            return groupDrill(
                'Single-component capabilities',
                'Technology capabilities served by exactly one component',
                'Capability',
                'component',
                `SELECT to_name AS name, COUNT(DISTINCT from_id) AS count
                 FROM leanix_relations
                 WHERE rel_type = 'relITComponentToTechnologyStack' AND to_name IS NOT NULL
                 GROUP BY to_name HAVING count = 1
                 ORDER BY name COLLATE NOCASE`
            );

        case 'businessCapabilities':
            return groupDrill(
                'Business capabilities',
                'Every distinct business capability the applications support',
                'Business capability',
                'application',
                `SELECT to_name AS name, COUNT(DISTINCT from_id) AS count
                 FROM leanix_relations
                 WHERE rel_type = 'relApplicationToBusinessCapability' AND to_name IS NOT NULL
                 GROUP BY to_name ORDER BY count DESC, name COLLATE NOCASE`
            );

        default:
            return null;
    }
}
