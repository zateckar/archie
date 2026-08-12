import { db } from './db';
import { humanizeEnum, factsheetUrl } from './leanix-format';
import { getWorkspaceUrl, leanixStatus } from './leanix';

/**
 * Read-side aggregations for the /leanix portfolio page.
 *
 * Every figure here is computed in SQL over `leanix_factsheets` and
 * `leanix_relations`, never by re-reading the ingested markdown and never by
 * calling LeanIX. That is the whole reason the sync stores structured rows
 * alongside the documents: "which platforms carry the most applications" is a
 * COUNT over ~4500 relation rows, and asking a retrieval pipeline to answer it
 * would be both slower and wrong at the edges.
 *
 * The audience is domain and enterprise architects, so the cuts are portfolio
 * cuts — load, vendor concentration, lifecycle runway, TIME posture, ownership
 * gaps — rather than a list of factsheets with counts next to them.
 */

const NOT_SET = 'Not set';

function label(value: string | null | undefined): string {
    return humanizeEnum(value) ?? NOT_SET;
}

export interface Bucket {
    key: string;
    label: string;
    count: number;
}

/** Headline counts for the KPI row. */
export function getPortfolioSummary() {
    const row = db.prepare(`
        SELECT
            COUNT(*)                                                        AS total,
            SUM(CASE WHEN fs_type = 'Application'  THEN 1 ELSE 0 END)       AS applications,
            SUM(CASE WHEN fs_type = 'ITComponent'  THEN 1 ELSE 0 END)       AS components,
            SUM(CASE WHEN lifecycle_state = 'active'   THEN 1 ELSE 0 END)   AS active,
            SUM(CASE WHEN lifecycle_state = 'phaseOut' THEN 1 ELSE 0 END)   AS phasing_out,
            SUM(CASE WHEN end_of_life_date IS NOT NULL THEN 1 ELSE 0 END)   AS with_eol,
            AVG(completion)                                                 AS avg_completion
        FROM leanix_factsheets
    `).get() as {
        total: number; applications: number; components: number;
        active: number; phasing_out: number; with_eol: number; avg_completion: number | null;
    };

    const capabilities = db.prepare(`
        SELECT COUNT(DISTINCT to_name) AS c FROM leanix_relations
        WHERE rel_type = 'relITComponentToTechnologyStack' AND to_name IS NOT NULL
    `).get() as { c: number };

    const vendors = db.prepare(`
        SELECT COUNT(DISTINCT to_name) AS c FROM leanix_relations
        WHERE rel_type = 'relITComponentToProvider' AND to_name IS NOT NULL
    `).get() as { c: number };

    const businessCapabilities = db.prepare(`
        SELECT COUNT(DISTINCT to_name) AS c FROM leanix_relations
        WHERE rel_type = 'relApplicationToBusinessCapability' AND to_name IS NOT NULL
    `).get() as { c: number };

    // Applications carrying at least one business capability. Reported alongside
    // the total because the panel's headline claim ("57 capabilities") is only
    // meaningful next to how much of the portfolio it was drawn from.
    const mappedApplications = db.prepare(`
        SELECT COUNT(DISTINCT from_id) AS c FROM leanix_relations
        WHERE rel_type = 'relApplicationToBusinessCapability'
    `).get() as { c: number };

    return {
        ...row,
        avg_completion: row.avg_completion ?? 0,
        distinct_capabilities: capabilities.c,
        distinct_vendors: vendors.c,
        distinct_business_capabilities: businessCapabilities.c,
        applications_with_business_capability: mappedApplications.c
    };
}

function bucketsFrom(rows: { value: string | null; count: number }[]): Bucket[] {
    return rows.map(r => ({ key: r.value ?? '', label: label(r.value), count: r.count }));
}

export function getLifecycleBreakdown(): Bucket[] {
    return bucketsFrom(db.prepare(`
        SELECT lifecycle_state AS value, COUNT(*) AS count FROM leanix_factsheets
        GROUP BY lifecycle_state ORDER BY count DESC
    `).all() as { value: string | null; count: number }[]);
}

export function getCategoryBreakdown(): Bucket[] {
    return bucketsFrom(db.prepare(`
        SELECT category AS value, COUNT(*) AS count FROM leanix_factsheets
        WHERE fs_type = 'ITComponent'
        GROUP BY category ORDER BY count DESC
    `).all() as { value: string | null; count: number }[]);
}

export function getTechnicalFitBreakdown(): Bucket[] {
    return bucketsFrom(db.prepare(`
        SELECT technical_fit AS value, COUNT(*) AS count FROM leanix_factsheets
        GROUP BY technical_fit ORDER BY count DESC
    `).all() as { value: string | null; count: number }[]);
}

/** TIME posture (Tolerate / Invest / Migrate / Eliminate), applications only. */
export function getTimeBreakdown(): Bucket[] {
    return bucketsFrom(db.prepare(`
        SELECT time_classification AS value, COUNT(*) AS count FROM leanix_factsheets
        WHERE fs_type = 'Application'
        GROUP BY time_classification ORDER BY count DESC
    `).all() as { value: string | null; count: number }[]);
}

/**
 * The headline chart: how many applications each platform carries.
 *
 * This is the question the page exists to answer — a component with 974
 * dependent applications is a different kind of risk from one with three, and
 * that fact is invisible in a factsheet list.
 */
export function getPlatformLoad(limit = 15) {
    return db.prepare(`
        SELECT f.id, f.name, f.category, f.lifecycle_state, f.technical_fit,
               COUNT(r.to_id) AS app_count
        FROM leanix_factsheets f
        JOIN leanix_relations r ON r.from_id = f.id AND r.rel_type = 'relITComponentToApplication'
        GROUP BY f.id
        ORDER BY app_count DESC, f.name
        LIMIT ?
    `).all(limit).map((r: any) => ({
        ...r,
        category_label: label(r.category),
        lifecycle_label: label(r.lifecycle_state),
        url: factsheetUrl({ id: r.id, fs_type: 'ITComponent' }, getWorkspaceUrl())
    }));
}

/** Vendor concentration — how much of the portfolio sits behind one supplier. */
export function getVendorConcentration(limit = 15) {
    return db.prepare(`
        SELECT r.to_name AS vendor,
               COUNT(DISTINCT r.from_id) AS component_count
        FROM leanix_relations r
        WHERE r.rel_type = 'relITComponentToProvider' AND r.to_name IS NOT NULL
        GROUP BY r.to_name
        ORDER BY component_count DESC, vendor
        LIMIT ?
    `).all(limit) as { vendor: string; component_count: number }[];
}

/**
 * How concentrated the supplier base actually is.
 *
 * The ranked bars above answer "who is biggest", which is not the same question
 * as "how much of the estate sits behind one supplier" — a ranking looks equally
 * dramatic whether the leader holds 80% or 17%. These are the figures that
 * separate those two cases, so the panel can state its own claim instead of
 * leaving a bar chart to imply one.
 */
export function getVendorStats() {
    const vendors = db.prepare(`
        SELECT to_name AS vendor, COUNT(DISTINCT from_id) AS c
        FROM leanix_relations
        WHERE rel_type = 'relITComponentToProvider' AND to_name IS NOT NULL
        GROUP BY to_name ORDER BY c DESC, vendor COLLATE NOCASE
    `).all() as { vendor: string; c: number }[];

    const total = vendors.reduce((s, v) => s + v.c, 0);
    // How few suppliers it takes to cover half the vendored estate — the standard
    // way of saying "concentrated" without inventing an index nobody reads.
    let running = 0;
    let vendorsForHalf = 0;
    for (const v of vendors) {
        running += v.c;
        vendorsForHalf++;
        if (running * 2 >= total) break;
    }

    const topShare = total > 0 ? (vendors[0]?.c ?? 0) / total : 0;
    return {
        distinct: vendors.length,
        componentsWithVendor: total,
        top: vendors[0] ?? null,
        topShare,
        vendorsForHalf,
        // Segments for the share bar: the leaders, then everyone else as one.
        segments: vendors.slice(0, 5).map(v => ({ label: v.vendor, count: v.c })),
        remainder: vendors.slice(5).reduce((s, v) => s + v.c, 0),
        remainderVendors: Math.max(0, vendors.length - 5)
    };
}

/**
 * The spread of technology capability coverage.
 *
 * The panel's stated purpose is that "thin coverage and duplication both show
 * here", but a list ranked by component count only ever shows the duplication
 * end — the thinly-covered capabilities sit below the cut by construction. This
 * counts them, so the thin end can be stated and drilled.
 */
export function getCapabilityStats() {
    const rows = db.prepare(`
        SELECT to_name AS n, COUNT(DISTINCT from_id) AS c
        FROM leanix_relations
        WHERE rel_type = 'relITComponentToTechnologyStack' AND to_name IS NOT NULL
        GROUP BY to_name
    `).all() as { n: string; c: number }[];

    return {
        distinct: rows.length,
        singleComponent: rows.filter(r => r.c === 1).length,
        max: rows.reduce((m, r) => Math.max(m, r.c), 0)
    };
}

/** Technology capability coverage (LeanIX TechnicalStack factsheets). */
export function getCapabilityCoverage(limit = 20) {
    return db.prepare(`
        SELECT r.to_name AS capability,
               COUNT(DISTINCT r.from_id) AS component_count
        FROM leanix_relations r
        WHERE r.rel_type = 'relITComponentToTechnologyStack' AND r.to_name IS NOT NULL
        GROUP BY r.to_name
        ORDER BY component_count DESC, capability
        LIMIT ?
    `).all(limit) as { capability: string; component_count: number }[];
}

/** Business capabilities the tagged applications support. */
export function getBusinessCapabilities(limit = 20) {
    return db.prepare(`
        SELECT r.to_name AS capability,
               COUNT(DISTINCT r.from_id) AS application_count
        FROM leanix_relations r
        WHERE r.rel_type = 'relApplicationToBusinessCapability' AND r.to_name IS NOT NULL
        GROUP BY r.to_name
        ORDER BY application_count DESC, capability
        LIMIT ?
    `).all(limit) as { capability: string; application_count: number }[];
}

/**
 * Severity order for the exposure matrix, most severe FIRST.
 *
 * Without these the axes come back in whatever order SQLite grouped them —
 * alphabetical in practice, which puts "Administrative service" above "Mission
 * critical" and scatters the sensitive data classes. The matrix exists to show
 * where exposure concentrates, and that only reads if the most exposed corner is
 * a corner: severity descending down the rows, sensitivity descending across the
 * columns, so the top-left cell is the one to look at first.
 *
 * Values absent from these lists sort last rather than being dropped — a new
 * LeanIX enum value should appear in the matrix, just not jump the ordering.
 */
const CRITICALITY_ORDER = [
    'missionCritical', 'businessCritical', 'businessOperational', 'administrativeService'
];
const DATA_CLASS_ORDER = ['secret', 'confidential', 'internal', 'public'];

function bySeverity(order: string[]) {
    return (a: string | null, b: string | null) => {
        // Null ("Not set") is not a severity; it belongs at the end of the axis.
        const rank = (v: string | null) => {
            if (v == null) return order.length + 1;
            const i = order.indexOf(v);
            return i === -1 ? order.length : i;
        };
        const diff = rank(a) - rank(b);
        return diff !== 0 ? diff : String(a ?? '').localeCompare(String(b ?? ''));
    };
}

/**
 * Business criticality against data classification — the cut that says where the
 * portfolio's exposure actually is. Applications only; the fields are theirs.
 */
export function getCriticalityMatrix() {
    const rows = db.prepare(`
        SELECT business_criticality AS criticality, data_class AS dataclass, COUNT(*) AS count
        FROM leanix_factsheets
        WHERE fs_type = 'Application'
        GROUP BY business_criticality, data_class
    `).all() as { criticality: string | null; dataclass: string | null; count: number }[];

    const criticalities = [...new Set(rows.map(r => r.criticality))].sort(bySeverity(CRITICALITY_ORDER));
    const dataclasses = [...new Set(rows.map(r => r.dataclass))].sort(bySeverity(DATA_CLASS_ORDER));
    return {
        rows: criticalities.map(c => ({
            key: c ?? '',
            label: label(c),
            // Each cell carries BOTH raw keys, not just its label: drilling a cell
            // is a two-dimensional question, and a label ("Not set") cannot be
            // turned back into the NULL it came from.
            cells: dataclasses.map(d => ({
                key: d ?? '',
                criticalityKey: c ?? '',
                label: label(d),
                count: rows.find(r => r.criticality === c && r.dataclass === d)?.count ?? 0
            }))
        })),
        columns: dataclasses.map(d => label(d)),
        // Scale for the heatmap. Computed here so the page never has to flatten
        // the grid to find it, and reported even when zero so a matrix with no
        // applications in it cannot divide by nothing.
        max: rows.reduce((m, r) => Math.max(m, r.count), 0),
        total: rows.reduce((s, r) => s + r.count, 0)
    };
}

/**
 * Everything with a dated end of life, soonest first.
 *
 * Each row carries its distance from today as well as its date, because "runway"
 * is the question and a raw date is not an answer to it — reading "2031-06-30"
 * and working out how far away that is, is arithmetic the page should have done.
 * The fraction along the window is included for the timeline, so the page plots a
 * position rather than recomputing the span per row.
 */
export function getRoadmap(limit = 25) {
    const rows = db.prepare(`
        SELECT id, name, fs_type, lifecycle_state, end_of_life_date
        FROM leanix_factsheets
        WHERE end_of_life_date IS NOT NULL
        ORDER BY end_of_life_date ASC
        LIMIT ?
    `).all(limit) as any[];

    const now = Date.now();
    const times = rows.map(r => Date.parse(String(r.end_of_life_date).slice(0, 10))).filter(Number.isFinite);
    // The window runs from today (not from the earliest date) so an item three
    // months out sits hard against the left edge, where it belongs.
    const start = now;
    const end = times.length ? Math.max(...times) : now;
    const span = Math.max(1, end - start);

    return rows.map(r => {
        const date = String(r.end_of_life_date).slice(0, 10);
        const at = Date.parse(date);
        const monthsAway = Number.isFinite(at) ? (at - now) / (1000 * 60 * 60 * 24 * 30.44) : null;
        return {
            ...r,
            lifecycle_label: label(r.lifecycle_state),
            end_of_life_date: date,
            monthsAway,
            // Clamped, so an item already past its date pins to the left edge
            // instead of being plotted off the track.
            position: Number.isFinite(at) ? Math.min(1, Math.max(0, (at - start) / span)) : 0,
            url: factsheetUrl({ id: r.id, fs_type: r.fs_type }, getWorkspaceUrl())
        };
    });
}

/** Owning organisations, and the responsible roles that are actually staffed. */
export function getOwnership(limit = 12) {
    const orgs = db.prepare(`
        SELECT r.to_name AS org, COUNT(DISTINCT r.from_id) AS factsheet_count
        FROM leanix_relations r
        WHERE r.rel_type IN ('relApplicationToUserGroup', 'relITComponentToUserGroup')
          AND r.to_name IS NOT NULL
        GROUP BY r.to_name
        ORDER BY factsheet_count DESC, org
        LIMIT ?
    `).all(limit) as { org: string; factsheet_count: number }[];

    const roles = db.prepare(`
        SELECT role_name AS role, COUNT(DISTINCT factsheet_id) AS factsheet_count
        FROM leanix_subscriptions
        WHERE subscription_type = 'RESPONSIBLE' AND role_name IS NOT NULL
        GROUP BY role_name
        ORDER BY factsheet_count DESC, role
        LIMIT ?
    `).all(limit) as { role: string; factsheet_count: number }[];

    return { orgs, roles };
}

/**
 * The gaps. Stated as counts of what is missing rather than percentages of what
 * is present, because an architect's next action is "go and fill these in".
 */
export function getDataQuality() {
    const row = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN description IS NULL OR description = '' THEN 1 ELSE 0 END) AS no_description,
            SUM(CASE WHEN technical_fit IS NULL THEN 1 ELSE 0 END)                   AS no_technical_fit,
            SUM(CASE WHEN lifecycle_state IS NULL THEN 1 ELSE 0 END)                 AS no_lifecycle
        FROM leanix_factsheets
    `).get() as { total: number; no_description: number; no_technical_fit: number; no_lifecycle: number };

    const noOwner = db.prepare(`
        SELECT COUNT(*) AS c FROM leanix_factsheets f
        WHERE NOT EXISTS (
            SELECT 1 FROM leanix_subscriptions s
            WHERE s.factsheet_id = f.id AND s.subscription_type = 'RESPONSIBLE'
        )
    `).get() as { c: number };

    const noCapability = db.prepare(`
        SELECT COUNT(*) AS c FROM leanix_factsheets f
        WHERE f.fs_type = 'ITComponent' AND NOT EXISTS (
            SELECT 1 FROM leanix_relations r
            WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToTechnologyStack'
        )
    `).get() as { c: number };

    return {
        ...row,
        no_responsible_owner: noOwner.c,
        no_tech_capability: noCapability.c
    };
}

export interface FactsheetTableRow {
    id: string;
    name: string;
    fs_type: string;
    category_label: string;
    lifecycle_label: string;
    technical_fit_label: string;
    criticality_label: string;
    time_label: string;
    end_of_life_date: string | null;
    completion: number | null;
    description: string | null;
    capabilities: string | null;
    vendor: string | null;
    org: string | null;
    app_count: number;
    tags: string | null;
    url: string | null;
}

/** The full table. 78 rows — no paging needed, and sorting stays in the browser. */
export function getFactsheetTable(): FactsheetTableRow[] {
    const rows = db.prepare(`
        SELECT
            f.id, f.name, f.fs_type, f.category, f.lifecycle_state, f.technical_fit,
            f.business_criticality, f.time_classification, f.end_of_life_date,
            f.completion, f.description, f.tags,
            (SELECT GROUP_CONCAT(r.to_name, ', ') FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToTechnologyStack') AS capabilities,
            (SELECT r.to_name FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToProvider' LIMIT 1)  AS vendor,
            (SELECT r.to_name FROM leanix_relations r
              WHERE r.from_id = f.id
                AND r.rel_type IN ('relApplicationToUserGroup', 'relITComponentToUserGroup') LIMIT 1) AS org,
            (SELECT COUNT(*) FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToApplication')       AS app_count
        FROM leanix_factsheets f
        ORDER BY f.name COLLATE NOCASE
    `).all() as any[];

    return rows.map(r => ({
        id: r.id,
        name: r.name,
        fs_type: r.fs_type,
        category_label: label(r.category),
        lifecycle_label: label(r.lifecycle_state),
        technical_fit_label: label(r.technical_fit),
        criticality_label: label(r.business_criticality),
        time_label: label(r.time_classification),
        end_of_life_date: r.end_of_life_date ? String(r.end_of_life_date).slice(0, 10) : null,
        completion: r.completion,
        description: r.description,
        capabilities: r.capabilities,
        vendor: r.vendor,
        org: r.org,
        app_count: r.app_count ?? 0,
        tags: r.tags
            ? (JSON.parse(r.tags) as { name: string; group: string | null }[])
                  .map(t => (t.group ? `${t.group}: ${t.name}` : t.name))
                  .join(', ')
            : null,
        url: factsheetUrl({ id: r.id, fs_type: r.fs_type }, getWorkspaceUrl())
    }));
}

/** Everything the page needs, in one server-side call. */
export function getPortfolioPage() {
    return {
        status: leanixStatus(),
        summary: getPortfolioSummary(),
        lifecycle: getLifecycleBreakdown(),
        categories: getCategoryBreakdown(),
        technicalFit: getTechnicalFitBreakdown(),
        time: getTimeBreakdown(),
        platformLoad: getPlatformLoad(),
        vendors: getVendorConcentration(),
        vendorStats: getVendorStats(),
        capabilities: getCapabilityCoverage(),
        capabilityStats: getCapabilityStats(),
        businessCapabilities: getBusinessCapabilities(),
        criticality: getCriticalityMatrix(),
        roadmap: getRoadmap(),
        ownership: getOwnership(),
        dataQuality: getDataQuality(),
        factsheets: getFactsheetTable()
    };
}
