import { db, getAppStateNumber, setAppState } from './db';
import { inCategory } from './usage';
import { groundedSearchConfigured } from './providers';
import { assessProduct, researchProduct } from './llm';
import {
    briefIsEmpty,
    selectDue,
    type MarketAssessment,
    type MarketSubject,
    type PortfolioContext,
    type ResearchCandidate
} from './market-format';

/**
 * Market research: what the open web says about the portfolio LeanIX records.
 *
 * For each factsheet this runs a live web search for the PRODUCT and turns the
 * result into a stored assessment — is it still the right choice, what would a
 * team evaluate instead, and has anything happened to it that an architect
 * should know about. The shaping rules, including what is allowed to leave for
 * a search engine, live in ./market-format; this module is the scheduling,
 * gating and persistence around them.
 *
 * ── Why this is rationed, and how ────────────────────────────────────────────
 * Unlike the LeanIX sync next door, the expensive thing here is not a request
 * budget someone else set — it is that every refresh is billed twice over, once
 * per grounded search and once per token. So the work is gated three ways and
 * each gate answers a different question:
 *
 *   • TTL (default 7 days) — has enough time passed for the answer to differ?
 *     News about an enterprise product does not turn over daily, and a nightly
 *     re-read would multiply the bill by seven to re-fetch the same headlines.
 *   • Input hash — is this still the same product? A renamed factsheet or a
 *     changed vendor invalidates immediately, without waiting for the TTL. Every
 *     other edit (description, owner, criticality) does not, because none of
 *     them change what the search would return.
 *   • Batch cap (default 10 per run) — spreads a first run of 78 factsheets
 *     across a week instead of spending it in one burst, so a misconfiguration
 *     is discovered at a cost of ten calls rather than a hundred and fifty.
 *
 * A failure is stamped like a success but retried on a shorter clock, so a
 * transient provider error costs one wasted call rather than either a retry loop
 * or a week of silence.
 */

function envInt(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const TTL_MS = envInt('MARKET_RESEARCH_TTL_DAYS', 7) * DAY_MS;
/** How soon a factsheet whose last attempt errored is tried again. */
const ERROR_RETRY_MS = envInt('MARKET_RESEARCH_ERROR_RETRY_HOURS', 6) * 60 * 60 * 1000;
const BATCH_LIMIT = envInt('MARKET_RESEARCH_BATCH', 10);
const RUN_INTERVAL_MS = envInt('MARKET_RESEARCH_INTERVAL_HOURS', 24) * 60 * 60 * 1000;

const LAST_RUN_KEY = 'market:last-run-at';

/** Opt-out switch. Absent, the feature follows whether grounded search works. */
function enabledByConfig(): boolean {
    const raw = (process.env.MARKET_RESEARCH_ENABLED ?? '').trim();
    if (!raw) return true;
    return /^(1|true|yes|on)$/i.test(raw);
}

export function marketResearchConfigured(): boolean {
    return enabledByConfig() && groundedSearchConfigured;
}

// ── Candidate selection ─────────────────────────────────────────────────────

/** Identity and research state (from ResearchCandidate) plus assessment context. */
interface CandidateRow extends ResearchCandidate {
    fs_type: string;
    lifecycle_state: string | null;
    technical_fit: string | null;
    functional_fit: string | null;
    business_criticality: string | null;
    time_classification: string | null;
    end_of_life_date: string | null;
    capabilities: string | null;
    app_count: number;
}

/**
 * Every factsheet with the context both calls need, plus the state of any
 * previous research.
 *
 * `researched_at` is converted to epoch milliseconds in SQL rather than parsed
 * in JS: SQLite stores it as a UTC string with no zone marker, and letting
 * JavaScript's Date guess at that would read every timestamp as local time —
 * silently shifting the TTL by the host's UTC offset.
 */
function loadCandidates(): CandidateRow[] {
    return db.prepare(`
        SELECT
            f.id, f.fs_type, f.name, f.alias, f.category,
            f.lifecycle_state, f.technical_fit, f.functional_fit,
            f.business_criticality, f.time_classification, f.end_of_life_date,
            (SELECT r.to_name FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToProvider' LIMIT 1) AS vendor,
            (SELECT GROUP_CONCAT(r.to_name, ', ') FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToTechnologyStack') AS capabilities,
            (SELECT COUNT(*) FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToApplication') AS app_count,
            m.input_hash,
            CAST(strftime('%s', m.researched_at) AS INTEGER) * 1000 AS researched_at_ms,
            CASE WHEN m.error IS NOT NULL THEN 1 ELSE 0 END AS had_error
        FROM leanix_factsheets f
        LEFT JOIN leanix_market_research m ON m.factsheet_id = f.id
        ORDER BY f.name COLLATE NOCASE
    `).all() as CandidateRow[];
}

function contextOf(row: CandidateRow): PortfolioContext {
    return {
        fsType: row.fs_type,
        lifecycle: row.lifecycle_state,
        technicalFit: row.technical_fit,
        functionalFit: row.functional_fit,
        businessCriticality: row.business_criticality,
        timeClassification: row.time_classification,
        endOfLifeDate: row.end_of_life_date,
        dependentApplications: row.app_count || null,
        capabilities: row.capabilities
    };
}

/** Applies this deployment's thresholds to the pure selection rule. */
function dueCandidates(rows: CandidateRow[], force: boolean) {
    return selectDue(rows, {
        now: Date.now(),
        ttlMs: TTL_MS,
        errorRetryMs: ERROR_RETRY_MS,
        force
    });
}

// ── Persistence ─────────────────────────────────────────────────────────────

const upsertResearch = () => db.prepare(`
    INSERT INTO leanix_market_research (
        factsheet_id, subject, identified, verdict, confidence, headline, rationale,
        market_position, strengths, concerns, alternatives, sources, model,
        input_hash, researched_at, error
    ) VALUES (
        @factsheet_id, @subject, @identified, @verdict, @confidence, @headline, @rationale,
        @market_position, @strengths, @concerns, @alternatives, @sources, @model,
        @input_hash, CURRENT_TIMESTAMP, @error
    )
    ON CONFLICT(factsheet_id) DO UPDATE SET
        subject = excluded.subject,
        identified = excluded.identified,
        verdict = excluded.verdict,
        confidence = excluded.confidence,
        headline = excluded.headline,
        rationale = excluded.rationale,
        market_position = excluded.market_position,
        strengths = excluded.strengths,
        concerns = excluded.concerns,
        alternatives = excluded.alternatives,
        sources = excluded.sources,
        model = excluded.model,
        input_hash = excluded.input_hash,
        researched_at = CURRENT_TIMESTAMP,
        error = excluded.error
`);

/**
 * Writes one assessment and reconciles its alerts.
 *
 * Alerts are upserted on their fingerprint rather than deleted and re-inserted,
 * which is what preserves `first_seen_at` for a story still being reported —
 * the field the page uses to mark an alert as new. Alerts absent from this
 * refresh are then removed, so the set always reflects what is currently
 * reported rather than accumulating everything ever seen.
 *
 * Exported so that reconciliation can be exercised directly: it is the one piece
 * of this module whose correctness is not visible from its inputs, and driving
 * it through a live research run would cost a billed search per assertion.
 */
export function persistAssessment(
    factsheetId: string,
    subject: MarketSubject,
    hash: string,
    model: string,
    assessment: MarketAssessment,
    error: string | null
): void {
    const write = db.transaction(() => {
        upsertResearch().run({
            factsheet_id: factsheetId,
            subject: subject.label,
            identified: assessment.identified ? 1 : 0,
            verdict: assessment.verdict,
            confidence: assessment.confidence,
            headline: assessment.headline,
            rationale: assessment.rationale,
            market_position: assessment.marketPosition,
            strengths: JSON.stringify(assessment.strengths),
            concerns: JSON.stringify(assessment.concerns),
            alternatives: JSON.stringify(assessment.alternatives),
            sources: JSON.stringify(assessment.sources),
            model,
            input_hash: hash,
            error
        });

        for (const alert of assessment.alerts) {
            db.prepare(`
                INSERT INTO leanix_market_alerts (
                    factsheet_id, fingerprint, severity, category, title, detail,
                    event_date, source_url, source_title, first_seen_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(factsheet_id, fingerprint) DO UPDATE SET
                    severity = excluded.severity,
                    category = excluded.category,
                    title = excluded.title,
                    detail = excluded.detail,
                    event_date = excluded.event_date,
                    source_url = excluded.source_url,
                    source_title = excluded.source_title,
                    last_seen_at = CURRENT_TIMESTAMP
            `).run(
                factsheetId, alert.fingerprint, alert.severity, alert.category,
                alert.title, alert.detail, alert.date, alert.sourceUrl, alert.sourceTitle
            );
        }

        const keep = assessment.alerts.map(a => a.fingerprint);
        if (keep.length === 0) {
            db.prepare('DELETE FROM leanix_market_alerts WHERE factsheet_id = ?').run(factsheetId);
        } else {
            db.prepare(`
                DELETE FROM leanix_market_alerts
                WHERE factsheet_id = ?
                  AND fingerprint NOT IN (${keep.map(() => '?').join(', ')})
            `).run(factsheetId, ...keep);
        }
    });
    write();
}

/** The row written when a call failed. Records nothing it did not learn. */
function failedAssessment(): MarketAssessment {
    return {
        identified: false, vendor: null, verdict: 'unknown', confidence: null,
        headline: null, rationale: null, marketPosition: null,
        strengths: [], concerns: [], alternatives: [], alerts: [], sources: []
    };
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface MarketResearchResult {
    status: 'ok' | 'skipped';
    reason?: string;
    /** Factsheets that were due, before the batch cap was applied. */
    due: number;
    researched: number;
    identified: number;
    unidentified: number;
    alerts: number;
    failed: { name: string; error: string }[];
    /** Grounded searches issued. Billed per request on top of tokens. */
    searches: number;
}

let runInProgress = false;

async function runMarketResearchImpl(
    options: { force?: boolean; limit?: number } = {}
): Promise<MarketResearchResult> {
    const empty: MarketResearchResult = {
        status: 'ok', due: 0, researched: 0, identified: 0,
        unidentified: 0, alerts: 0, failed: [], searches: 0
    };

    if (!marketResearchConfigured()) {
        return { ...empty, status: 'skipped', reason: 'market research is not configured' };
    }
    if (runInProgress) {
        return { ...empty, status: 'skipped', reason: 'a run is already in progress' };
    }

    runInProgress = true;
    try {
        setAppState(LAST_RUN_KEY, String(Date.now()));

        const due = dueCandidates(loadCandidates(), Boolean(options.force));
        if (due.length === 0) {
            return { ...empty, status: 'skipped', reason: 'nothing is due for research' };
        }

        const limit = options.limit && options.limit > 0 ? options.limit : BATCH_LIMIT;
        const batch = due.slice(0, limit);
        const model = process.env.TEXT_MODEL || 'gemini-flash-latest';

        console.log(
            `[Market] ${due.length} factsheet(s) due; researching ${batch.length} ` +
            `(${batch.filter(c => c.reason === 'new').length} never researched).`
        );
        if (due.length > batch.length) {
            // Said out loud rather than left implicit: a page showing 10 of 78
            // assessed must not look like a finished job.
            console.log(`[Market] ${due.length - batch.length} deferred to a later run by the batch cap of ${limit}.`);
        }

        const result: MarketResearchResult = { ...empty, due: due.length };

        for (const candidate of batch) {
            const { row, subject, hash } = candidate;
            try {
                const { brief, sources, queries } = await researchProduct(subject);
                result.searches++;

                if (briefIsEmpty(brief)) {
                    // Not a failure: an in-house system has no market to research,
                    // and recording that plainly is what stops it being retried
                    // from scratch every week.
                    persistAssessment(row.id, subject, hash, model, failedAssessment(), null);
                    result.researched++;
                    result.unidentified++;
                    console.log(`[Market] ${subject.label}: no public information found.`);
                    continue;
                }

                const assessment = await assessProduct(subject, brief, sources, contextOf(row));
                persistAssessment(row.id, subject, hash, model, assessment, null);

                result.researched++;
                if (assessment.identified) {
                    result.identified++;
                    result.alerts += assessment.alerts.length;
                } else {
                    result.unidentified++;
                }
                console.log(
                    `[Market] ${subject.label}: ${assessment.verdict}` +
                    `${assessment.alerts.length ? `, ${assessment.alerts.length} alert(s)` : ''}` +
                    ` (${queries.length} search(es), ${sources.length} source(s)).`
                );
            } catch (e) {
                const message = (e as Error)?.message ?? String(e);
                console.error(`[Market] ${subject.label} failed:`, message);
                // Stamped so the retry clock starts, with the hash so a later
                // rename is still detected as a change.
                persistAssessment(row.id, subject, hash, model, failedAssessment(), message.slice(0, 500));
                result.failed.push({ name: subject.label, error: message });
            }
        }

        return result;
    } finally {
        runInProgress = false;
    }
}

/**
 * Every model call underneath is attributed to the 'market' budget, so the
 * dashboard separates this feature's spend from ingestion and chat.
 */
export const runMarketResearch = inCategory('market', runMarketResearchImpl);

// ── Status and scheduling ───────────────────────────────────────────────────

export function marketResearchStatus() {
    const counts = db.prepare(`
        SELECT
            COUNT(*)                                              AS researched,
            SUM(CASE WHEN identified = 1 THEN 1 ELSE 0 END)       AS identified,
            SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)    AS errored
        FROM leanix_market_research
    `).get() as { researched: number; identified: number | null; errored: number | null };

    const total = (db.prepare('SELECT COUNT(*) AS c FROM leanix_factsheets').get() as { c: number }).c;
    const alerts = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN severity IN ('critical', 'high') THEN 1 ELSE 0 END) AS urgent
        FROM leanix_market_alerts
    `).get() as { total: number; urgent: number | null };

    return {
        configured: marketResearchConfigured(),
        total,
        researched: counts.researched,
        identified: counts.identified ?? 0,
        errored: counts.errored ?? 0,
        alerts: alerts.total,
        urgentAlerts: alerts.urgent ?? 0,
        lastRunAt: getAppStateNumber(LAST_RUN_KEY),
        ttlMs: TTL_MS,
        batchLimit: BATCH_LIMIT,
        running: runInProgress
    };
}

let researchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Hourly tick guarding a daily interval — the same shape as the LeanIX sync, and
 * for the same reason: the guard is what makes a restart-heavy deployment behave,
 * since a container that restarts twice a day would otherwise either research
 * twice or, with a naive daily timer, never.
 *
 * The first run is deliberately delayed well past boot. It is the only scheduled
 * work in this app that costs money per item, and starting it while embedding
 * migration is still running would have two billable pipelines competing.
 */
export function initMarketResearch() {
    if (researchTimer) clearInterval(researchTimer);
    if (!marketResearchConfigured()) {
        console.log('[Market] Not configured — research disabled.');
        return;
    }

    const tick = () => {
        const last = getAppStateNumber(LAST_RUN_KEY) ?? 0;
        if (Date.now() - last < RUN_INTERVAL_MS) return;
        runMarketResearch().catch(err => console.error('[Market] Scheduled run failed:', err));
    };

    researchTimer = setInterval(tick, 60 * 60 * 1000);
    researchTimer.unref?.();

    const firstRun = setTimeout(tick, 10 * 60 * 1000);
    firstRun.unref?.();
}
