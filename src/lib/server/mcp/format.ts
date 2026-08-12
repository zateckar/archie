/**
 * Turning results into the text an MCP client will show a model.
 *
 * Pure string work, kept apart from ./server for the same reason
 * ./../usage-buckets is kept apart from ../usage: it is the part worth unit
 * testing, and it must not need a database to run.
 *
 * Every tool returns BOTH a `content` text block and `structuredContent`. The
 * text is what a model reads, so it is prose with markdown, not JSON — a model
 * asked to relay an answer should not have to parse one first. The structured
 * half is for clients that want the fields.
 */

export interface SourceLike {
    filename: string;
    path?: string | null;
    repo_id?: number | null;
}

/** How a source is named in prose: its repo-relative path if it has one. */
export function sourceLabel(source: SourceLike): string {
    return source.path || source.filename;
}

/**
 * The wiki page for a source, or null when there is none.
 *
 * Needs both halves — `/wiki/<repoId>/<path>` — so a document that was uploaded
 * directly rather than synced from a repository has no page to link to, and says
 * so by returning null rather than a URL that 404s.
 */
export function wikiUrl(source: SourceLike): string | null {
    if (source.repo_id == null || !source.path) return null;
    const encoded = source.path.split('/').map(encodeURIComponent).join('/');
    return `/wiki/${source.repo_id}/${encoded}`;
}

/** De-duplicated by label, preserving citation order. */
export function dedupeSources<T extends SourceLike>(sources: T[]): T[] {
    const seen = new Set<string>();
    return sources.filter((s) => {
        const label = sourceLabel(s);
        if (!label || seen.has(label)) return false;
        seen.add(label);
        return true;
    });
}

/** A markdown bullet per source, or '' when there are none. */
export function formatSourceList(sources: SourceLike[]): string {
    if (sources.length === 0) return '';
    return sources
        .map((s) => {
            const url = wikiUrl(s);
            return url ? `- ${sourceLabel(s)} (${url})` : `- ${sourceLabel(s)}`;
        })
        .join('\n');
}

/**
 * The answer with its citations appended.
 *
 * Sources go *after* the answer, under a heading, because a model relaying this
 * to a person should lead with the answer; and they are included at all because
 * an ungrounded-looking answer from a knowledge base is worse than no answer —
 * the reader needs to know which document to go read.
 */
export function withSourceFooter(answer: string, sources: SourceLike[]): string {
    const list = formatSourceList(dedupeSources(sources));
    if (!list) return answer;
    return `${answer}\n\n---\n\n**Sources**\n${list}`;
}

/**
 * The "your question was too vague" reply.
 *
 * Phrased at the *client's* model rather than at a person, and it says how to
 * come back, because the alternative — a bare list of questions — reliably gets
 * relayed to the user as if it were the answer.
 */
export function formatClarificationRequest(questions: string[]): string {
    const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    return [
        'The question is too broad to search on reliably. Please resolve these first:',
        '',
        numbered,
        '',
        'Then call `ask` again with the details filled in, passing `answering_clarification: true` ' +
            'so the question is used as-is instead of being questioned a second time.'
    ].join('\n');
}

export interface ConversationLike {
    id: string;
    title: string;
    pinned: number;
    updated_at: string;
}

export function formatConversationList(conversations: ConversationLike[]): string {
    if (conversations.length === 0) return 'No conversations found.';
    return conversations
        .map((c) => `- ${c.pinned ? '📌 ' : ''}${c.title}\n  id: ${c.id} · updated ${c.updated_at}`)
        .join('\n');
}

export interface TranscriptLike {
    role: string;
    content: string;
    sources?: SourceLike[];
}

/**
 * A conversation rendered as a readable transcript.
 *
 * Turns are numbered from zero, matching the index `rate_answer` takes, so an
 * agent that has read a conversation can rate a turn in it without having to
 * guess how the two are related.
 */
export function formatTranscript(messages: TranscriptLike[]): string {
    if (messages.length === 0) return 'This conversation has no messages.';
    return messages
        .map((m, i) => {
            const who = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role;
            const sources = m.sources && m.sources.length > 0
                ? `\n\nSources: ${dedupeSources(m.sources).map(sourceLabel).join(', ')}`
                : '';
            return `### [${i}] ${who}\n${m.content}${sources}`;
        })
        .join('\n\n');
}

export interface TopicHit {
    name: string;
    description: string | null;
    category: string | null;
    score: number;
}

export interface ClaimHit {
    claim_text: string;
    topic_name: string;
    claim_type: string;
    filename: string;
    path: string | null;
    score: number;
}

/**
 * Knowledge-graph hits as text.
 *
 * Scores are shown to two decimals because they are cosine similarities a model
 * can reasonably weigh, and dropping them would present a 0.31 match with the
 * same confidence as a 0.93 one.
 */
export function formatKnowledgeHits(topics: TopicHit[], claims: ClaimHit[]): string {
    const parts: string[] = [];

    if (topics.length > 0) {
        parts.push(
            '**Topics**\n' +
                topics
                    .map((t) => {
                        const category = t.category ? ` [${t.category}]` : '';
                        const description = t.description ? ` — ${t.description}` : '';
                        return `- ${t.name}${category}${description} (${t.score.toFixed(2)})`;
                    })
                    .join('\n')
        );
    }

    if (claims.length > 0) {
        parts.push(
            '**Facts**\n' +
                claims
                    .map((c) => `- ${c.claim_text}\n  ${c.topic_name} · ${c.claim_type} · ${c.path || c.filename} (${c.score.toFixed(2)})`)
                    .join('\n')
        );
    }

    return parts.length > 0 ? parts.join('\n\n') : 'Nothing in the knowledge base matched that query.';
}
