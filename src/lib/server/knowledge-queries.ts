/**
 * Paged, SQL-side queries for the knowledge explorer and its admin twin.
 *
 * ## Why this exists
 *
 * Both pages were built on a single endpoint that returned the ENTIRE graph —
 * every topic with its description, every relationship, every claim with its
 * full text — and then did the filtering, counting and grouping in the browser.
 * On this corpus that is 1585 topics + 4170 relationships + 2178 claims in one
 * JSON response, and the cost was quadratic on top of it: each rendered topic
 * card ran `data.claims.filter(...)` and `data.relationships.filter(...)` over
 * the whole arrays, so drawing N cards touched N × (claims + relationships)
 * rows. The page got slower with every ingested document, exactly as reported.
 *
 * Everything here is bounded: a page of results, the counts computed by SQLite
 * (which has indexes for it), and no column the caller didn't ask for. The
 * embedding BLOBs — 12KB per topic and per claim — were never needed by any UI
 * and are never selected.
 *
 * Pure-SQL helpers with no HTTP concerns, so the two route handlers stay thin and
 * the pagination arithmetic is unit-testable (see knowledge-queries.test.ts).
 */
import { db } from './db';
import { foldDiacritics } from './topic-normalize';

/** Default page size — "top 20" is the requested default everywhere. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Hard ceiling on a single page, so a hand-written `?pageSize=100000` cannot
 * reintroduce the unbounded response this module exists to remove.
 */
export const MAX_PAGE_SIZE = 200;

export interface Paged<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

/**
 * Clamps user-supplied paging parameters. Page numbers are 1-based; anything
 * unparseable falls back to the first page rather than erroring, because these
 * arrive from a URL a person may have edited.
 */
export function normalizePaging(
    rawPage: string | number | null | undefined,
    rawPageSize: string | number | null | undefined
): { page: number; pageSize: number; offset: number } {
    const parsedSize = Math.trunc(Number(rawPageSize));
    const pageSize =
        Number.isFinite(parsedSize) && parsedSize > 0 ? Math.min(parsedSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    const parsedPage = Math.trunc(Number(rawPage));
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Total page count for `total` rows, at least 1 so the UI never shows "page 1 of 0". */
export function pageCount(total: number, pageSize: number): number {
    return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/**
 * Escapes LIKE metacharacters so a search term is matched literally; pair with
 * `ESCAPE '\'`. Same reasoning as rag.ts's escapeLikePattern — the extracted
 * vocabulary is full of underscores (`is_part_of`, `max_connections`), and an
 * unescaped `_` is a live false-positive source rather than a theoretical one.
 */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * SQLite's LIKE and LOWER are ASCII-only, so `Řízení` cannot be matched by
 * typing `rizeni` through SQL alone. Topic names have a pre-folded
 * `canonical_key` column for exactly this, and it is matched alongside the raw
 * LIKE — so searching this Czech-language corpus works with or without
 * diacritics on the one column where a folded form exists. Descriptions and
 * claim text have no folded counterpart and remain accent-sensitive; making them
 * accent-insensitive would require either a folded shadow column or loading
 * every row into JS, which is what this module is removing.
 */
function searchClauses(search: string): { sql: string; params: string[] } | null {
    const term = search.trim();
    if (!term) return null;
    const like = `%${escapeLike(term)}%`;
    const folded = `%${escapeLike(foldDiacritics(term.toLowerCase()))}%`;
    return {
        sql: `(t.name LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.canonical_key LIKE ? ESCAPE '\\')`,
        params: [like, like, folded]
    };
}

export interface TopicListRow {
    id: number;
    name: string;
    description: string | null;
    category: string | null;
    parent_topic_id: number | null;
    community_id: number | null;
    claim_count: number;
    rel_count: number;
}

export type TopicSort = 'connections' | 'claims' | 'name' | 'recent';

export interface TopicQuery {
    search?: string | null;
    category?: string | null;
    page?: number | string | null;
    pageSize?: number | string | null;
    sort?: string | null;
    /** Include claims in non-active states in `claim_count` (admin review views). */
    includeInactiveClaims?: boolean;
}

const TOPIC_SORTS: Record<TopicSort, string> = {
    // Default: the topics that carry the most knowledge, so page 1 is the
    // useful page rather than whichever rows SQLite returns first.
    connections: 'rel_count DESC, claim_count DESC, t.name ASC',
    claims: 'claim_count DESC, rel_count DESC, t.name ASC',
    name: 't.name ASC',
    recent: 't.created_at DESC, t.id DESC'
};

function resolveTopicSort(sort: string | null | undefined): string {
    return TOPIC_SORTS[(sort ?? 'connections') as TopicSort] ?? TOPIC_SORTS.connections;
}

export function listTopics(query: TopicQuery): Paged<TopicListRow> {
    const { page, pageSize, offset } = normalizePaging(query.page, query.pageSize);
    const where: string[] = [];
    const params: unknown[] = [];

    const search = query.search ? searchClauses(query.search) : null;
    if (search) {
        where.push(search.sql);
        params.push(...search.params);
    }
    if (query.category && query.category !== 'All') {
        where.push('t.category = ?');
        params.push(query.category);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const claimStatusSql = query.includeInactiveClaims ? '' : `AND kc.status = 'active'`;

    const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM topics t ${whereSql}`).get(...params) as { c: number }
    ).c;

    // The counts are aggregated in two grouped subqueries rather than as
    // correlated subqueries per row: correlated ones cannot be used by the ORDER
    // BY that decides *which* rows the page contains, so they would sort the page
    // by a column computed after the LIMIT.
    const items = db
        .prepare(
            `
            WITH claim_counts AS (
                SELECT topic_id, COUNT(*) AS n FROM knowledge_claims kc
                WHERE 1=1 ${claimStatusSql}
                GROUP BY topic_id
            ),
            rel_counts AS (
                SELECT topic_id, SUM(n) AS n FROM (
                    SELECT source_topic_id AS topic_id, COUNT(*) AS n FROM topic_relationships GROUP BY source_topic_id
                    UNION ALL
                    SELECT target_topic_id AS topic_id, COUNT(*) AS n FROM topic_relationships GROUP BY target_topic_id
                )
                GROUP BY topic_id
            )
            SELECT t.id, t.name, t.description, t.category, t.parent_topic_id, t.community_id,
                   COALESCE(cc.n, 0) AS claim_count,
                   COALESCE(rc.n, 0) AS rel_count
            FROM topics t
            LEFT JOIN claim_counts cc ON cc.topic_id = t.id
            LEFT JOIN rel_counts rc ON rc.topic_id = t.id
            ${whereSql}
            ORDER BY ${resolveTopicSort(query.sort)}
            LIMIT ? OFFSET ?
        `
        )
        .all(...params, pageSize, offset) as TopicListRow[];

    return { items, total, page, pageSize, totalPages: pageCount(total, pageSize) };
}

export interface ClaimListRow {
    id: number;
    topic_id: number;
    topic_name: string;
    topic_category: string | null;
    doc_id: number | null;
    doc_name: string | null;
    claim_text: string;
    claim_type: string;
    status: string;
    created_at: string;
    superseded_by: number | null;
    superseded_at: string | null;
    successor_text: string | null;
}

export interface ClaimQuery {
    search?: string | null;
    /** Topic id, or topic name for the "filtered to <topic>" link from a card. */
    topicId?: number | string | null;
    topicName?: string | null;
    category?: string | null;
    /** `active` (default), a specific status, or `all`. */
    status?: string | null;
    page?: number | string | null;
    pageSize?: number | string | null;
    sort?: string | null;
}

const CLAIM_SORTS: Record<string, string> = {
    recent: 'kc.created_at DESC, kc.id DESC',
    topic: 't.name ASC, kc.created_at DESC',
    retired: 'kc.superseded_at DESC, kc.id DESC'
};

export function listClaims(query: ClaimQuery): Paged<ClaimListRow> {
    const { page, pageSize, offset } = normalizePaging(query.page, query.pageSize);
    const where: string[] = [];
    const params: unknown[] = [];

    // Status handling is the security-relevant part of this query: superseded
    // claims are retired history, and the user-facing explorer must never present
    // one as current. The route decides what to pass; `all` is admin-only there.
    const status = (query.status ?? 'active').toLowerCase();
    if (status !== 'all') {
        where.push('kc.status = ?');
        params.push(status);
    }

    if (query.search) {
        const term = query.search.trim();
        if (term) {
            const like = `%${escapeLike(term)}%`;
            const folded = `%${escapeLike(foldDiacritics(term.toLowerCase()))}%`;
            where.push(`(kc.claim_text LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\' OR t.canonical_key LIKE ? ESCAPE '\\')`);
            params.push(like, like, folded);
        }
    }

    const topicId = Number(query.topicId);
    if (Number.isFinite(topicId) && topicId > 0) {
        where.push('kc.topic_id = ?');
        params.push(topicId);
    } else if (query.topicName) {
        where.push('t.name = ?');
        params.push(query.topicName);
    }

    if (query.category && query.category !== 'All') {
        where.push('t.category = ?');
        params.push(query.category);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
        db
            .prepare(
                `SELECT COUNT(*) AS c
                 FROM knowledge_claims kc
                 JOIN topics t ON kc.topic_id = t.id
                 ${whereSql}`
            )
            .get(...params) as { c: number }
    ).c;

    const orderBy = CLAIM_SORTS[query.sort ?? 'recent'] ?? CLAIM_SORTS.recent;

    const items = db
        .prepare(
            `
            SELECT kc.id, kc.topic_id, kc.doc_id, kc.claim_text, kc.status, kc.created_at,
                   kc.superseded_by, kc.superseded_at,
                   COALESCE(kc.claim_type, 'assertion') AS claim_type,
                   t.name AS topic_name, t.category AS topic_category,
                   d.filename AS doc_name,
                   succ.claim_text AS successor_text
            FROM knowledge_claims kc
            JOIN topics t ON kc.topic_id = t.id
            LEFT JOIN documents d ON kc.doc_id = d.id
            LEFT JOIN knowledge_claims succ ON succ.id = kc.superseded_by
            ${whereSql}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `
        )
        .all(...params, pageSize, offset) as ClaimListRow[];

    return { items, total, page, pageSize, totalPages: pageCount(total, pageSize) };
}

/**
 * Headline counts for the explorer and the admin dashboard.
 *
 * Previously derived in the browser by filtering the full claim array four
 * times; here it is four indexed COUNTs and one GROUP BY.
 */
export function knowledgeStats(): {
    topics: number;
    relationships: number;
    claims: number;
    conflicting: number;
    flagged: number;
    superseded: number;
    categories: { category: string; count: number }[];
    orphanTopics: number;
} {
    const one = (sql: string, ...params: unknown[]) =>
        (db.prepare(sql).get(...params) as { c: number }).c;

    const byStatus = db
        .prepare(`SELECT status, COUNT(*) AS c FROM knowledge_claims GROUP BY status`)
        .all() as { status: string; c: number }[];
    const statusCount = (s: string) => byStatus.find(r => r.status === s)?.c ?? 0;

    const categories = db
        .prepare(
            `SELECT COALESCE(category, 'Uncategorized') AS category, COUNT(*) AS count
             FROM topics GROUP BY COALESCE(category, 'Uncategorized') ORDER BY count DESC, category ASC`
        )
        .all() as { category: string; count: number }[];

    return {
        topics: one('SELECT COUNT(*) AS c FROM topics'),
        relationships: one('SELECT COUNT(*) AS c FROM topic_relationships'),
        claims: statusCount('active') + statusCount('conflicting') + statusCount('flagged'),
        conflicting: statusCount('conflicting'),
        flagged: statusCount('flagged'),
        superseded: statusCount('superseded'),
        categories,
        // Topics with no relationship in either direction — the population that
        // used to float around the graph canvas as disconnected circles. Counted
        // so the graph view can say how many it is deliberately not drawing.
        orphanTopics: one(
            `SELECT COUNT(*) AS c FROM topics t
             WHERE NOT EXISTS (SELECT 1 FROM topic_relationships r
                               WHERE r.source_topic_id = t.id OR r.target_topic_id = t.id)`
        )
    };
}

/** Distinct topic categories, for filter controls. */
export function listCategories(): string[] {
    return db
        .prepare(`SELECT DISTINCT category FROM topics WHERE category IS NOT NULL AND category <> '' ORDER BY category`)
        .pluck()
        .all() as string[];
}

export interface TopicTreeRow {
    id: number;
    name: string;
    category: string | null;
    parent_topic_id: number | null;
    claim_count: number;
    rel_count: number;
}

/**
 * Slim rows for the admin hierarchy view, which genuinely needs every topic to
 * build the parent/child tree. Descriptions and embeddings are excluded, which is
 * what makes "all rows" affordable: ~60 bytes per topic instead of ~12KB.
 */
export function topicTree(limit = 5000): TopicTreeRow[] {
    return db
        .prepare(
            `
            WITH claim_counts AS (
                SELECT topic_id, COUNT(*) AS n FROM knowledge_claims WHERE status = 'active' GROUP BY topic_id
            ),
            rel_counts AS (
                SELECT topic_id, SUM(n) AS n FROM (
                    SELECT source_topic_id AS topic_id, COUNT(*) AS n FROM topic_relationships GROUP BY source_topic_id
                    UNION ALL
                    SELECT target_topic_id AS topic_id, COUNT(*) AS n FROM topic_relationships GROUP BY target_topic_id
                )
                GROUP BY topic_id
            )
            SELECT t.id, t.name, t.category, t.parent_topic_id,
                   COALESCE(cc.n, 0) AS claim_count,
                   COALESCE(rc.n, 0) AS rel_count
            FROM topics t
            LEFT JOIN claim_counts cc ON cc.topic_id = t.id
            LEFT JOIN rel_counts rc ON rc.topic_id = t.id
            ORDER BY t.name
            LIMIT ?
        `
        )
        .all(limit) as TopicTreeRow[];
}
