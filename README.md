# Archie: SvelteKit RAG Chatbot with Semantic Knowledge Layer

Archie is a sophisticated Retrieval-Augmented Generation (RAG) chatbot built with SvelteKit, SQLite, and Google Gemini. It goes beyond simple document retrieval by implementing a semantic knowledge layer that extracts topics, relationships, and claims from your documents, ensuring consistency and providing deeper insights.

## 🚀 Features

- **Document Management:** Sync documents from Git repositories or upload them manually.
- **Advanced RAG Pipeline:** Uses hybrid search (Vector + Keyword) with LLM-based reranking.
- **Document Preprocessing:** LLM-powered cleaning removes boilerplate, fixes formatting, and restructures content before ingestion.
- **Semantic Knowledge Layer:** Automatically extracts a knowledge graph (topics, relationships, claims) from documents.
- **LLM-Driven Topic Taxonomy:** Hybrid taxonomy system — incremental placement after each import + full LLM-powered hierarchy rebuild on demand or after git sync.
- **Community Detection:** Unsupervised graph clustering (Louvain) groups related topics into functional domains for exploration and visualization.
- **Consistency Checking:** Detects conflicts and updates in factual claims across your knowledge base.
- **Conflict Resolution UI:** Admin interface with side-by-side comparison of active vs. conflicting claims, with accept/dismiss/reject actions.
- **Knowledge Graph Visualization:** Interactive force-directed graph in the admin dashboard with pan, zoom, node selection, and relationship exploration.
- **Claim Attribution:** Tracks which document version (content hash) produced each claim, with staleness detection when source documents change.
- **Relationship Validation Logging:** Out-of-vocabulary relationship types are tracked and summarized, helping expand the synonym dictionary over time.
- **Semantic Chunking:** Uses LLM to split documents into meaningful sections rather than arbitrary fixed sizes.
- **Real-time Chat:** Conversational interface with streaming responses and source citations.
- **Rich Markdown Responses:** Chat responses are automatically formatted with headers, tables, code blocks, lists, and relationship arrows for maximum readability.
- **Sleek UI:** Modern dark theme with a terminal-inspired aesthetic.
- **Admin Dashboard:** Manage users, repositories, documents, and the knowledge graph through a protected administrative interface.
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
    *   **Claims:** Atomic factual statements or rules found in the text, attributed to specific document versions via content hashes.
*   **Relationship Validation:** Out-of-vocabulary relationship types invented by the LLM are tracked and logged as a summary, providing visibility into vocabulary gaps.
*   **Consistency Management:** When a new claim is extracted, Archie compares it against existing claims for that topic:
    *   **Duplicates:** Semantic duplicates are identified and skipped.
    *   **Conflicts:** If a new claim contradicts an existing one, it is flagged as `conflicting` for review.
    *   **Updates:** If a claim provides more recent or specific information, it is marked accordingly.
*   **Claim Attribution:** Each claim stores the `content_hash` of the source document at extraction time.

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

The chat interface provides a natural way to interact with the knowledge base.

*   **Query Condensation:** Rephrases follow-up questions into standalone search queries.
*   **Hybrid Search:** Vector + FTS5 keyword search, combined via Reciprocal Rank Fusion (RRF).
*   **LLM Reranking:** Top candidates are reranked for maximum relevance.
*   **Contextual Generation:** Responses cite sources using `[Source Name]` format.

---

## 💻 Tech Stack

- **Frontend/Backend:** [SvelteKit](https://kit.svelte.dev/)
- **LLM/Embeddings:** [Google Gemini API](https://ai.google.dev/)
- **Database:** [SQLite](https://www.sqlite.org/)
- **Vector Search:** [sqlite-vector](https://github.com/asg017/sqlite-vector)
- **Git Integration:** [isomorphic-git](https://isomorphic-git.org/)
- **Styling:** Tailwind CSS (Custom dark theme)

---

## ⚙️ Setup

### Prerequisites
- Node.js 20+
- npm

### Installation

1.  **Install dependencies:**
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

- **Passwords:** Hashed using scrypt (salted, CPU/memory-hard KDF)
- **PAT Tokens:** Encrypted at rest using AES-256-GCM
- **Session Duration:** 24 hours (configurable via `SESSION_DURATION_MS` in code)
- **CSP Headers:** Content Security Policy enforced on all responses
- **XSS Prevention:** AI-generated content is sanitized before rendering
- **FTS5 Injection:** Search queries are sanitized to prevent injection

---

## 📝 License

Private / Internal use.