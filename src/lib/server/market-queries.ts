import { db } from './db';
import { factsheetUrl } from './leanix-format';
import { getWorkspaceUrl } from './leanix';
import { marketResearchStatus } from './market-research';
import {
    ALERT_CATEGORY_LABELS,
    VERDICT_LABELS,
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
}

/**
 * The alert feed: most severe first, then most recent.
 *
 * Sorted on severity RANK rather than the stored string, because alphabetical
 * order on severity names puts "critical" after "high" and "low" in the middle.
 */
export function getMarketAlerts(limit = 60): MarketAlertView[] {
    const rows = db.prepare(`
        SELECT
            a.id, a.factsheet_id, a.severity, a.category, a.title, a.detail,
            a.event_date, a.source_url, a.source_title,
            f.name AS factsheet_name, f.fs_type,
            CASE WHEN a.first_seen_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END AS is_new
        FROM leanix_market_alerts a
        JOIN leanix_factsheets f ON f.id = a.factsheet_id
        ORDER BY a.event_date DESC, a.title
        LIMIT ?
    `).all(limit) as any[];

    const workspace = getWorkspaceUrl();
    return rows
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
            isNew: r.is_new === 1
        }))
        .sort((a, b) => {
            const bySeverity = a.severityRank - b.severityRank;
            if (bySeverity !== 0) return bySeverity;
            // Undated events sort last within their severity: an event with no
            // date is not "the most recent one".
            if (!a.eventDate && !b.eventDate) return a.title.localeCompare(b.title);
            if (!a.eventDate) return 1;
            if (!b.eventDate) return -1;
            return b.eventDate.localeCompare(a.eventDate);
        });
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

/** Alert counts per factsheet, for the badge in the table. */
export function getAlertCounts(): Record<string, { total: number; worst: Severity }> {
    const rows = db.prepare(`
        SELECT factsheet_id, severity, COUNT(*) AS c
        FROM leanix_market_alerts
        GROUP BY factsheet_id, severity
    `).all() as { factsheet_id: string; severity: Severity; c: number }[];

    const out: Record<string, { total: number; worst: Severity }> = {};
    for (const row of rows) {
        const entry = out[row.factsheet_id];
        if (!entry) {
            out[row.factsheet_id] = { total: row.c, worst: row.severity };
            continue;
        }
        entry.total += row.c;
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
    return {
        status: marketResearchStatus(),
        alerts: getMarketAlerts(),
        assessments: getAssessments(),
        alertCounts: getAlertCounts(),
        verdicts: getVerdictBreakdown(),
        disagreements: getFitDisagreements()
    };
}
