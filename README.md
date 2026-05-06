# Archie: SvelteKit RAG Chatbot with Semantic Knowledge Layer

Archie is a sophisticated Retrieval-Augmented Generation (RAG) chatbot built with SvelteKit, SQLite, and Google Gemini. It goes beyond simple document retrieval by implementing a semantic knowledge layer that extracts topics, relationships, and claims from your documents, ensuring consistency and providing deeper insights.

## 🚀 Features

- **Document Management:** Sync documents from Git repositories or upload them manually.
- **Advanced RAG Pipeline:** Uses hybrid search (Vector + Keyword) with LLM-based reranking.
- **Semantic Knowledge Layer:** Automatically extracts a knowledge graph (topics, relationships, claims) from documents.
- **LLM-Driven Topic Taxonomy:** Hybrid taxonomy system — incremental placement after each import + full LLM-powered hierarchy rebuild on demand or after git sync.
- **Consistency Checking:** Detects conflicts and updates in factual claims across your knowledge base.
- **Conflict Resolution UI:** Admin interface with side-by-side comparison of active vs. conflicting claims, with accept/dismiss/reject actions.
- **Knowledge Graph Visualization:** Interactive force-directed graph in the admin dashboard with pan, zoom, node selection, and relationship exploration.
- **Claim Attribution:** Tracks which document version (content hash) produced each claim, with staleness detection when source documents change.
- **Relationship Validation Logging:** Out-of-vocabulary relationship types are tracked and summarized, helping expand the synonym dictionary over time.
- **Semantic Chunking:** Uses LLM to split documents into meaningful sections rather than arbitrary fixed sizes.
- **Real-time Chat:** Conversational interface with streaming responses and source citations.
- **Sleek UI:** Modern dark theme with a terminal-inspired aesthetic.
- **Admin Dashboard:** Manage users, repositories, documents, and the knowledge graph through a protected administrative interface.
  - **Knowledge Graph Visualization:** Interactive force-directed canvas graph with category-colored nodes, directed edges, zoom/pan, and node detail panels.
  - **Conflict Resolution:** Side-by-side comparison of active vs. conflicting claims with accept/dismiss/reject actions and document version tracking.
  - **Taxonomy Management:** View topic hierarchy by category and parent-child tree, trigger LLM-powered taxonomy rebuilds.

---

## 🛠️ How It Works

### 1. Document Processing & Ingestion

The ingestion pipeline is designed to transform raw text into searchable, structured data.

*   **Git Sync:** The system can monitor Git repositories for changes. It uses commit hashes and SHA-256 content hashes to detect new, modified, or deleted files, ensuring the knowledge base stays in sync with your source of truth. Personal Access Tokens (PATs) are encrypted at rest using AES-256-GCM.
*   **Chunking Strategy:**
    *   **Semantic Chunking:** For documents under 50k characters, Archie uses Gemini to identify logical boundaries and split the text into semantically coherent sections.
    *   **Markdown-Aware Fallback:** For larger documents, it falls back to a regex-based approach that respects Markdown headers, paragraphs, and sentences, with configurable overlap.
*   **Vectorization:** Each chunk is embedded using Gemini's embedding model. These embeddings are stored in a SQLite database using the `sqlite-vector` extension for efficient similarity search.
*   **Full-Text Search (FTS5):** In addition to vectors, chunks are indexed using SQLite's FTS5 for high-precision keyword matching.

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

### 4. Chatbot & RAG Pipeline

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