import { db } from './db';

/**
 * Everything the app does to a conversation *besides* answering in it.
 *
 * Listing, reading back, pinning, deleting and rating all existed inline in
 * `routes/api/conversations`, `routes/api/chat/history` and
 * `routes/api/feedback`. They moved here when the MCP server became a second
 * front door: these are ownership-sensitive operations, and the one thing worse
 * than two copies of a SQL query is two copies of an authorization check. Every
 * function here takes the acting user's id and scopes to it — there is no
 * unscoped variant to reach for by accident.
 *
 * Answering lives in ./chat-pipeline, which is the other half of the same idea.
 */

export interface ConversationSummary {
    id: string;
    title: string;
    pinned: number;
    created_at: string;
    updated_at: string;
}

export interface TranscriptMessage {
    role: string;
    content: string;
    sources: SourceRecord[];
}

export interface SourceRecord {
    filename: string;
    path?: string | null;
    repo_id?: number | null;
}

/** Escapes the LIKE wildcards so a query of "100%" matches literally. */
function likePattern(query: string): string {
    return '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

const SUMMARY_COLUMNS = 'id, title, pinned, created_at, updated_at';

/**
 * One user's conversations, pinned first then most recently touched.
 *
 * A non-empty `query` matches the title or anything said inside the conversation
 * — searching only titles would miss almost everything, since a title is just
 * the opening prompt truncated.
 */
export function listConversations(
    userId: number,
    options: { query?: string; limit?: number } = {}
): ConversationSummary[] {
    const query = (options.query ?? '').trim();
    // `limit` is only ever a ceiling: the browser wants every conversation for
    // its sidebar, an MCP client wants a page it can fit in a context window.
    const limitClause = options.limit && options.limit > 0 ? ' LIMIT ?' : '';
    const limitParams = limitClause ? [options.limit as number] : [];

    if (!query) {
        return db
            .prepare(
                `SELECT ${SUMMARY_COLUMNS}
                 FROM conversations
                 WHERE user_id = ?
                 ORDER BY pinned DESC, updated_at DESC${limitClause}`
            )
            .all(userId, ...limitParams) as ConversationSummary[];
    }

    const pattern = likePattern(query);
    return db
        .prepare(
            `SELECT c.id, c.title, c.pinned, c.created_at, c.updated_at
             FROM conversations c
             WHERE c.user_id = ?
               AND (
                 c.title LIKE ? ESCAPE '\\'
                 OR EXISTS (
                     SELECT 1 FROM chat_history h
                     WHERE h.conversation_id = c.id
                       AND h.content LIKE ? ESCAPE '\\'
                 )
               )
             ORDER BY c.pinned DESC, c.updated_at DESC${limitClause}`
        )
        .all(userId, pattern, pattern, ...limitParams) as ConversationSummary[];
}

export function createConversation(userId: number, title: string): ConversationSummary {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)').run(id, userId, title);
    return db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM conversations WHERE id = ?`).get(id) as ConversationSummary;
}

/** Returns the caller's own conversation row, or null when it is not theirs. */
export function ownedConversation(id: string, userId: number): { id: string; user_id: number; pinned: number } | null {
    const conv = db
        .prepare('SELECT id, user_id, pinned FROM conversations WHERE id = ?')
        .get(id) as { id: string; user_id: number; pinned: number } | undefined;
    return conv && conv.user_id === userId ? conv : null;
}

function safeParseSources(raw: string): SourceRecord[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Fills in `repo_id` for sources stored before it was recorded, so the chips in
 * an old conversation link to the wiki just like a fresh answer's do.
 *
 * Resolved from `documents` by path (falling back to filename for sources saved
 * without one), in a single query for the whole conversation rather than one per
 * chip. A source whose document has since been deleted, or which never belonged
 * to a repository, simply stays unlinked — that is the honest answer, and both
 * the UI and the MCP tools render it as plain text.
 */
function withRepoIds(messages: { sources: SourceRecord[] }[]): void {
    const keys = new Set<string>();
    for (const m of messages) {
        for (const s of m.sources) {
            if (s && s.repo_id == null) {
                const key = s.path || s.filename;
                if (typeof key === 'string' && key) keys.add(key);
            }
        }
    }
    if (keys.size === 0) return;

    const placeholders = Array.from(keys, () => '?').join(',');
    const rows = db.prepare(`
        SELECT path, filename, repo_id FROM documents
        WHERE repo_id IS NOT NULL AND (path IN (${placeholders}) OR filename IN (${placeholders}))
    `).all(...keys, ...keys) as { path: string | null; filename: string; repo_id: number }[];

    const byKey = new Map<string, { repo_id: number; path: string | null }>();
    for (const r of rows) {
        // Path first: it is what the wiki route needs, and two repos can hold the
        // same filename.
        if (r.path) byKey.set(r.path, { repo_id: r.repo_id, path: r.path });
        if (!byKey.has(r.filename)) byKey.set(r.filename, { repo_id: r.repo_id, path: r.path });
    }

    for (const m of messages) {
        for (const s of m.sources) {
            if (!s || s.repo_id != null) continue;
            const hit = byKey.get(s.path || s.filename);
            if (!hit) continue;
            s.repo_id = hit.repo_id;
            if (!s.path) s.path = hit.path;
        }
    }
}

/**
 * Every turn of one conversation, oldest first, with each answer's sources
 * parsed back out of the stored JSON.
 *
 * Scoped by user_id as well as conversation_id, so this is safe to call before
 * any ownership check: another user's conversation simply reads as empty.
 */
export function conversationTranscript(userId: number, conversationId: string): TranscriptMessage[] {
    const rows = db.prepare(`
        SELECT role, content, sources
        FROM chat_history
        WHERE user_id = ? AND conversation_id = ?
        ORDER BY created_at ASC
    `).all(userId, conversationId) as Array<{ role: string; content: string; sources: string | null }>;

    const history = rows.map((r) => ({
        role: r.role,
        content: r.content,
        sources: r.sources ? safeParseSources(r.sources) : []
    }));
    withRepoIds(history);
    return history;
}

export type MutationResult<T> = { ok: true; value: T } | { ok: false; status: 404 | 409; error: string };

/**
 * Pins or unpins a conversation.
 *
 * `updated_at` is deliberately left alone: pinning is not an edit to the
 * conversation's content, and touching it would reshuffle the recents list.
 */
export function setConversationPinned(userId: number, id: string, pinned: boolean): MutationResult<ConversationSummary> {
    if (!ownedConversation(id, userId)) {
        return { ok: false, status: 404, error: 'Not found or unauthorized' };
    }
    db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
    const updated = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM conversations WHERE id = ?`).get(id) as ConversationSummary;
    return { ok: true, value: updated };
}

/**
 * Deletes a conversation, refusing while it is pinned.
 *
 * A pin is the user's own "don't lose this" marker; deleting through it would
 * make the marker meaningless — so the refusal is the feature, not an oversight,
 * and it holds for an agent calling the MCP tool just as it does for the button
 * in the sidebar.
 */
export function deleteConversation(userId: number, id: string): MutationResult<{ id: string }> {
    const conv = ownedConversation(id, userId);
    if (!conv) {
        return { ok: false, status: 404, error: 'Not found or unauthorized' };
    }
    if (conv.pinned) {
        return { ok: false, status: 409, error: 'Unpin this conversation before deleting it.' };
    }
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return { ok: true, value: { id } };
}

/**
 * Stores a thumbs up/down against one answer, with the exchange it judged.
 *
 * The snapshot of query and response text is the point of the table: the answer
 * it rated may later be edited away or its conversation deleted, and feedback
 * that cannot be read back tells a reviewer nothing.
 *
 * Ownership is checked here, which the feedback route did not do before this
 * moved: `conversation_id` came straight off the request body, so any signed-in
 * user could rate — and snapshot the text of — a conversation belonging to
 * someone else.
 */
export function recordFeedback(
    userId: number,
    conversationId: string,
    messageIndex: number,
    rating: 1 | -1
): MutationResult<{ messageIndex: number; rating: number }> {
    if (!ownedConversation(conversationId, userId)) {
        return { ok: false, status: 404, error: 'Not found or unauthorized' };
    }

    const messages = db.prepare(
        'SELECT role, content FROM chat_history WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as { role: string; content: string }[];

    const queryText = messages[messageIndex - 1]?.content || null;
    const responseText = messages[messageIndex]?.content || null;

    db.prepare(`
        INSERT INTO response_feedback (conversation_id, message_index, rating, query_text, response_text)
        VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, messageIndex, rating, queryText, responseText);

    return { ok: true, value: { messageIndex, rating } };
}
