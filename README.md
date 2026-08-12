# Archie: SvelteKit RAG Chatbot with Semantic Knowledge Layer

Archie is a sophisticated Retrieval-Augmented Generation (RAG) chatbot built with SvelteKit, SQLite, and Google Gemini. It goes beyond simple document retrieval by implementing a semantic knowledge layer that extracts topics, relationships, and claims from your documents, ensuring consistency and providing deeper insights.

## 🚀 Features

- **Document Management:** Sync documents from Git repositories or upload them manually.
- **Advanced RAG Pipeline:** Uses hybrid search (Vector + Keyword) with LLM-based reranking.
- **Document Preprocessing:** LLM-powered cleaning removes boilerplate, fixes formatting, and restructures content before ingestion.
- **Semantic Knowledge Layer:** Automatically extracts a knowledge graph (topics, relationships, claims) from documents with cross-chunk context awareness.
- **LLM-Driven Topic Taxonomy:** Hybrid taxonomy system — incremental placement after each import + full LLM-powered hierarchy rebuild on demand or after git sync.
- **Community Detection:** Unsupervised graph clustering (Louvain) groups related topics into functional domains for exploration and visualization.
- **Consistency Checking:** Detects conflicts and updates in factual claims across your knowledge base.
- **Conflict Resolution UI:** Admin interface with side-by-side comparison of active vs. conflicting claims, with accept/dismiss/reject actions.
- **Knowledge Graph Visualization:** Interactive force-directed graph in the admin dashboard with pan, zoom, node selection, and relationship exploration.
- **Claim Attribution:** Tracks which document version (content hash) produced each claim, with staleness detection when source documents change.
- **Relationship Validation Logging:** Out-of-vocabulary relationship types are tracked and summarized, helping expand the synonym dictionary over time.
- **Semantic Chunking:** Uses LLM to split documents into meaningful sections rather than arbitrary fixed sizes.
- **Context Synthesis:** An intermediate LLM pass transforms raw retrieved data into coherent, query-focused briefings before response generation — mimicking fine-tuned model recall.
- **Multi-Turn Conversation Memory:** Conversation briefings maintain topical coherence across turns, so follow-up questions build on established context rather than restarting from scratch.
- **Expanded Claim Types:** Extracts five claim types — assertions, negations, conditions, comparisons, and boundaries — for nuanced answers that acknowledge limitations and exceptions.
- **Source Grounding:** End-to-end lineage from document → chunk → claim, with inline `[source]` citations in knowledge context and responses.
- **User Feedback Loop:** Thumbs up/down on every assistant response, stored with full context snapshots for quality analysis.
- **Real-time Chat:** Conversational interface with streaming responses and source citations.
- **MCP Server:** The same chat, exposed over Model Context Protocol at `/api/mcp`, so Claude Code, Claude Desktop or any MCP client can ask the knowledge base and manage its conversations — sharing one pipeline, one token budget and one conversation list with the web UI. Authorized by standard OAuth 2.1 against the app's existing OIDC provider, with no app-issued credentials.
- **Rich Markdown Responses:** Chat responses are automatically formatted with headers, tables, code blocks, lists, and relationship arrows for maximum readability.
- **Sleek UI:** Modern dark theme with a terminal-inspired aesthetic.
  - **Knowledge Graph Visualization:** Interactive force-directed canvas graph with category-colored nodes, directed edges, zoom/pan, and node detail panels.
  - **Conflict Resolution:** Side-by-side comparison of active vs. conflicting claims with accept/dismiss/reject actions and document version tracking.
  - **Taxonomy Management:** View topic hierarchy by category and parent-child tree, trigger LLM-powered taxonomy rebuilds.

---

## 🛠️ How It Works

### 1. Document Processing & Ingestion

The ingestion pipeline transforms raw text into searchable, structured knowledge through four distinct phases:

```
Raw Document
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│  Phase 0: Cleaning & Summarization  (LLM-powered preprocessing)  │
│  ─────────────────────────────────────────────────────────────── │
│  • Remove boilerplate, nav elements, page numbers, metadata      │
│  • Strip TODOs, empty sections, template instructions            │
│  • Restructure into logical markdown sections with proper headers│
│  • Preserve ALL substantive content (no condensation)            │
│  • Translate non-English content to English                      │
│  • Safety guard: if >90% would be removed, keep original         │
│  • Large documents split by headers/paragraphs (80K char chunks) │
│  • Save cleaned version to Clean/ folder in repo                 │
│  • Generate comprehensive document summary for context           │
└──────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│  Phase 1: Async AI Work  (no SQLite transaction held)            │
│  ─────────────────────────────────────────────────────────────── │
│  • Semantic chunking via LLM (under 50K chars)                   │
│  • Fallback: markdown-aware regex chunker (1500 char windows)    │
│  • 200-char overlap between chunks for context preservation      │
│  • Generate vector embeddings for each chunk                     │
│  • All LLM calls & network I/O occur here — transactions never   │
│    held open during async operations (prevents nested transaction │
│    conflicts when auto-sync timer fires during ingestion)         │
└──────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│  Phase 2: Fast Synchronous DB Writes  (brief transaction)        │
│  ─────────────────────────────────────────────────────────────── │
│  • Store document metadata (filename, path, content hash)        │
│  • Persist chunks with vector embeddings                         │
│  • FTS5 index auto-populated via SQLite triggers                 │
└──────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│  Phase 3: Knowledge Extraction  (async, no transaction)          │
│  ─────────────────────────────────────────────────────────────── │
│  • LLM extracts topics, relationships & claims per chunk         │
│  • Sliding window context: each chunk sees adjacent chunks       │
│    (truncated to 800 chars) for pronoun resolution & coherence   │
│  • Expanded claim types: assertion, negation, condition,         │
│    comparison, boundary — with chunk_id lineage tracking         │
│  • Topic name normalization & deduplication                      │
│  • Relationship validation against canonical vocabulary          │
│  • Batch consistency checking for claims                         │
│  • Incremental taxonomy placement for new topics                 │
│  • Per-chunk safety checks: if document was deleted mid-pipeline,│
│    processing aborts gracefully (prevents FK constraint errors)  │
└──────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│  Phase 4: Community Detection  (full graph recompute)            │
│  ─────────────────────────────────────────────────────────────── │
│  • Run graph diagnostics to select best clustering strategy      │
│  • Louvain algorithm on relationship graph (if dense enough)     │
│  • Fallback: k-NN similarity graph on topic embeddings           │
│  • Assign community_id per topic, noise topics labeled as NULL   │
│  • Full recompute only — no incremental heuristics               │
└──────────────────────────────────────────────────────────────────┘
    │
    ▼
                    Structured Knowledge Base
    ┌───────────────┬───────────────┬───────────────┬──────────────┐
    │  Chunks with  │  Knowledge    │  Topic        │  Community   │
    │  embeddings   │  Graph        │  Taxonomy     │  Clusters    │
    │  & FTS5 index │  (topics,     │  (parent-     │  (graph-     │
    │               │   relations,  │   child       │   derived    │
    │               │   claims)     │   hierarchy)  │   domains)   │
    └───────────────┴───────────────┴───────────────┴──────────────┘
```

#### Phase 0: Document Cleaning & Summarization

Before any chunking or extraction, Archie preprocesses every document using Gemini (the `cleanDocument` function in `gemini.ts`). This step transforms raw, noisy documents — which may contain boilerplate headers/footers, auto-generated metadata, page numbers, table-of-contents artifacts, broken formatting, template instructions, or garbled Unicode — into clean, well-structured markdown.

The LLM receives a seven-point cleaning instruction:

1. **Remove noise** — strip headers/footers, navigation elements, page numbers, repetitive disclaimers, auto-generated metadata, ToC entries, formatting artifacts.
2. **Remove valueless content** — strip empty sections, placeholder text, TODO markers, template instructions, content with no informational value.
3. **Restructure for clarity** — organize into logical sections with clear markdown headers (`##`, `###`), group related information, ensure coherent flow from general to specific.
4. **Improve formatting** — proper markdown throughout (lists, tables, bold for key terms), fix broken line breaks, normalize whitespace.
5. **Enhance readability** — clear topic sentences, logical paragraph flow, break up walls of text.
6. **Preserve ALL substantive content** — every meaningful fact, procedure, requirement, and technical detail must be kept intact. No condensation or summarization.
7. **Standardize to English** — if the document is in any language other than English, translate all content to English while preserving original meaning, terminology, and technical accuracy.

**Safety guard:** If the cleaning process would remove more than 90% of the original content (indicating an LLM error or hallucination), Archie falls back to the original raw document. Large documents (>80K chars) are split by markdown headers or paragraphs and cleaned piecewise, then reassembled.

**Clean folder:** After cleaning, the polished version is saved to a `Clean/` subfolder within the source repository (for git-synced documents) or locally on disk (for manually uploaded documents). This preserves the original alongside the cleaned version. The cleaned documents in `Clean/` are automatically staged and committed to git when syncing repositories.

After cleaning, a **document summary** is generated (200-500 words) that captures the document's purpose, major themes, key entities, and relationships. This summary is used to provide context during knowledge extraction, improving the quality of extracted topics and claims.

---

### 2. Semantic Layer (Knowledge Graph)

Archie doesn't just store chunks; it understands the content.

*   **Knowledge Extraction:** After ingestion, an asynchronous process uses Gemini to extract:
    *   **Topics:** Key concepts, their descriptions, and categories (e.g., Technical, Architecture).
    *   **Relationships:** How topics connect (e.g., "SvelteKit" *depends_on* "Vite"). A closed vocabulary of 15 canonical relationship types with ~70+ synonym mappings ensures consistency.
    *   **Claims:** Atomic factual statements typed as assertion, negation, condition, comparison, or boundary — attributed to specific document versions and source chunks.
*   **Relationship Validation:** Out-of-vocabulary relationship types invented by the LLM are tracked and logged as a summary, providing visibility into vocabulary gaps.
*   **Consistency Management:** When a new claim is extracted, Archie compares it against existing claims for that topic:
    *   **Duplicates:** Semantic duplicates are identified and skipped.
    *   **Conflicts:** If a new claim contradicts an existing one, it is flagged as `conflicting` for review.
    *   **Updates:** If a claim provides more recent or specific information, it is marked accordingly.
*   **Claim Attribution:** Each claim stores the `content_hash` of the source document at extraction time.

#### Browsing it: `/knowledge` (and `/admin/knowledge`)

Both pages are **server-paged** — 20 rows per request by default, with search,
category filter and sort resolved in SQL (`lib/server/knowledge-queries.ts`). They
previously loaded the whole graph in one response and filtered it in the browser,
which is why they slowed down as the corpus grew.

| Endpoint | Returns |
|---|---|
| `GET /api/knowledge/topics` | paged topics with SQL-computed claim/relationship counts (`page`, `pageSize`, `search`, `category`, `sort`); `view=tree` returns slim rows for the admin hierarchy |
| `GET /api/knowledge/claims` | paged claims (`topicId`, `status`, `search`, `category`, `sort`) — non-`active` statuses are admin-only |
| `GET /api/knowledge/stats` | headline counts, per-category counts, isolated-topic count |
| `GET /api/knowledge/graph` | a bounded, **connected** subgraph for the canvas |

**The graph view** (`lib/components/KnowledgeGraph.svelte`, shared by both pages)
selects nodes from *relationships* rather than from topic scores, so every node it
draws has at least one visible edge — no disconnected circles, whatever the filters
do. Nodes are laid out per community (the Louvain partition in
`topics.community_id`), each cluster inside a reserved, non-overlapping region with
its report title as a label, so clusters read as clusters instead of one mass.
Selecting a node dims everything but its neighbourhood and labels each relationship
type; "Focus" switches to an ego view of 1–3 hops. The status line always states
what is not being drawn (nodes over the budget, nodes with no visible link, and
topics with no relationships at all).

### 3. Topic Taxonomy (LLM-Driven Hierarchy)

Archie automatically organizes topics into a meaningful hierarchy using a two-phase approach:

*   **Incremental Placement:** After each document import, newly created topics are placed into the existing taxonomy by the LLM.
*   **Full Rebuild:** A comprehensive taxonomy review can be triggered from the admin UI ("Rebuild Taxonomy" button) or runs automatically after each git repo sync.
*   **Design Principles:** Shallow hierarchies (2-3 levels, max 4), stability, and safety (circular dependencies are detected and broken).

### 4. Community Detection (Graph Clustering)

Alongside the LLM-driven taxonomy (a top-down hierarchical organization), Archie performs **unsupervised community detection** on the topic relationship graph to discover latent functional groupings. While the taxonomy answers "what category does this belong to?", communities answer "what topics are structurally connected in the graph?"

#### Dual Strategy: Relationship Graph vs. Embedding Similarity

Archie uses two complementary approaches, selected automatically based on graph density:

```
┌────────────────────────────────────────────────────────────────┐
│  Strategy Selection (getGraphStats → recomputeCommunities)      │
│  ─────────────────────────────────────────────────────────────  │
│                                                                │
│  Run graph diagnostics:                                        │
│  • Node count, edge count, average degree                      │
│  • Connected components (BFS)                                  │
│  • Isolated node ratio                                         │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  avgDegree > 3  AND  largestComponent > 60%  AND         │   │
│  │  isolated < 20%                                          │   │
│  │                                                          │   │
│  │  YES ──► Method 1: Louvain on relationship graph         │   │
│  │  NO  ──► Method 2: k-NN graph on embedding similarities  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  Both methods feed into the same Louvain engine.               │
└────────────────────────────────────────────────────────────────┘
```

**Method 1: Louvain on the Relationship Graph (default when graph is dense)**

When topics have sufficient relational connections (average degree > 3, at least 60% of nodes in a single connected component, fewer than 20% isolated), Archie builds a weighted undirected graph from the `topic_relationships` table:

| Relationship Type | Edge Weight | Semantic Strength |
|-------------------|-------------|-------------------|
| `is_part_of` | 1.0 | Structural composition |
| `is_a` | 1.0 | Taxonomic classification |
| `governs`, `enforces`, `constrains` | 0.8 | Regulatory/control relationships |
| `depends_on`, `manages`, `defines`, `implements` | 0.7 | Operational dependencies |
| `complies_with`, `includes` | 0.6 | Compliance/inclusion |
| `supports`, `enables` | 0.5 | Auxiliary support |
| `uses` | 0.4 | Usage relationships |
| `references` | 0.3 | Weak referential links |

**Method 2: Embedding-Based Clustering (fallback for sparse graphs)**

When the relationship graph is too sparse for meaningful community detection, Archie falls back to building a k-nearest-neighbor graph from topic embeddings:

1. For each topic with a vector embedding (stored via `sqlite-vector`), compute cosine similarity against all other topics.
2. For each topic, find its top-k neighbors (k = min(10, √n)) with similarity ≥ 0.4.
3. Build a weighted graph from these similarity edges.
4. Run Louvain on this similarity graph.
5. Singleton clusters (size < 2) are labeled as noise (`community_id = NULL`).

This approach works for **every topic with an embedding**, including completely isolated topics. The clustering becomes a proxy for semantic relatedness when structural graph connectivity is insufficient.

#### The Louvain Algorithm

Archie implements Louvain community detection from scratch (no external library dependency) in `src/lib/server/communities.ts`:

*   **Phase 1 (Local Optimization):** Each node starts in its own community. Nodes are iterated in seeded-random order and moved to the neighboring community that maximizes modularity gain. This repeats until no improvement is possible (max 20 iterations, typically converges in 3-5).
*   **Phase 2 (Aggregation):** Communities are collapsed into super-nodes. For Archie's scale (hundreds to low-thousands of nodes), a single pass is sufficient — Phase 2 aggregation is skipped as an optimization.
*   **Seeded PRNG:** A linear congruential generator with a fixed seed (42) ensures deterministic results across runs.
*   **Full recompute only:** No incremental heuristic — after every ingestion batch, the full graph is recomputed. At Archie's scale this completes in under 100ms.

#### How Communities Relate to the Existing Taxonomy

| Dimension | Taxonomy (`parent_topic_id`) | Communities (`community_id`) |
|-----------|------------------------------|------------------------------|
| **Source** | LLM-generated (top-down) | Graph-algorithm (bottom-up) |
| **Structure** | Tree (parent-child) | Clusters (many-to-many) |
| **Granularity** | Coarse categories | Functional domains |
| **Human-readable** | Yes (category names) | No (numeric IDs, needs labeling) |
| **Deterministic** | No (LLM-dependent) | Yes (same graph = same communities) |
| **Update cost** | Incremental per document | Full recompute per batch |

The two are complementary. A topic like "IT-PEP" might have a taxonomy category of "Methodology" but belong to a community of related process/governance topics — revealing functional groupings that aren't captured by high-level categories.

#### What Communities Are NOT Used For

- **RAG ranking:** Communities do not boost or filter search results. The most valuable queries (those crossing domains, e.g., "How does authentication comply with data governance?") intentionally span communities, and community-based boosting would be counterproductive.
- **Replacing categories:** Categories remain the primary semantic label for UX coloring, filtering, and embedding context.

Communities are used exclusively for **exploration and visualization**:
- Community-aware graph coloring (toggleable alongside category coloring)
- "Explore this domain" feature showing all topics in a community
- Knowledge gap detection: isolated communities with no cross-community edges indicate missing connections

### 5. Chatbot & RAG Pipeline

The chat interface provides a natural way to interact with the knowledge base, with a multi-stage pipeline designed to produce fine-tuned-model-caliber responses.

*   **Query Condensation:** Rephrases follow-up questions into standalone search queries.
*   **Conversation Memory:** For multi-turn conversations, a conversation briefing summarizes established facts, topics, and user intent from recent exchanges.
*   **Hybrid Search:** Vector + FTS5 keyword search, combined via Reciprocal Rank Fusion (RRF).
*   **Quantized Vector Search (TurboQuant, 4-bit):** Vector searches run against
    sqlite-vector's precomputed TurboQuant index instead of scanning every stored
    embedding. Measured on a 3072-dim corpus (`npx tsx scripts/eval/quantization.ts`):
    recall@10 96.7–97.5%, recall@20 97.6–98.4%, the exact top hit preserved on 100%
    of queries, 1.8–3.2× faster — and the margin grows with corpus size. A table
    whose embeddings changed since its last quantize automatically falls back to the
    exact scan until the structure is rebuilt (debounced, in the background), so
    freshly ingested data is never invisible to search. See
    `lib/server/vector-index.ts` and the `VECTOR_*` variables in `.env.example`.
*   **Multi-Pass Context Gathering:** If initial retrieval is insufficient, the pipeline refines queries and searches again for missing aspects.
*   **Context Synthesis:** An intermediate LLM call transforms raw retrieved data (knowledge graph claims + verbatim excerpts) into a coherent, query-focused briefing document. This replaces the "retrieval dump" pattern with expert-style prose that the chat model can reason over naturally.
*   **Lean System Prompt:** A ~600-token prompt focused on reasoning quality (vs. the previous ~2000-token adversarial formatting prompt), letting the model spend its attention on content rather than compliance.
*   **Source-Grounded Responses:** Claims carry inline source attribution through the entire pipeline, so the chat model's citations match actual source documents.
*   **Claim Type Awareness:** Question queries automatically boost constraint-type claims (negations, conditions, boundaries) to surface nuanced answers.
*   **User Feedback:** Thumbs up/down on each response, stored with the full context snapshot for pipeline tuning.

### 6. MCP Server (Chat for Agents)

Everything the chat page can do is also reachable over [Model Context Protocol](https://modelcontextprotocol.io),
so an AI assistant — Claude Code, Claude Desktop, Copilot, anything that speaks MCP —
can query the knowledge base directly. It is the same pipeline, not a parallel one:
both front doors call `lib/server/chat-pipeline.ts` and `lib/server/conversations.ts`,
so a question asked from an editor appears in the web sidebar, is charged to the same
per-user token budget, and is throttled by the same per-minute limit.

**Endpoint:** `POST /api/mcp` — Streamable HTTP transport, stateless (no MCP session
state; one server instance is built per request from the authenticated user). `GET` and
`DELETE` return 405: there are no server-initiated notifications to stream and no
sessions to terminate.

**Tools:**

| Tool | What it does |
|------|--------------|
| `ask` | A grounded, cited answer via the full RAG pipeline. Appends to a conversation shared with the web UI. Returns clarifying questions instead of an answer when the query is too vague. Slow (10–60s) and rate limited. |
| `search_knowledge` | Semantic search over topics and claims with relevance scores. No answer is written, so it is cheap — the right tool for "is this documented?". |
| `list_conversations` | The user's own conversations, filterable by title or message contents. |
| `get_conversation` | One transcript, turns numbered from zero, with the sources each answer cited. |
| `pin_conversation` | Pin or unpin, without disturbing `updated_at`. |
| `delete_conversation` | Deletes a conversation; refuses while it is pinned, exactly as the sidebar does. |
| `rate_answer` | Thumbs up/down, into the same `response_feedback` table as the UI. |

**Authorization: OAuth 2.1, against the OIDC provider the app already uses.** There is no
app-issued credential and no MCP-specific account. `/api/mcp` is a *protected resource*;
the authorization server is whatever `OIDC_ISSUER` points at, and Archie only validates
what it issues:

1. The client calls `/api/mcp` with no token and gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="…"`.
2. It reads that document — `/.well-known/oauth-protected-resource/api/mcp`
   (RFC 9728, public) — which names the resource identifier and the authorization server.
3. It reads the provider's own metadata, registers (RFC 7591) or uses a pre-registered
   client id, and sends the user through the provider's login and consent.
4. It exchanges the code for an access token (authorization code + PKCE).
5. It calls `/api/mcp` with `Authorization: Bearer <access token>`.

Every token is checked for signature (JWKS, cached), issuer, expiry and — the part that
matters most — **audience**: a token is accepted only if its `aud` names this server, so a
token some other service behind the same IdP obtained for itself does not open this one.
Opaque (non-JWT) tokens fall back to RFC 7662 introspection using the client credentials
already configured for sign-in. The subject is mapped to the same user row a browser
session produces, provisioning on first sight exactly as the web callback does; new
accounts get the default `user` role, so a client cannot mint an admin.

The session cookie is deliberately *not* accepted on `/api/mcp` — MCP is OAuth-only, so
everything the tools do happened under a token the provider issued and can revoke.
Identity comes from the token, never from a tool argument, and every conversation id is
re-checked against its owner. See `lib/server/oauth-token.ts` (verification),
`lib/server/oauth-resource.ts` (the rules and the challenge) and `lib/server/mcp/auth.ts`.

Connecting a client — no secret to paste; the client opens a browser on first use:

```bash
claude mcp add --transport http archie https://your-host/api/mcp
```

```json
{
  "mcpServers": {
    "archie": {
      "type": "http",
      "url": "https://your-host/api/mcp"
    }
  }
}
```

For a client that only speaks stdio, bridge it with `npx mcp-remote https://your-host/api/mcp`,
which runs the same OAuth flow.

**What the provider needs (two things), for Keycloak:**

1. **An audience Archie accepts.** If the provider honours the `resource` parameter
   (RFC 8707) it stamps `https://your-host/api/mcp` and nothing needs configuring.
   Otherwise add an audience mapper to the client and set `MCP_OAUTH_AUDIENCE` to whatever
   it emits (often a client id). There is no "accept any audience" switch — that is the
   whole confused-deputy defence.
2. **A way for clients to get a client id.** Either enable dynamic client registration
   (Keycloak: a client-registration policy that permits anonymous registration), which is
   what Claude clients expect, or pre-register a public client using authorization code +
   PKCE with the client's loopback redirect URI and hand users its id.

`/settings` reports both live — whether the provider is reachable, whether it offers
dynamic registration, and which audience is currently accepted — so a client that cannot
connect can be diagnosed without reading logs.

See `lib/server/mcp/` for the tool definitions and `routes/api/mcp/` for the transport.


## 💻 Tech Stack

- **Frontend/Backend:** [SvelteKit](https://kit.svelte.dev/)
- **Agent Access:** [Model Context Protocol SDK](https://modelcontextprotocol.io) (Streamable HTTP)
- **LLM/Embeddings:** [Google Gemini API](https://ai.google.dev/)
- **Database:** [SQLite](https://www.sqlite.org/)
- **Vector Search:** [sqlite-vector](https://github.com/asg017/sqlite-vector)
- **Git Integration:** [isomorphic-git](https://isomorphic-git.org/)
- **Styling:** Tailwind CSS (Custom dark theme)

---

## ⚙️ Setup

### Prerequisites
- Bun (v1.0+, Recommended) or Node.js 20+

### Installation

1.  **Install dependencies:**
    Using Bun (Recommended):
    ```bash
    bun install
    ```
    Or using npm:
    ```bash
    npm install
    ```

2.  **Configure Environment:**
    Copy `.env.example` to `.env` (or create one):
    ```env
    # Required
    GEMINI_API_KEY=your_gemini_api_key_here
    ADMIN_PASSWORD=your_secure_admin_password

    # Optional: Database path (default: data/rag.db)
    DATABASE_PATH=data/rag.db

    # Optional: Model configuration
    TEXT_MODEL=gemini-3-flash-preview
    EMBEDDING_MODEL=gemini-embedding-2
    RERANK_MODEL=gemini-3-flash-preview
    CHUNK_MODEL=gemini-3-flash-preview

    # Optional: Encryption key for PAT tokens (auto-generated in dev, REQUIRED in production)
    # ENCRYPTION_KEY=your-32-byte-hex-key

    # Optional: OIDC Configuration
    # OIDC_ISSUER=https://your-oidc-provider.com/realms/your-realm
    # OIDC_CLIENT_ID=your-client-id
    # OIDC_CLIENT_SECRET=your-client-secret
    # PUBLIC_URL=http://localhost:5173
    ```

3.  **Run the app:**
    Using Bun (Recommended):
    ```bash
    bun run bun:dev
    ```
    Or using npm:
    ```bash
    npm run dev
    ```

    Open http://localhost:5173 and log in with username `admin` and your `ADMIN_PASSWORD`.

### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key |
| `ADMIN_PASSWORD` | Yes (prod) | `admin` (dev) | Initial admin password (must be changed in production) |
| `DATABASE_PATH` | No | `data/rag.db` | Path to the SQLite database file |
| `ENCRYPTION_KEY` | No | dev-only fallback | AES-256 key for encrypting PAT tokens at rest |
| `TEXT_MODEL` | No | `gemini-3-flash-preview` | Gemini model for text generation |
| `EMBEDDING_MODEL` | No | `gemini-embedding-2` | Gemini model for embeddings |
| `RERANK_MODEL` | No | `gemini-3-flash-preview` | Gemini model for reranking |
| `CHUNK_MODEL` | No | `gemini-3-flash-preview` | Gemini model for semantic chunking |
| `OIDC_ISSUER` | No | — | OIDC provider URL (enables OIDC auth) |
| `OIDC_CLIENT_ID` | No | — | OIDC client ID |
| `OIDC_CLIENT_SECRET` | No | — | OIDC client secret |
| `PUBLIC_URL` | No | — | Public URL for OIDC redirects |
| `SUPPORTED_EXTENSIONS` | No | `.md,.mdx` | Comma-separated list of file extensions to sync from git |
| `CHAT_RATE_LIMIT_PER_MIN` | No | `20` | Answered questions per user per minute, across the web UI and MCP alike |
| `MCP_RATE_LIMIT_PER_MIN` | No | `120` | MCP requests per user per minute (the cheap read tools; `ask` is bounded by `CHAT_RATE_LIMIT_PER_MIN`) |
| `MCP_OAUTH_AUDIENCE` | No | the resource URI `<PUBLIC_URL>/api/mcp` | Comma-separated audience values a token may carry to be accepted on `/api/mcp`. Set this when the provider stamps a fixed audience instead of honouring RFC 8707 `resource` |
| `MCP_OAUTH_REQUIRED_SCOPE` | No | — | Scope(s) a token must carry, e.g. `mcp:access`. Missing scopes give `403 insufficient_scope` |
| `MCP_OAUTH_INTROSPECT` | No | `false` | Force RFC 7662 introspection even for JWTs (immediate revocation, one round trip per token, cached 60s) |

---

## 🐳 Docker

### Quick Start

```bash
docker-compose up -d
```

This starts Archie on port 3000. The `.env` file is automatically loaded for environment variables.

### Production Deployment

1. Set required environment variables (or use `.env` file):
   ```bash
   export GEMINI_API_KEY=your_key
   export ADMIN_PASSWORD=your_secure_password
   export ENCRYPTION_KEY=$(openssl rand -hex 32)  # Generate a secure key
   export NODE_ENV=production
   ```

2. Ensure persistent data storage:
   ```yaml
   volumes:
     - ./data:/app/data   # Persists SQLite DB and git repo clones
   ```

3. Run:
   ```bash
   docker-compose up -d
   ```

### Health Check

Archie exposes a health endpoint at `GET /api/health`:
```json
{ "status": "ok", "db": true }
```

### Resource Limits (Recommended)

Add resource constraints to `docker-compose.yml`:
```yaml
services:
  chatbot:
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2'
```

---

## 🔒 Security

- **Authentication is deny-by-default.** `hooks.server.ts` requires a session for
  every route. The only public paths are:
  - `/login` (the page and its form action)
  - `/api/auth/*` — OIDC start/callback and logout, which cannot require a session
  - `/api/health` — the unauthenticated liveness probe the container healthcheck in
    `docker-compose.yml` depends on; it returns only `{status, db}`

  Anything else without a session gets a `401` (under `/api/`) or a `302` to
  `/login?redirectTo=<path>`, and sign-in returns the user to that path
  (same-origin absolute paths only — see `safeRedirectTarget` in `lib/server/auth.ts`).
  Adding a route now protects it by default; there is no list to remember to update.
- **Roles:** admin-only API surfaces and every `/admin` route are checked in the
  same hook (`403`/redirect for a non-admin), on top of the `+layout.server.ts`
  guard. Wiki writes require admin or contributor.
- **Passwords:** Hashed using scrypt (salted, CPU/memory-hard KDF)
- **PAT Tokens:** Encrypted at rest using AES-256-GCM
- **MCP authorization is OAuth 2.1, and only OAuth** (`OAUTH_ROUTE` in
  `hooks.server.ts`). `/api/mcp` accepts nothing but an access token from the
  configured OIDC provider — not the session cookie, and no credential this app
  could issue. Tokens are validated for signature, issuer, expiry and audience;
  the audience check is what stops a token another service behind the same IdP
  holds from working here. The discovery document that makes the flow possible
  (`/.well-known/oauth-protected-resource`) is public and discloses only the
  issuer that browsers are already redirected to. Revocation, MFA and session
  lifetime therefore stay with the identity provider, which is the point: there is
  no second, unreviewed credential store to keep in step.
- **OIDC discovery is issuer-verified:** the provider's discovery document is
  rejected unless its `issuer` matches `OIDC_ISSUER` (RFC 8414 §3.3), and token
  verification refuses to guess endpoints if discovery is unavailable. A `jwks_uri`
  from an unverified document is a key set that can mint tokens this server trusts.
- **Session Duration:** 24 hours (configurable via `SESSION_DURATION_MS` in code)
- **CSP Headers:** Content Security Policy enforced on all responses
- **XSS Prevention:** AI-generated content is sanitized before rendering
- **FTS5 Injection:** Search queries are sanitized to prevent injection

---

## 📝 License

Private / Internal use.