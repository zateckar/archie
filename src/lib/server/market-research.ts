import { db, getAppStateNumber, setAppState } from './db';
import { inCategory } from './usage';
import { groundedSearchConfigured } from './providers';
import { assessProduct, researchProduct, resolveProductIdentity } from './llm';
import {
    ALERT_WINDOW_MONTHS,
    applyIdentity,
    briefIsEmpty,
    isCurrentEvent,
    selectDue,
    type IdentityInput,
    type MarketAssessment,
    type MarketSubject,
    type PortfolioContext,
    type ResearchCandidate,
    type ResolvedIdentity
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
 *     A factsheet with no public product behind it gets its own, much longer
 *     clock: "this is an in-house system" does not become false in a week.
 *   • Input hash — is this still the same product? A renamed factsheet, a
 *     changed vendor or an edited description invalidates immediately, without
 *     waiting for the TTL. Owner, criticality and fit ratings do not, because
 *     none of them change what would be searched for.
 *   • Batch cap (default 10 per run) — so a misconfiguration is discovered at a
 *     cost of ten calls rather than a hundred and fifty.
 *
 * A failure is stamped like a success but retried on a shorter clock, so a
 * transient provider error costs one wasted call rather than either a retry loop
 * or a week of silence.
 *
 * ── Getting the portfolio covered in the first place ─────────────────────────
 * Those gates make a steady state cheap, but they also made the FIRST pass
 * glacial: ten a day against seventy-eight factsheets meant the page sat mostly
 * empty for a week, with well-known products at the end of an alphabetical queue
 * simply because their names start late. Two things fix that without loosening
 * the steady-state budget — the run ticks on BACKFILL_INTERVAL_MS while any
 * factsheet has never been looked at (see initMarketResearch), and selectDue
 * orders by portfolio weight within a due reason so the heaviest platforms are
 * covered first rather than alphabetically.
 */

function envInt(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const TTL_MS = envInt('MARKET_RESEARCH_TTL_DAYS', 7) * DAY_MS;
/**
 * Refresh clock for a factsheet the web had nothing on. Longer than the TTL
 * because an in-house system is not news that goes stale — re-asking every week
 * spent the batch cap on the one answer that cannot change, which is most of why
 * the well-known products in the portfolio had no assessment at all.
 */
const UNIDENTIFIED_TTL_MS = envInt('MARKET_RESEARCH_UNIDENTIFIED_TTL_DAYS', 60) * DAY_MS;
/** How soon a factsheet whose last attempt errored is tried again. */
const ERROR_RETRY_MS = envInt('MARKET_RESEARCH_ERROR_RETRY_HOURS', 6) * 60 * 60 * 1000;
const BATCH_LIMIT = envInt('MARKET_RESEARCH_BATCH', 10);
const RUN_INTERVAL_MS = envInt('MARKET_RESEARCH_INTERVAL_HOURS', 24) * 60 * 60 * 1000;
/** The clock while the portfolio has never-researched factsheets left. */
const BACKFILL_INTERVAL_MS = envInt('MARKET_RESEARCH_BACKFILL_INTERVAL_HOURS', 1) * 60 * 60 * 1000;

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
            f.id, f.fs_type, f.name, f.alias, f.category, f.description,
            f.lifecycle_state, f.technical_fit, f.functional_fit,
            f.business_criticality, f.time_classification, f.end_of_life_date,
            (SELECT r.to_name FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToProvider' LIMIT 1) AS vendor,
            (SELECT GROUP_CONCAT(r.to_name, ', ') FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToTechnologyStack') AS capabilities,
            (SELECT COUNT(*) FROM leanix_relations r
              WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToApplication') AS app_count,
            m.input_hash,
            m.identified,
            CAST(strftime('%s', m.researched_at) AS INTEGER) * 1000 AS researched_at_ms,
            CASE WHEN m.error IS NOT NULL THEN 1 ELSE 0 END AS had_error
        FROM leanix_factsheets f
        LEFT JOIN leanix_market_research m ON m.factsheet_id = f.id
        ORDER BY f.name COLLATE NOCASE
    `).all().map(row => {
        const candidate = row as CandidateRow;
        candidate.priority = priorityOf(candidate);
        return candidate;
    });
}

/**
 * How much of the portfolio depends on this factsheet, as a tie-break for the
 * batch cap.
 *
 * Dependent applications dominate deliberately — they are the count that says
 * how far a problem would spread — with criticality as a nudge so that a
 * mission-critical component with few recorded dependants is not sorted below
 * an incidental one. The absolute scale is meaningless; only the order is used.
 */
function priorityOf(row: CandidateRow): number {
    const criticality = ({
        missionCritical: 30,
        businessCritical: 20,
        businessOperational: 10,
        administrativeService: 0
    } as Record<string, number>)[row.business_criticality ?? ''] ?? 0;
    return (row.app_count || 0) + criticality;
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
        unidentifiedTtlMs: UNIDENTIFIED_TTL_MS,
        errorRetryMs: ERROR_RETRY_MS,
        force
    });
}

/** The identity call's view of a factsheet. Everything else stays behind. */
function identityInputOf(row: CandidateRow): IdentityInput {
    return {
        fsType: row.fs_type,
        name: row.name,
        alias: row.alias ?? null,
        vendor: row.vendor,
        category: row.category ?? null,
        description: row.description ?? null
    };
}

/**
 * Works out what to search for, and never fails the run doing it.
 *
 * A resolution error is not worth abandoning a factsheet over: the fallback is
 * the name this feature searched for before the call existed, minus its local
 * decoration. Worst case the search is as good as it used to be.
 */
async function resolveSubject(
    row: CandidateRow,
    subject: MarketSubject
): Promise<{ subject: MarketSubject; identity: ResolvedIdentity }> {
    try {
        const identity = await resolveProductIdentity(identityInputOf(row));
        return { subject: applyIdentity(subject, identity), identity };
    } catch (e) {
        console.warn(`[Market] Identity resolution failed for ${subject.label}:`, (e as Error)?.message ?? e);
        const fallback: ResolvedIdentity = { product: null, vendor: null, inHouse: false, note: null };
        return { subject: applyIdentity(subject, fallback), identity: fallback };
    }
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
    /** Of the unidentified, those the identity call settled without a search. */
    inHouse: number;
    /** Factsheets searched for under a name other than their own. */
    renamed: number;
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
        status: 'ok', due: 0, researched: 0, identified: 0, unidentified: 0,
        inHouse: 0, renamed: 0, alerts: 0, failed: [], searches: 0
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
            const { row, hash } = candidate;
            let subject = candidate.subject;
            try {
                // What to search for, decided before anything is spent on it.
                const resolved = await resolveSubject(row, subject);
                subject = resolved.subject;

                if (resolved.identity.inHouse) {
                    // No search is issued at all. This is the cheap half of the
                    // gate: the answer for a bespoke system is knowable from the
                    // record itself, and a grounded request could only confirm it
                    // at full price.
                    persistAssessment(row.id, subject, hash, model, failedAssessment(), null);
                    result.researched++;
                    result.unidentified++;
                    result.inHouse++;
                    console.log(
                        `[Market] ${subject.label}: no public product behind it` +
                        `${resolved.identity.note ? ` (${resolved.identity.note})` : ''} — not searched.`
                    );
                    continue;
                }

                if (subject.name !== candidate.subject.name) {
                    result.renamed++;
                    console.log(`[Market] ${candidate.subject.name} → searching as "${subject.name}".`);
                }

                const { brief, sources, queries } = await researchProduct(subject);
                result.searches++;

                if (briefIsEmpty(brief)) {
                    // Not a failure: some records have no market to research, and
                    // recording that plainly is what stops it being retried from
                    // scratch every week.
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

    // Filtered in JS against the same predicate the write side uses, rather than
    // by a second date rule expressed in SQL. A stored alert ages out between
    // refreshes, and the two counts disagreeing is exactly the kind of drift a
    // duplicated rule produces.
    const now = Date.now();
    const alertRows = db.prepare(
        'SELECT severity, event_date FROM leanix_market_alerts'
    ).all() as { severity: string; event_date: string | null }[];
    const current = alertRows.filter(a => isCurrentEvent(a.event_date, now));

    return {
        configured: marketResearchConfigured(),
        total,
        researched: counts.researched,
        identified: counts.identified ?? 0,
        errored: counts.errored ?? 0,
        alerts: current.length,
        urgentAlerts: current.filter(a => a.severity === 'critical' || a.severity === 'high').length,
        lastRunAt: getAppStateNumber(LAST_RUN_KEY),
        ttlMs: TTL_MS,
        batchLimit: BATCH_LIMIT,
        alertWindowMonths: ALERT_WINDOW_MONTHS,
        running: runInProgress
    };
}

let researchTimer: ReturnType<typeof setInterval> | null = null;

/** Factsheets that have never been looked at, at all. */
function unresearchedCount(): number {
    return (db.prepare(`
        SELECT COUNT(*) AS c
        FROM leanix_factsheets f
        LEFT JOIN leanix_market_research m ON m.factsheet_id = f.id
        WHERE m.factsheet_id IS NULL
    `).get() as { c: number }).c;
}

/**
 * Hourly tick guarding a daily interval — the same shape as the LeanIX sync, and
 * for the same reason: the guard is what makes a restart-heavy deployment behave,
 * since a container that restarts twice a day would otherwise either research
 * twice or, with a naive daily timer, never.
 *
 * The interval is the daily one only once the portfolio has been covered. While
 * factsheets remain that have never been looked at, the guard drops to
 * BACKFILL_INTERVAL_MS: a daily clock against a batch of ten needed more than a
 * week to reach the end of seventy-eight factsheets, which left the page mostly
 * empty and — because the queue was alphabetical — missing exactly the
 * well-known platforms an architect would check first. The steady-state budget
 * is untouched; only the empty-page case is hurried.
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
        const remaining = unresearchedCount();
        const interval = remaining > 0 ? BACKFILL_INTERVAL_MS : RUN_INTERVAL_MS;
        if (Date.now() - last < interval) return;
        if (remaining > 0) {
            console.log(`[Market] Backfilling — ${remaining} factsheet(s) never researched.`);
        }
        runMarketResearch().catch(err => console.error('[Market] Scheduled run failed:', err));
    };

    researchTimer = setInterval(tick, 60 * 60 * 1000);
    researchTimer.unref?.();

    const firstRun = setTimeout(tick, 10 * 60 * 1000);
    firstRun.unref?.();
}
