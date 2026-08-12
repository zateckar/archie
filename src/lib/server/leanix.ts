import { db, getAppState, getAppStateNumber, setAppState, reattributeSharedClaims } from './db';
import { addDocument } from './rag';
import {
    placeTaxonomyForNewTopics,
    isFullTaxonomyRebuildDue,
    rebuildTaxonomy,
    sweepOrphanTopics
} from './knowledge';
import { recomputeCommunities } from './communities';
import {
    normalizeFactsheet,
    extractRelations,
    extractSubscriptions,
    buildFactsheetMarkdown,
    factsheetContentHash,
    factsheetFilename,
    humanizeEnum,
    type LeanixNode,
    type LeanixFactsheetRow,
    type LeanixRelationRow,
    type LeanixSubscriptionRow
} from './leanix-format';

/**
 * LeanIX as a read-only datasource.
 *
 * ── This module never writes to LeanIX ──────────────────────────────────────
 * Every call goes through `leanixQuery`, which refuses any GraphQL document
 * containing a mutation (`assertQueryOnly`). There is no other exit to the
 * network in this file, no REST client, and nothing analogous to the git sync's
 * commit-and-push of cleaned copies. LeanIX is read, never touched.
 *
 * ── The request budget ──────────────────────────────────────────────────────
 * Requests to LeanIX are treated as the scarce resource. A day on which nothing
 * changed costs TWO HTTP requests in total:
 *
 *   1. one token request (the bearer lives an hour and is cached for its life);
 *   2. one *probe* query returning nothing but `id, type, updatedAt` for the
 *      tagged set — a few KB.
 *
 * Only if the probe shows a changed/added/removed factsheet does the sync spend
 * the two full field queries (one per factsheet type — a combined query is
 * impossible, see FACTSHEET_QUERIES). So the steady state is 2 requests/day,
 * a change day is 4, and nothing else in the app ever calls LeanIX: the
 * analytics page and the chat pipeline read SQLite.
 *
 * The one thing the probe cannot see is an edit to a *related* factsheet — if a
 * provider is renamed, the components pointing at it keep their old `updatedAt`.
 * `LEANIX_FULL_REFRESH_DAYS` (default 7) forces a full fetch on that cadence so
 * the copy cannot drift indefinitely.
 */

// ── Configuration ───────────────────────────────────────────────────────────

const TOKEN_URL = process.env.LEANIX_TOKEN_URL ?? '';
const TOKEN_CREDENTIALS = process.env.LEANIX_TOKEN_CREDENTIALS ?? '';
const API_URL = (process.env.LEANIX_API_URL ?? '').replace(/\/+$/, '');
const EXTRA_HEADER_KEY = process.env.LEANIX_API_EXTRA_HEADER_KEY ?? '';
const EXTRA_HEADER_VALUE = process.env.LEANIX_API_EXTRA_HEADER_VALUE ?? '';

/**
 * The tag whose factsheets are synced, by id.
 *
 * Configured as an ID rather than a name on purpose: resolving "SKODA Strategic
 * IT Product: Enterprise" to an id needs an `allTags` query returning the
 * workspace's whole tag list, and paying that on every boot contradicts the
 * budget above. To find the id of a different tag, run this query once by hand:
 *
 *   { allTags { edges { node { id name tagGroup { name } } } } }
 *
 * The default is the id of "Enterprise" in the "SKODA Strategic IT Product"
 * group, which is what this integration was built for.
 */
const TAG_ID = process.env.LEANIX_TAG_ID ?? 'f041d49a-8692-44bb-8be1-d752b3514c0b';

/**
 * Factsheet types to sync. The tag is restricted to Application, ITComponent and
 * digitalProduct; the first two are what actually carry it (64 components and 14
 * applications at the time of writing). Adding a type here also needs a query
 * body in FACTSHEET_QUERIES — fields differ per type.
 */
const FACTSHEET_TYPES = (process.env.LEANIX_FACTSHEET_TYPES ?? 'ITComponent,Application')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

const SYNC_INTERVAL_MS = envInt('LEANIX_SYNC_INTERVAL_MS', 24 * 60 * 60 * 1000);
const FULL_REFRESH_MS = envInt('LEANIX_FULL_REFRESH_DAYS', 7) * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = envInt('LEANIX_REQUEST_TIMEOUT_MS', 120000);

const LAST_SYNC_KEY = 'leanix:last-sync-at';
const LAST_FULL_FETCH_KEY = 'leanix:last-full-fetch-at';
const WORKSPACE_URL_KEY = 'leanix:workspace-url';

function envInt(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Whether enough is configured to talk to LeanIX at all. */
export function leanixConfigured(): boolean {
    return Boolean(TOKEN_URL && TOKEN_CREDENTIALS && API_URL);
}

// ── Transport ───────────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * The browsable workspace URL — the base of every "open in LeanIX" link.
 *
 * Derived from the access token rather than configured, because the token
 * already carries both halves and nothing else does: `instanceUrl` names the
 * regional host (the API gateway address in LEANIX_API_URL is emphatically NOT
 * browsable) and `principal.permission.workspaceName` names the workspace path
 * segment. Together they produce exactly
 *
 *     https://vwgroup.leanix.net/Volkswagen/factsheet/ITComponent/<id>
 *
 * Costs nothing: the token is fetched anyway, and this reads a claim out of it.
 * The result is persisted to app_state so pages can build links without holding
 * a token, and LEANIX_WORKSPACE_URL still overrides it for a deployment whose
 * users reach LeanIX by some other address.
 */
function rememberWorkspaceUrl(accessToken: string): void {
    try {
        const [, payload] = accessToken.split('.');
        if (!payload) return;
        const claims = JSON.parse(
            Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        ) as { instanceUrl?: string; principal?: { permission?: { workspaceName?: string } } };

        const host = (claims.instanceUrl ?? '').trim().replace(/\/+$/, '');
        const workspace = (claims.principal?.permission?.workspaceName ?? '').trim();
        if (!host || !workspace) return;

        const url = `${host}/${encodeURIComponent(workspace)}`;
        if (getAppState(WORKSPACE_URL_KEY) !== url) {
            setAppState(WORKSPACE_URL_KEY, url);
            console.log(`[LeanIX] Workspace URL for factsheet links: ${url}`);
        }
    } catch (e) {
        // A token whose shape changed must not break the sync — links simply
        // stay absent, which is the same as the pre-existing unconfigured case.
        console.warn('[LeanIX] Could not derive the workspace URL from the access token:', e);
    }
}

/**
 * Base URL for factsheet deep links, or '' when it is not known yet (no sync has
 * run and no override is set), in which case links are omitted rather than
 * guessed into 404s.
 */
export function getWorkspaceUrl(): string {
    const override = (process.env.LEANIX_WORKSPACE_URL ?? '').trim();
    if (override) return override.replace(/\/+$/, '');
    return (getAppState(WORKSPACE_URL_KEY) ?? '').trim();
}

/**
 * Makes sure factsheet links are available, fetching a token purely to read the
 * workspace out of it if it is not known yet.
 *
 * Exists because the URL would otherwise arrive only with the first successful
 * sync, leaving a window — or, for a database seeded some other way, an
 * indefinite state — where the portfolio is full of factsheets that cannot be
 * opened. Costs at most one token request, only when the answer is unknown, and
 * never on a page load: it runs from the boot tick. Returns '' when LeanIX is
 * not configured or the token cannot be read.
 */
export async function ensureWorkspaceUrl(): Promise<string> {
    const known = getWorkspaceUrl();
    if (known || !leanixConfigured()) return known;
    try {
        await getAccessToken(); // side effect: rememberWorkspaceUrl
    } catch (err) {
        console.warn('[LeanIX] Could not resolve the workspace URL:', (err as Error)?.message ?? err);
    }
    return getWorkspaceUrl();
}

/**
 * Every HTTP request this module has made, token requests included.
 *
 * Counted rather than assumed because the whole design is a claim about request
 * volume ("two on a quiet day"), and a claim like that is worth being able to
 * check against the number the sync actually reports.
 */
let requestCount = 0;

/**
 * The read-only guard.
 *
 * Deliberately a hard throw rather than a lint rule or a code review habit: this
 * integration's single most important property is that it cannot modify the
 * enterprise architecture repository, and the only way to make that true of code
 * that has not been written yet is to check at the door. Anonymous queries
 * (`{ ... }`) and `query`-keyword documents pass; anything declaring a mutation
 * or a subscription does not.
 */
export function assertQueryOnly(document: string): void {
    if (/\b(mutation|subscription)\b/i.test(document)) {
        throw new Error(
            'LeanIX integration is read-only: refusing to send a GraphQL document containing a mutation or subscription.'
        );
    }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Bounded retry for transient failures only.
 *
 * 401/403 are never retried: a rejected credential does not become accepted by
 * asking again, and hammering an auth endpoint is how an API token gets blocked.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const message = (err as Error)?.message ?? String(err);
            if (/\b(401|403)\b/.test(message)) throw err;
            if (attempt === attempts) break;
            const delay = 2000 * Math.pow(4, attempt - 1); // 2s, 8s
            console.warn(`[LeanIX] ${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms: ${message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

/**
 * A bearer token, reused until shortly before it expires.
 *
 * LeanIX issues hour-long tokens; a sync takes seconds. Caching means the daily
 * run spends exactly one token request, and a manual "Sync now" minutes later
 * spends none.
 */
async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

    return withRetry('token request', async () => {
        requestCount++;
        const res = await fetchWithTimeout(TOKEN_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${TOKEN_CREDENTIALS}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`LeanIX token request failed: ${res.status} ${body.slice(0, 300)}`);

        const parsed = JSON.parse(body) as { access_token?: string; expires_in?: number };
        if (!parsed.access_token) throw new Error('LeanIX token response contained no access_token');

        const ttlMs = (parsed.expires_in ?? 3600) * 1000;
        cachedToken = { value: parsed.access_token, expiresAt: Date.now() + ttlMs };
        rememberWorkspaceUrl(parsed.access_token);
        return parsed.access_token;
    });
}

/**
 * Runs one GraphQL *query*.
 *
 * Field-level `NO_READ_PERMISSION` errors are reported and then ignored rather
 * than thrown: LeanIX returns them alongside a complete payload in which just
 * that field is null, and this workspace's API token is scoped out of several
 * Application fields (`aggregatedObsolescenceRisk`, `lxSixRClassification`,
 * `lxHostingType`, `lxTransformationStatus`). Treating a scoped-out field as a
 * fatal error would mean no sync at all rather than a sync missing one column.
 */
async function leanixQuery<T>(query: string, label: string): Promise<T> {
    assertQueryOnly(query);
    const token = await getAccessToken();

    return withRetry(label, async () => {
        requestCount++;
        const res = await fetchWithTimeout(`${API_URL}/graphql`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(EXTRA_HEADER_KEY ? { [EXTRA_HEADER_KEY]: EXTRA_HEADER_VALUE } : {})
            },
            body: JSON.stringify({ query })
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`LeanIX ${label} failed: ${res.status} ${body.slice(0, 300)}`);

        const parsed = JSON.parse(body) as { data?: T; errors?: { message: string; extensions?: { errorType?: string } }[] };
        if (parsed.errors?.length) {
            const denied = parsed.errors.filter(e => e.extensions?.errorType === 'NO_READ_PERMISSION');
            const fatal = parsed.errors.filter(e => e.extensions?.errorType !== 'NO_READ_PERMISSION');
            if (denied.length > 0) {
                const fields = [...new Set(denied.map(e => e.message.split(':').pop()?.trim()).filter(Boolean))];
                console.warn(`[LeanIX] ${label}: API token has no read permission for ${fields.join(', ')} — those fields stay empty.`);
            }
            if (fatal.length > 0) {
                throw new Error(`LeanIX ${label} returned errors: ${fatal.map(e => e.message).join('; ')}`);
            }
        }
        if (!parsed.data) throw new Error(`LeanIX ${label} returned no data`);
        return parsed.data;
    });
}

// ── Queries ─────────────────────────────────────────────────────────────────

const TAG_FILTER = `{ facetKey: "_TAGS_", operator: OR, keys: ["${TAG_ID}"] }`;

/**
 * The change probe: ids and revision timestamps only, for every tagged
 * factsheet regardless of type.
 *
 * This one CAN be a single combined query, because `id`, `type` and `updatedAt`
 * are all declared on `BaseFactSheet`. The full queries below cannot: asking for
 * `lifecycle` across both types fails validation with `FieldsConflict`, since
 * Application.lifecycle and ITComponent.lifecycle are different GraphQL types
 * that merely share a name.
 */
const PROBE_QUERY = `{
    allFactSheets(filter: { facetFilters: [
        ${TAG_FILTER},
        { facetKey: "FactSheetTypes", operator: OR, keys: [${FACTSHEET_TYPES.map(t => `"${t}"`).join(', ')}] }
    ]}) {
        totalCount
        edges { node { id type updatedAt } }
    }
}`;

const RELATION = (field: string) => `${field} { edges { node { factSheet { id name type } } } }`;

/** Fields on BaseFactSheet — valid for every factsheet type. */
const COMMON_FIELDS = `
    id name displayName description type updatedAt level
    completion { completion }
    tags { id name tagGroup { name } }
    documents { edges { node { name url documentType } } }
    subscriptions { edges { node { type user { displayName } roles { name } } } }
`;

/**
 * Per-type field selections. Only fields this workspace's token can actually
 * read and that are actually populated — measured, not guessed. Fields left out
 * deliberately because they came back empty on every tagged factsheet:
 * `securityRiskclass`, `relApplicationToDataObject`, `lxVendorLifecycle`,
 * `location`. Fields left out because the token is scoped out of them:
 * `aggregatedObsolescenceRisk`, `lxSixRClassification`, `lxHostingType`,
 * `lxTransformationStatus` — add them back here if those permissions are granted.
 */
const FACTSHEET_QUERIES: Record<string, string> = {
    Application: `
        alias release
        leanixId { externalId }
        lifecycle { asString phases { phase startDate } }
        functionalSuitability technicalSuitability businessCriticality
        dataclass lxTimeClassification TIMERecommendation
        ${RELATION('relApplicationToBusinessCapability')}
        ${RELATION('relApplicationToITComponent')}
        ${RELATION('relApplicationToUserGroup')}
        ${RELATION('relApplicationToProcess')}
        ${RELATION('relApplicationToProject')}
        ${RELATION('relApplicationTodigitalProduct')}
        ${RELATION('relToParent')} ${RELATION('relToChild')}
        ${RELATION('relToPredecessor')} ${RELATION('relToSuccessor')}
    `,
    ITComponent: `
        alias category release
        leanixId { externalId }
        lifecycle { asString phases { phase startDate } }
        technicalSuitability
        ${RELATION('relITComponentToProvider')}
        ${RELATION('relITComponentToApplication')}
        ${RELATION('relITComponentToTechnologyStack')}
        ${RELATION('relITComponentToUserGroup')}
        ${RELATION('relITComponentToProject')}
        ${RELATION('relITComponentTodigitalProduct')}
        ${RELATION('relToParent')} ${RELATION('relToChild')}
        ${RELATION('relToPredecessor')} ${RELATION('relToSuccessor')}
    `
};

interface FactSheetsResponse {
    allFactSheets?: { totalCount?: number; edges?: ({ node?: LeanixNode | null } | null)[] | null } | null;
}

function nodesOf(data: FactSheetsResponse): LeanixNode[] {
    return (data.allFactSheets?.edges ?? [])
        .map(e => e?.node)
        .filter((n): n is LeanixNode => !!n?.id);
}

// ── Sync ────────────────────────────────────────────────────────────────────

export interface LeanixSyncResult {
    status: 'ok' | 'skipped' | 'not-configured';
    requests: number;
    factsheets: number;
    ingested: number;
    removed: number;
    unchanged: number;
    failed: { name: string; reason: string }[];
    reason?: string;
}

let syncInProgress = false;

/**
 * A concise summary stored on the document. `preformatted` ingestion skips the
 * generated summary (see rag.ts), and this is what takes its place: the same
 * facts the knowledge extractor most needs for context, in one sentence.
 */
function buildSummary(fs: LeanixFactsheetRow, relations: LeanixRelationRow[]): string {
    const usedBy = relations.filter(r => r.rel_type === 'relITComponentToApplication').length;
    const capabilities = relations
        .filter(r => r.rel_type === 'relITComponentToTechnologyStack' || r.rel_type === 'relApplicationToBusinessCapability')
        .map(r => r.to_name)
        .filter(Boolean)
        .slice(0, 6);
    const vendor = relations.find(r => r.rel_type === 'relITComponentToProvider')?.to_name;

    return [
        `${fs.name} is a LeanIX ${fs.fs_type} factsheet in the SKODA IT portfolio.`,
        fs.category ? `Category: ${humanizeEnum(fs.category)}.` : '',
        fs.lifecycle_state ? `Lifecycle state: ${humanizeEnum(fs.lifecycle_state)}.` : '',
        fs.technical_fit ? `Technical fit: ${humanizeEnum(fs.technical_fit)}.` : '',
        fs.business_criticality ? `Business criticality: ${humanizeEnum(fs.business_criticality)}.` : '',
        vendor ? `Vendor: ${vendor}.` : '',
        capabilities.length > 0 ? `Capabilities: ${capabilities.join(', ')}.` : '',
        usedBy > 0 ? `Used by ${usedBy} application(s).` : '',
        fs.description ? fs.description.slice(0, 400) : ''
    ]
        .filter(Boolean)
        .join(' ');
}

/**
 * Replaces this factsheet's structured rows. Relations/subscriptions cascade.
 *
 * Exported so a captured API payload can be loaded into the tables without
 * issuing a LeanIX request — the analytics page can then be developed and
 * verified against real data shapes at zero request cost.
 */
export const persistFactsheet = db.transaction(
    (fs: LeanixFactsheetRow, relations: LeanixRelationRow[], subscriptions: LeanixSubscriptionRow[]) => {
        db.prepare(`
            INSERT INTO leanix_factsheets (
                id, fs_type, name, display_name, alias, description, leanix_id, level, category, release,
                lifecycle_state, lifecycle_phases, end_of_life_date, technical_fit, functional_fit,
                business_criticality, data_class, time_classification, time_recommendation, completion,
                documents, tags, updated_at_remote, synced_at
            ) VALUES (
                @id, @fs_type, @name, @display_name, @alias, @description, @leanix_id, @level, @category, @release,
                @lifecycle_state, @lifecycle_phases, @end_of_life_date, @technical_fit, @functional_fit,
                @business_criticality, @data_class, @time_classification, @time_recommendation, @completion,
                @documents, @tags, @updated_at_remote, CURRENT_TIMESTAMP
            )
            ON CONFLICT(id) DO UPDATE SET
                fs_type = excluded.fs_type, name = excluded.name, display_name = excluded.display_name,
                alias = excluded.alias, description = excluded.description, leanix_id = excluded.leanix_id,
                level = excluded.level, category = excluded.category, release = excluded.release,
                lifecycle_state = excluded.lifecycle_state, lifecycle_phases = excluded.lifecycle_phases,
                end_of_life_date = excluded.end_of_life_date, technical_fit = excluded.technical_fit,
                functional_fit = excluded.functional_fit, business_criticality = excluded.business_criticality,
                data_class = excluded.data_class, time_classification = excluded.time_classification,
                time_recommendation = excluded.time_recommendation, completion = excluded.completion,
                documents = excluded.documents, tags = excluded.tags,
                updated_at_remote = excluded.updated_at_remote, synced_at = CURRENT_TIMESTAMP
        `).run(fs);

        db.prepare('DELETE FROM leanix_relations WHERE from_id = ?').run(fs.id);
        const insertRel = db.prepare(
            'INSERT OR IGNORE INTO leanix_relations (from_id, rel_type, to_id, to_name, to_type) VALUES (?, ?, ?, ?, ?)'
        );
        for (const r of relations) insertRel.run(r.from_id, r.rel_type, r.to_id, r.to_name, r.to_type);

        db.prepare('DELETE FROM leanix_subscriptions WHERE factsheet_id = ?').run(fs.id);
        const insertSub = db.prepare(
            'INSERT OR IGNORE INTO leanix_subscriptions (factsheet_id, subscription_type, role_name, display_name) VALUES (?, ?, ?, ?)'
        );
        for (const s of subscriptions) insertSub.run(s.factsheet_id, s.subscription_type, s.role_name, s.display_name);
    }
);

/**
 * Runs a LeanIX sync.
 *
 * `force` skips the change probe and fetches everything — what the admin
 * "Sync now" button sends, and what the weekly full refresh uses. It still
 * hash-gates ingestion, so forcing a fetch does not force LLM work.
 */
export async function syncLeanix(options: { force?: boolean } = {}): Promise<LeanixSyncResult> {
    const empty: LeanixSyncResult = {
        status: 'ok', requests: 0, factsheets: 0, ingested: 0, removed: 0, unchanged: 0, failed: []
    };

    if (!leanixConfigured()) {
        return { ...empty, status: 'not-configured', reason: 'LEANIX_TOKEN_URL, LEANIX_TOKEN_CREDENTIALS and LEANIX_API_URL must be set' };
    }
    if (syncInProgress) {
        return { ...empty, status: 'skipped', reason: 'a sync is already running' };
    }

    syncInProgress = true;
    const requestsAtStart = requestCount;
    const requestsSoFar = () => requestCount - requestsAtStart;
    try {
        // Stamp the attempt immediately, so a sync that dies partway does not
        // leave the scheduler re-firing it every minute (the same reasoning as
        // syncGitRepo's opening UPDATE).
        setAppState(LAST_SYNC_KEY, String(Date.now()));

        const lastFullFetch = getAppStateNumber(LAST_FULL_FETCH_KEY) ?? 0;
        const fullRefreshDue = Date.now() - lastFullFetch >= FULL_REFRESH_MS;
        const knownCount = (db.prepare('SELECT COUNT(*) AS c FROM leanix_factsheets').get() as { c: number }).c;

        // ── The cheap path ────────────────────────────────────────────────────
        let mustFetch = options.force || fullRefreshDue || knownCount === 0;
        if (!mustFetch) {
            const probe = await leanixQuery<FactSheetsResponse>(PROBE_QUERY, 'change probe');
            const remote = new Map(nodesOf(probe).map(n => [n.id, n.updatedAt ?? '']));
            const local = new Map(
                (db.prepare('SELECT id, updated_at_remote FROM leanix_factsheets').all() as
                    { id: string; updated_at_remote: string | null }[]).map(r => [r.id, r.updated_at_remote ?? ''])
            );

            const changed =
                remote.size !== local.size ||
                [...remote].some(([id, updatedAt]) => local.get(id) !== updatedAt);

            if (!changed) {
                console.log(
                    `[LeanIX] No changes across ${remote.size} tagged factsheet(s) — nothing fetched ` +
                    `(${requestsSoFar()} LeanIX request(s)).`
                );
                return { ...empty, factsheets: remote.size, unchanged: remote.size, requests: requestsSoFar() };
            }
            console.log(`[LeanIX] Probe reports changes (${local.size} known → ${remote.size} remote) — fetching full factsheets.`);
            mustFetch = true;
        } else {
            console.log(
                `[LeanIX] Full fetch: ${options.force ? 'forced' : knownCount === 0 ? 'no local copy yet' : 'weekly refresh due'}.`
            );
        }

        // ── The full fetch: one query per factsheet type ──────────────────────
        const nodes: LeanixNode[] = [];
        for (const type of FACTSHEET_TYPES) {
            const body = FACTSHEET_QUERIES[type];
            if (!body) {
                console.warn(`[LeanIX] No query defined for factsheet type "${type}" — skipping it.`);
                continue;
            }
            const query = `{
                allFactSheets(filter: { facetFilters: [
                    ${TAG_FILTER},
                    { facetKey: "FactSheetTypes", operator: OR, keys: ["${type}"] }
                ]}) {
                    totalCount
                    edges { node { ${COMMON_FIELDS} ... on ${type} { ${body} } } }
                }
            }`;
            const data = await leanixQuery<FactSheetsResponse>(query, `${type} fetch`);
            const typeNodes = nodesOf(data);
            console.log(`[LeanIX] Fetched ${typeNodes.length} ${type} factsheet(s).`);
            nodes.push(...typeNodes);
        }
        setAppState(LAST_FULL_FETCH_KEY, String(Date.now()));

        if (nodes.length === 0) {
            // Never let an empty response delete the corpus: an auth or filter
            // regression returns zero rows just as convincingly as a genuinely
            // emptied tag, and one of those two is recoverable.
            console.warn('[LeanIX] Fetch returned no factsheets — leaving the existing copy untouched.');
            return { ...empty, status: 'skipped', reason: 'fetch returned no factsheets', requests: requestsSoFar() };
        }

        // ── Persist + hash-gated ingestion ────────────────────────────────────
        const existing = new Map(
            (db.prepare('SELECT id, content_hash, doc_id FROM leanix_factsheets').all() as
                { id: string; content_hash: string | null; doc_id: number | null }[]).map(r => [r.id, r])
        );

        let ingested = 0;
        let unchanged = 0;
        const failed: { name: string; reason: string }[] = [];
        const seen = new Set<string>();

        for (const node of nodes) {
            seen.add(node.id);
            const fs = normalizeFactsheet(node);
            const relations = extractRelations(node);
            const subscriptions = extractSubscriptions(node);

            // Structured rows are refreshed unconditionally — they are cheap, and
            // the analytics page should reflect the fetch even when the document
            // text is unchanged.
            persistFactsheet(fs, relations, subscriptions);

            const markdown = buildFactsheetMarkdown(fs, relations, subscriptions, getWorkspaceUrl());
            const hash = factsheetContentHash(markdown);
            const prior = existing.get(node.id);

            // The document must still exist AND still have chunks; a factsheet
            // whose document was deleted by hand has a matching hash and nothing
            // indexed.
            const documentIntact = prior?.doc_id
                ? !!db.prepare('SELECT 1 FROM chunks WHERE doc_id = ? LIMIT 1').get(prior.doc_id)
                : false;

            if (prior?.content_hash === hash && documentIntact) {
                unchanged++;
                continue;
            }

            try {
                const { docId } = await addDocument(factsheetFilename(fs), markdown, {
                    source: 'leanix',
                    sourceRef: fs.id,
                    preformatted: true,
                    summary: buildSummary(fs, relations),
                    batch: true
                });
                db.prepare('UPDATE leanix_factsheets SET content_hash = ?, doc_id = ? WHERE id = ?')
                    .run(hash, Number(docId), fs.id);
                ingested++;
            } catch (err) {
                const reason = (err as Error)?.message ?? String(err);
                failed.push({ name: fs.name, reason });
                console.error(`[LeanIX] Failed to ingest factsheet "${fs.name}":`, reason);
            }
        }

        // ── Factsheets that lost the tag ──────────────────────────────────────
        let removed = 0;
        for (const [id, row] of existing) {
            if (seen.has(id)) continue;
            if (row.doc_id) {
                // Same ordering as git sync's deletion sweep: hand shared facts to
                // a surviving document before the cascade takes them.
                reattributeSharedClaims(row.doc_id);
                db.prepare('DELETE FROM documents WHERE id = ?').run(row.doc_id);
            }
            db.prepare('DELETE FROM leanix_factsheets WHERE id = ?').run(id);
            removed++;
        }
        if (removed > 0) {
            console.log(`[LeanIX] Removed ${removed} factsheet(s) that no longer carry the tag.`);
            sweepOrphanTopics();
        }

        // ── Graph tail, only when the corpus actually moved ───────────────────
        if (ingested > 0 || removed > 0) {
            try {
                const scheduled = isFullTaxonomyRebuildDue();
                const placement = scheduled ? null : await placeTaxonomyForNewTopics();
                if (scheduled || placement?.status === 'needs-full-rebuild') {
                    const result = await rebuildTaxonomy();
                    console.log(`[LeanIX] Taxonomy rebuilt: ${result.updated}/${result.total} topics assigned parents.`);
                } else {
                    console.log(`[LeanIX] Taxonomy: placed ${placement!.placed}/${placement!.orphans} orphan topic(s).`);
                }
            } catch (err) {
                console.error('[LeanIX] Taxonomy pass failed:', err);
            }

            try {
                const result = await recomputeCommunities();
                console.log(`[LeanIX] Communities: ${result.communityCount}, reports ${result.reports.generated} generated / ${result.reports.reused} reused.`);
            } catch (err) {
                console.error('[LeanIX] Community recompute failed:', err);
            }
        }

        console.log(
            `[LeanIX] Sync complete: ${nodes.length} factsheet(s), ${ingested} ingested, ${unchanged} unchanged, ` +
            `${removed} removed, ${failed.length} failed, ${requestsSoFar()} LeanIX request(s).`
        );
        return {
            status: 'ok', requests: requestsSoFar(),
            factsheets: nodes.length, ingested, removed, unchanged, failed
        };
    } finally {
        syncInProgress = false;
    }
}

/** Bookkeeping for the admin card and the analytics page header. */
export function leanixStatus() {
    const counts = db.prepare(`
        SELECT fs_type, COUNT(*) AS c FROM leanix_factsheets GROUP BY fs_type
    `).all() as { fs_type: string; c: number }[];
    return {
        configured: leanixConfigured(),
        tagId: TAG_ID,
        factsheetTypes: FACTSHEET_TYPES,
        total: counts.reduce((sum, r) => sum + r.c, 0),
        byType: Object.fromEntries(counts.map(r => [r.fs_type, r.c])),
        lastSyncAt: getAppStateNumber(LAST_SYNC_KEY),
        lastFullFetchAt: getAppStateNumber(LAST_FULL_FETCH_KEY),
        syncIntervalMs: SYNC_INTERVAL_MS,
        fullRefreshMs: FULL_REFRESH_MS,
        syncing: syncInProgress,
        workspaceUrl: getWorkspaceUrl() || null
    };
}

let leanixTimer: NodeJS.Timeout | undefined;

/**
 * Starts the daily sync.
 *
 * The tick is hourly rather than the git sync's minute, because the interval it
 * guards is a day: a minute tick would wake 1440 times to make one decision.
 * Nothing here contacts LeanIX unless the interval has actually elapsed.
 */
export function initLeanixSync() {
    if (leanixTimer) clearInterval(leanixTimer);
    if (!leanixConfigured()) {
        console.log('[LeanIX] Not configured — daily sync disabled.');
        return;
    }

    const tick = () => {
        // Cheap and idempotent: a no-op once the URL is known, so this does not
        // add a request per tick.
        ensureWorkspaceUrl().catch(() => {});

        const last = getAppStateNumber(LAST_SYNC_KEY) ?? 0;
        if (Date.now() - last < SYNC_INTERVAL_MS) return;
        syncLeanix().catch(err => console.error('[LeanIX] Scheduled sync failed:', err));
    };

    leanixTimer = setInterval(tick, 60 * 60 * 1000);
    leanixTimer.unref?.();
    // One check shortly after boot, so a container that restarts daily still
    // syncs — but delayed, so it does not compete with embedding migration.
    const boot = setTimeout(tick, 60_000);
    boot.unref?.();
}
