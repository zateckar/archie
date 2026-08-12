import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectAnswer, runChat, sourceRefs } from '../chat-pipeline';
import {
    conversationTranscript,
    deleteConversation,
    listConversations,
    recordFeedback,
    setConversationPinned
} from '../conversations';
import { searchClaims, searchTopics } from '../rag';
import type { SessionUser } from '../auth';
import {
    dedupeSources,
    formatClarificationRequest,
    formatConversationList,
    formatKnowledgeHits,
    formatTranscript,
    withSourceFooter,
    wikiUrl,
    type SourceLike
} from './format';

/**
 * Archie's MCP server: the same chat, reachable from an agent instead of a browser.
 *
 * Every tool here is a thin adapter over the modules the web UI uses —
 * ../chat-pipeline for answering, ../conversations for everything else — so an
 * MCP client and a browser tab are genuinely the same client. A question asked
 * here lands in the same conversation list, is retrieved and synthesized by the
 * same multi-pass pipeline, is charged to the same per-user token budget and
 * throttled by the same per-minute limit, and can be read back in the browser
 * afterwards.
 *
 * ── One server instance per user, per request ────────────────────────────────
 * `createMcpServer` closes over an authenticated `SessionUser`, and the tools
 * pass `user.id` into every query. There is deliberately no "act as" parameter
 * anywhere in the surface: identity comes from the credential the transport
 * authenticated (see hooks.server.ts), never from tool arguments, so a
 * prompt-injected agent cannot ask for someone else's conversations by naming
 * them. Tool *arguments* are attacker-influenced data — a document in the corpus
 * can say anything — which is why ownership is re-checked on every id.
 */

/** Client-visible identity of this server. */
export const MCP_SERVER_INFO = {
    name: 'archie',
    version: '1.0.0',
    title: 'Archie knowledge base'
} as const;

const INSTRUCTIONS = `Archie is a retrieval-augmented knowledge base over an organisation's internal documentation.

Use "ask" for questions that need an answer grounded in that documentation; it runs the full retrieval
pipeline (knowledge graph + verbatim excerpts, multi-pass refinement, synthesis) and cites its sources,
but it costs many model calls and can take tens of seconds. Use "search_knowledge" instead when you only
need to see whether something is covered, or want raw facts and topics without a written answer.

Answers are grounded in the corpus, not in general knowledge: if the documentation does not cover
something, "ask" will say so rather than fill the gap. Treat its output as sourced material and keep the
citations when relaying it.

Conversations are shared with the web UI. Pass "conversation_id" to continue an existing thread — prior
turns are loaded server-side, so you do not need to resend them.`;

/** Tool results carry markdown text plus, where useful, the structured fields. */
function textResult(text: string, structuredContent?: Record<string, unknown>) {
    return structuredContent
        ? { content: [{ type: 'text' as const, text }], structuredContent }
        : { content: [{ type: 'text' as const, text }] };
}

/**
 * A failed tool call, reported as a result rather than thrown.
 *
 * MCP draws this distinction deliberately: a protocol error means "the call could
 * not happen", while `isError` means "the call happened and failed", which the
 * model is expected to see and react to. A rate limit or an unknown conversation
 * id is the second kind — the agent should read it and adjust, not treat the
 * server as broken.
 */
function errorResult(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/** The structured form of a source: label, path, and its wiki page if it has one. */
function structuredSources(sources: SourceLike[]) {
    return dedupeSources(sources).map((s) => ({
        filename: s.filename,
        path: s.path ?? null,
        wiki_url: wikiUrl(s)
    }));
}

const SOURCE_SHAPE = {
    filename: z.string(),
    path: z.string().nullable(),
    wiki_url: z.string().nullable()
};

const CONVERSATION_ID = z
    .string()
    .min(1)
    .describe('Id of an existing conversation, as returned by ask or list_conversations.');

export function createMcpServer(user: SessionUser): McpServer {
    const server = new McpServer(MCP_SERVER_INFO, {
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS
    });

    // ── ask ──────────────────────────────────────────────────────────────────
    server.registerTool(
        'ask',
        {
            title: 'Ask the knowledge base',
            description:
                'Answer a question from the organisation\'s internal documentation, with citations. Runs the full ' +
                'retrieval pipeline and appends the exchange to a conversation that is also visible in the web UI. ' +
                'Slow (many model calls, often 10-60s) and rate limited per user — prefer search_knowledge for ' +
                'coverage checks. If the question is too vague to search on, this returns clarifying questions ' +
                'instead of an answer.',
            inputSchema: {
                question: z
                    .string()
                    .min(1)
                    .max(4000)
                    .describe('The question, in the user\'s own words. Natural language, not keywords.'),
                conversation_id: CONVERSATION_ID.optional().describe(
                    'Continue this conversation. Earlier turns are loaded server-side. Omit to start a new one.'
                ),
                answering_clarification: z
                    .boolean()
                    .optional()
                    .describe(
                        'Set to true when this question already incorporates the answers to a previous ' +
                            'clarification request, so it is searched as written rather than questioned again.'
                    )
            },
            outputSchema: {
                answer: z.string(),
                conversation_id: z.string().nullable(),
                needs_clarification: z.boolean(),
                clarification_questions: z.array(z.string()),
                sources: z.array(z.object(SOURCE_SHAPE))
            },
            annotations: {
                readOnlyHint: false, // it appends to the user's conversation history
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({ question, conversation_id, answering_clarification }) => {
            // Prior turns come from the database, not from the caller: the client
            // does not hold this conversation's history (the browser might be the
            // one that started it), and accepting a caller-supplied transcript
            // would let an agent fabricate what "was said earlier".
            const history = conversation_id
                ? conversationTranscript(user.id, conversation_id).map((m) => ({ role: m.role, content: m.content }))
                : [];

            const outcome = await runChat({
                user,
                prompt: question,
                conversationId: conversation_id,
                history,
                skipAnalysis: answering_clarification
            });

            if (outcome.type === 'rejected') {
                return errorResult(outcome.message);
            }

            if (outcome.type === 'clarification') {
                const text = formatClarificationRequest(outcome.questions);
                return textResult(text, {
                    answer: text,
                    // No conversation is created for a clarification, so there is
                    // nothing to continue yet.
                    conversation_id: null,
                    needs_clarification: true,
                    clarification_questions: outcome.questions,
                    sources: []
                });
            }

            // The pipeline streams; MCP tool results do not. Draining to a string
            // is also what persists the assistant turn, so this must run to
            // completion even though nothing here is incremental.
            const answer = await collectAnswer(outcome);
            const refs = sourceRefs(outcome.sources);

            return textResult(withSourceFooter(answer, refs), {
                answer,
                conversation_id: outcome.conversationId,
                needs_clarification: false,
                clarification_questions: [],
                sources: structuredSources(refs)
            });
        }
    );

    // ── search_knowledge ─────────────────────────────────────────────────────
    server.registerTool(
        'search_knowledge',
        {
            title: 'Search the knowledge graph',
            description:
                'Semantic search over the extracted knowledge graph: topics (subjects the corpus covers) and ' +
                'claims (individual sourced facts). Returns matches with relevance scores and the document each ' +
                'fact came from. Much cheaper and faster than ask — no answer is written — so use it to check ' +
                'whether something is documented, or to gather raw facts to reason over yourself.',
            inputSchema: {
                query: z.string().min(1).max(1000).describe('What to look for. Natural language works better than keywords.'),
                type: z
                    .enum(['topics', 'claims', 'all'])
                    .optional()
                    .describe('Restrict to topics or claims. Defaults to both.'),
                limit: z.number().int().min(1).max(50).optional().describe('Maximum hits per kind. Defaults to 10.')
            },
            outputSchema: {
                topics: z.array(
                    z.object({
                        name: z.string(),
                        description: z.string().nullable(),
                        category: z.string().nullable(),
                        score: z.number()
                    })
                ),
                claims: z.array(
                    z.object({
                        claim: z.string(),
                        topic: z.string(),
                        claim_type: z.string(),
                        source: z.string(),
                        wiki_url: z.string().nullable(),
                        score: z.number()
                    })
                )
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ query, type = 'all', limit = 10 }) => {
            // Run both halves concurrently when both were asked for; each embeds
            // the query, and the embedding cache in ../llm means the second is free.
            const [topics, claims] = await Promise.all([
                type === 'topics' || type === 'all' ? searchTopics(query, limit) : Promise.resolve([]),
                type === 'claims' || type === 'all' ? searchClaims(query, null, limit) : Promise.resolve([])
            ]);

            return textResult(formatKnowledgeHits(topics, claims), {
                topics: topics.map((t) => ({
                    name: t.name,
                    description: t.description ?? null,
                    category: t.category ?? null,
                    score: t.score
                })),
                claims: claims.map((c) => ({
                    claim: c.claim_text,
                    topic: c.topic_name,
                    claim_type: c.claim_type,
                    source: c.path || c.filename,
                    // Claims carry no repo_id, so there is no page to link to from
                    // here; get_conversation and ask are where wiki links come from.
                    wiki_url: null,
                    score: c.score
                }))
            });
        }
    );

    // ── list_conversations ───────────────────────────────────────────────────
    server.registerTool(
        'list_conversations',
        {
            title: 'List conversations',
            description:
                'The signed-in user\'s own conversations, pinned first then most recently updated. An optional ' +
                'query filters by title or by anything said inside a conversation, which is how to find an ' +
                'earlier thread to continue.',
            inputSchema: {
                query: z.string().max(200).optional().describe('Filter by title or message contents.'),
                limit: z.number().int().min(1).max(100).optional().describe('Maximum conversations to return. Defaults to 25.')
            },
            outputSchema: {
                conversations: z.array(
                    z.object({
                        id: z.string(),
                        title: z.string(),
                        pinned: z.boolean(),
                        created_at: z.string(),
                        updated_at: z.string()
                    })
                )
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ query, limit = 25 }) => {
            const conversations = listConversations(user.id, { query, limit });
            return textResult(formatConversationList(conversations), {
                conversations: conversations.map((c) => ({
                    id: c.id,
                    title: c.title,
                    pinned: !!c.pinned,
                    created_at: c.created_at,
                    updated_at: c.updated_at
                }))
            });
        }
    );

    // ── get_conversation ─────────────────────────────────────────────────────
    server.registerTool(
        'get_conversation',
        {
            title: 'Read a conversation',
            description:
                'The full transcript of one of the user\'s conversations, oldest turn first, with the sources each ' +
                'answer cited. Turns are numbered from zero; those numbers are the message_index that rate_answer ' +
                'takes.',
            inputSchema: { conversation_id: CONVERSATION_ID },
            outputSchema: {
                conversation_id: z.string(),
                messages: z.array(
                    z.object({
                        index: z.number().int(),
                        role: z.string(),
                        content: z.string(),
                        sources: z.array(z.object(SOURCE_SHAPE))
                    })
                )
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ conversation_id }) => {
            const messages = conversationTranscript(user.id, conversation_id);
            // The transcript query is scoped by user_id, so someone else's
            // conversation reads as empty rather than forbidden. Say which it is:
            // an agent told "not found" will stop, while an empty transcript looks
            // like a conversation worth retrying into.
            if (messages.length === 0) {
                return errorResult(`No conversation ${conversation_id} with any messages belongs to you.`);
            }

            return textResult(formatTranscript(messages), {
                conversation_id,
                messages: messages.map((m, index) => ({
                    index,
                    role: m.role,
                    content: m.content,
                    sources: structuredSources(m.sources)
                }))
            });
        }
    );

    // ── pin_conversation ─────────────────────────────────────────────────────
    server.registerTool(
        'pin_conversation',
        {
            title: 'Pin or unpin a conversation',
            description:
                'Pins a conversation to the top of the list, or unpins it. Pinning does not change the ' +
                'conversation\'s updated_at, so it will not reorder the recents list.',
            inputSchema: {
                conversation_id: CONVERSATION_ID,
                pinned: z.boolean().describe('True to pin, false to unpin.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ conversation_id, pinned }) => {
            const result = setConversationPinned(user.id, conversation_id, pinned);
            if (!result.ok) return errorResult(result.error);
            return textResult(`${pinned ? 'Pinned' : 'Unpinned'} "${result.value.title}".`);
        }
    );

    // ── delete_conversation ──────────────────────────────────────────────────
    server.registerTool(
        'delete_conversation',
        {
            title: 'Delete a conversation',
            description:
                'Permanently deletes one of the user\'s conversations and its messages. A pinned conversation is ' +
                'refused — unpin it first, deliberately, so an agent cannot delete something the user marked as ' +
                'worth keeping.',
            inputSchema: { conversation_id: CONVERSATION_ID },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async ({ conversation_id }) => {
            const result = deleteConversation(user.id, conversation_id);
            if (!result.ok) return errorResult(result.error);
            return textResult(`Deleted conversation ${conversation_id}.`);
        }
    );

    // ── rate_answer ──────────────────────────────────────────────────────────
    server.registerTool(
        'rate_answer',
        {
            title: 'Rate an answer',
            description:
                'Records a thumbs up or down on one answer, the same feedback the web UI collects for quality ' +
                'review. message_index is the turn number shown by get_conversation.',
            inputSchema: {
                conversation_id: CONVERSATION_ID,
                message_index: z
                    .number()
                    .int()
                    .min(0)
                    .describe('Zero-based index of the assistant turn being rated, from get_conversation.'),
                rating: z.enum(['up', 'down']).describe('Whether the answer was useful.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ conversation_id, message_index, rating }) => {
            const result = recordFeedback(user.id, conversation_id, message_index, rating === 'up' ? 1 : -1);
            if (!result.ok) return errorResult(result.error);
            return textResult(`Recorded a thumbs ${rating} on turn ${message_index} of ${conversation_id}.`);
        }
    );

    return server;
}
