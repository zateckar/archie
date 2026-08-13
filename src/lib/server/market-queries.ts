import { db } from './db';
import { factsheetUrl } from './leanix-format';
import { getWorkspaceUrl } from './leanix';
import { marketResearchStatus } from './market-research';
import {
    ALERT_CATEGORY_LABELS,
    ALERT_WINDOW_MONTHS,
    VERDICT_LABELS,
    exposureScore,
    isCurrentEvent,
    severityRank,
    type AlertCategory,
    type MarketAlternative,
    type Severity,
    type Verdict
} from './market-format';
import type { GroundedSource } from './providers';

/**
 * Read side of the market research feature, for the /leanix portfolio page.
 *
 * Everything is served from SQLite. Opening the page runs no search and calls no
 * model — the scheduled run in ./market-research is the only thing that spends
 * anything, which is what keeps a feature billed per request from being billed
 * per page view.
 *
 * The whole assessment set is returned in the page load rather than fetched per
 * factsheet on click. At 78 factsheets that is one query instead of up to 78
 * round trips, and it matches how the rest of the page already works.
 */

/** Parses a stored JSON column, treating unreadable data as absent. */
function jsonColumn<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string' || !raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
}

export interface MarketAlertView {
    id: number;
    factsheetId: string;
    factsheetName: string;
    factsheetType: string;
    factsheetUrl: string | null;
    severity: Severity;
    severityRank: number;
    category: AlertCategory;
    categoryLabel: string;
    title: string;
    detail: string | null;
    eventDate: string | null;
    sourceUrl: string | null;
    sourceTitle: string | null;
    /** First seen within the last 7 days — the page badges these as new. */
    isNew: boolean;
    /** Applications recorded as running on the affected factsheet. */
    reach: number;
    /** Severity weighted by reach — see exposureScore. */
    exposure: number;
}

/**
 * Every stored alert still dated inside the alert window.
 *
 * Read-side filtering exists because the write side cannot be the whole answer.
 * normalizeAssessment refuses to store an event older than the window, but a
 * stored alert keeps ageing afterwards and the row is only reconciled when its
 * factsheet is next researched — up to a TTL later. Without this the page would
 * drift back into showing exactly what it is supposed to have stopped showing.
 *
 * Rows are not deleted on the way past: the next refresh reconciles them anyway,
 * and a read path that quietly deletes is a read path that surprises someone.
 */
function currentAlertRows<T extends { event_date: string | null }>(rows: T[]): T[] {
    const now = Date.now();
    return rows.filter(r => isCurrentEvent(r.event_date, now));
}

/**
 * The alert feed: most exposed first.
 *
 * Ordered on exposure rather than severity alone, so how far an event reaches is
 * part of the ranking instead of something the reader has to notice — see
 * exposureScore for where the crossover between the two sits. Severity rank is
 * still carried on every row, because the badge colour is a severity, not an
 * exposure.
 *
 * The limit is applied AFTER the recency filter, not in SQL — an out-of-window
 * alert must not consume one of the slots.
 */
export function getMarketAlerts(limit = 60): MarketAlertView[] {
    const rows = db.prepare(`
        SELECT
            a.id, a.factsheet_id, a.severity, a.category, a.title, a.detail,
            a.event_date, a.source_url, a.source_title,
            f.name AS factsheet_name, f.fs_type,
            (SELECT COUNT(*) FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToApplication') AS reach,
            CASE WHEN a.first_seen_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END AS is_new
        FROM leanix_market_alerts a
        JOIN leanix_factsheets f ON f.id = a.factsheet_id
    `).all() as any[];

    const workspace = getWorkspaceUrl();
    return currentAlertRows(rows)
        .map(r => ({
            id: r.id,
            factsheetId: r.factsheet_id,
            factsheetName: r.factsheet_name,
            factsheetType: r.fs_type,
            factsheetUrl: factsheetUrl({ id: r.factsheet_id, fs_type: r.fs_type }, workspace),
            severity: r.severity as Severity,
            severityRank: severityRank(r.severity),
            category: r.category as AlertCategory,
            categoryLabel: ALERT_CATEGORY_LABELS[r.category as AlertCategory] ?? 'Other',
            title: r.title,
            detail: r.detail,
            eventDate: r.event_date,
            sourceUrl: r.source_url,
            sourceTitle: r.source_title,
            isNew: r.is_new === 1,
            reach: r.reach ?? 0,
            exposure: exposureScore(r.severity, r.reach ?? 0)
        }))
        .sort((a, b) => {
            const byExposure = b.exposure - a.exposure;
            if (byExposure !== 0) return byExposure;
            // Undated events sort last within equal exposure. They no longer
            // survive normalization, but rows written before that rule existed
            // are still in the table until their factsheet is next researched.
            if (!a.eventDate && !b.eventDate) return a.title.localeCompare(b.title);
            if (!a.eventDate) return 1;
            if (!b.eventDate) return -1;
            return b.eventDate.localeCompare(a.eventDate);
        })
        .slice(0, limit);
}

export interface ExposureSummary {
    /** Distinct factsheets carrying at least one current critical or high alert. */
    factsheets: number;
    /** Applications running on them — counted once per application. */
    applications: number;
    /** The factsheet putting the most applications at risk, for the headline. */
    worst: { id: string; name: string; reach: number; severity: Severity } | null;
}

/**
 * How much of the estate sits under an urgent alert.
 *
 * "3 critical alerts" is a count of stories; this is a count of consequences,
 * which is the figure that decides whether the feed is a reading item or a
 * standing meeting. Applications are de-duplicated across factsheets because one
 * application on two alerting platforms is still one application at risk —
 * summing the per-platform reach would double-count exactly the applications
 * that matter most.
 */
export function getExposureSummary(alerts: MarketAlertView[]): ExposureSummary {
    const urgent = alerts.filter(a => a.severity === 'critical' || a.severity === 'high');
    if (urgent.length === 0) return { factsheets: 0, applications: 0, worst: null };

    const factsheetIds = [...new Set(urgent.map(a => a.factsheetId))];
    const placeholders = factsheetIds.map(() => '?').join(', ');
    const applications = (db.prepare(`
        SELECT COUNT(DISTINCT to_id) AS c FROM leanix_relations
        WHERE rel_type = 'relITComponentToApplication' AND from_id IN (${placeholders})
    `).get(...factsheetIds) as { c: number }).c;

    // Picked by REACH, not by exposure score. The score ranks the feed, where the
    // question is what to read first; this sentence is about applications at
    // risk, and naming a 18-application critical as "most exposed" beside a
    // 187-application high would contradict the number it sits next to.
    const worst = urgent.reduce((a, b) => (b.reach > a.reach ? b : a));
    return {
        factsheets: factsheetIds.length,
        applications,
        worst: { id: worst.factsheetId, name: worst.factsheetName, reach: worst.reach, severity: worst.severity }
    };
}

export interface AssessmentView {
    factsheetId: string;
    subject: string;
    identified: boolean;
    verdict: Verdict;
    verdictLabel: string;
    confidence: number | null;
    headline: string | null;
    rationale: string | null;
    marketPosition: string | null;
    strengths: string[];
    concerns: string[];
    alternatives: MarketAlternative[];
    sources: GroundedSource[];
    researchedAt: string | null;
    error: string | null;
}

/** Every stored assessment, keyed by factsheet id for O(1) lookup on the page. */
export function getAssessments(): Record<string, AssessmentView> {
    const rows = db.prepare(`
        SELECT factsheet_id, subject, identified, verdict, confidence, headline,
               rationale, market_position, strengths, concerns, alternatives,
               sources, researched_at, error
        FROM leanix_market_research
    `).all() as any[];

    const out: Record<string, AssessmentView> = {};
    for (const r of rows) {
        const verdict = (r.verdict ?? 'unknown') as Verdict;
        out[r.factsheet_id] = {
            factsheetId: r.factsheet_id,
            subject: r.subject,
            identified: r.identified === 1,
            verdict,
            verdictLabel: VERDICT_LABELS[verdict] ?? 'Unknown',
            confidence: r.confidence,
            headline: r.headline,
            rationale: r.rationale,
            marketPosition: r.market_position,
            strengths: jsonColumn<string[]>(r.strengths, []),
            concerns: jsonColumn<string[]>(r.concerns, []),
            alternatives: jsonColumn<MarketAlternative[]>(r.alternatives, []),
            sources: jsonColumn<GroundedSource[]>(r.sources, []),
            researchedAt: r.researched_at ? String(r.researched_at).slice(0, 10) : null,
            error: r.error
        };
    }
    return out;
}

/**
 * Alert counts per factsheet, for the badge in the table.
 *
 * Counted row by row rather than with a GROUP BY, so the same recency predicate
 * decides this badge and the feed above it. A badge reading 3 above a feed
 * showing 1 is the bug this shape exists to prevent.
 */
export function getAlertCounts(): Record<string, { total: number; worst: Severity }> {
    const rows = currentAlertRows(db.prepare(`
        SELECT factsheet_id, severity, event_date
        FROM leanix_market_alerts
    `).all() as { factsheet_id: string; severity: Severity; event_date: string | null }[]);

    const out: Record<string, { total: number; worst: Severity }> = {};
    for (const row of rows) {
        const entry = out[row.factsheet_id];
        if (!entry) {
            out[row.factsheet_id] = { total: 1, worst: row.severity };
            continue;
        }
        entry.total++;
        if (severityRank(row.severity) < severityRank(entry.worst)) entry.worst = row.severity;
    }
    return out;
}

export interface VerdictBucket {
    key: Verdict;
    label: string;
    count: number;
}

/**
 * Verdict distribution.
 *
 * Ordered best→worst rather than by size, so the shape of the bar chart carries
 * meaning: a portfolio leaning right is a portfolio with a problem.
 */
export function getVerdictBreakdown(): VerdictBucket[] {
    const rows = db.prepare(`
        SELECT verdict, COUNT(*) AS count
        FROM leanix_market_research
        WHERE identified = 1
        GROUP BY verdict
    `).all() as { verdict: string; count: number }[];

    const order: Verdict[] = ['best_in_class', 'solid', 'adequate', 'questionable', 'replace', 'unknown'];
    return order
        .map(key => ({
            key,
            label: VERDICT_LABELS[key],
            count: rows.find(r => r.verdict === key)?.count ?? 0
        }))
        .filter(b => b.count > 0);
}

/**
 * Factsheets whose own technical-fit rating disagrees with the market verdict.
 *
 * The most useful cut on the page: a component we rate "unreasonable" that the
 * market rates best in class is a candidate for re-rating rather than
 * replacement, and the reverse is a risk nobody has written down yet.
 */
export function getFitDisagreements(limit = 10) {
    return db.prepare(`
        SELECT f.id, f.name, f.fs_type, f.technical_fit, m.verdict, m.headline
        FROM leanix_market_research m
        JOIN leanix_factsheets f ON f.id = m.factsheet_id
        WHERE m.identified = 1
          AND f.technical_fit IS NOT NULL
          AND (
                (f.technical_fit IN ('fullyAppropriate', 'adequate')      AND m.verdict IN ('questionable', 'replace'))
             OR (f.technical_fit IN ('insufficient', 'unreasonable')      AND m.verdict IN ('best_in_class', 'solid'))
          )
        ORDER BY f.name COLLATE NOCASE
        LIMIT ?
    `).all(limit).map((r: any) => ({
        id: r.id,
        name: r.name,
        fsType: r.fs_type,
        technicalFit: r.technical_fit,
        verdict: r.verdict as Verdict,
        verdictLabel: VERDICT_LABELS[r.verdict as Verdict] ?? 'Unknown',
        headline: r.headline,
        // Which way round the disagreement runs — the page words them differently.
        direction: ['fullyAppropriate', 'adequate'].includes(r.technical_fit)
            ? 'we_rate_higher'
            : 'market_rates_higher'
    }));
}

/** Everything the portfolio page needs from this feature, in one call. */
export function getMarketPage() {
    const alerts = getMarketAlerts();
    return {
        status: marketResearchStatus(),
        alertWindowMonths: ALERT_WINDOW_MONTHS,
        alerts,
        exposure: getExposureSummary(alerts),
        assessments: getAssessments(),
        alertCounts: getAlertCounts(),
        verdicts: getVerdictBreakdown(),
        disagreements: getFitDisagreements()
    };
}
