# Luminous Logic AI — AI/ML Research Assistant

A full-stack RAG (Retrieval-Augmented Generation) system that answers questions about artificial intelligence and machine learning using a curated Wikipedia knowledge base. The backend performs hybrid semantic + keyword search over ~1 300 chunks from 39 Wikipedia articles, streams grounded answers with numbered citations, and persists full conversation history. The frontend is a React chat interface with a source-panel sidebar.

---

## Architecture

```
Browser (Next.js 16 + React 19)
  └─ useChat (ai-sdk/react)
       │  full message history + sessionId
       ▼
POST /api/chat  (Next.js edge route)
  └─ extracts plain text, forwards to backend
       │
       ▼
POST /chat  (NestJS + Fastify — port 3001)
  │
  ├─ Persist user message to PostgreSQL (sessions/messages tables)
  │
  ├─ STAGE 1 — Query Intent Analysis
  │   generateObject → Gemini 2.5 Flash
  │   Input:  full conversation
  │   Output: { needsSearch: bool, optimizedQuery: string }
  │
  └─ STAGE 2 — Tool-Augmented Generation
      streamText → Gemini 2.5 Flash
      Tool: search_knowledge_base (up to 7 calls)
        └─ embed query (all-MiniLM-L6-v2, in-process, 384-dim)
        └─ hybrid search: pgvector cosine (70%) + tsvector BM25 (30%)
        └─ aggregate all chunks per section → full section text
        └─ deduplicate across calls (same article+section never returned twice)
      Streams text with inline [N] citations
      ├─ Saves assistant reply + citations to DB
      └─ Appends numbered sources block
```

### Why two stages?

A single `streamText` call would trigger a tool search for every message — including "thanks" or "can you rephrase that?". The intent-analysis step costs one small `generateObject` call but eliminates unnecessary searches for ~30% of conversational messages, and its `optimizedQuery` output resolves pronouns and contextual references before embedding (e.g. "he" → "Geoffrey Hinton").

---

## Technology Choices

### LLM — Gemini 2.5 Flash

Gemini 2.5 Flash was chosen over GPT-4o-mini and Claude Haiku for three reasons:

1. **Streaming latency** — Flash's time-to-first-token is among the fastest available, which matters for a streaming chat UI.
2. **Tool-use reliability** — Gemini 2.5 Flash handles multi-step tool loops (search → read → search) with consistent JSON schema adherence, verified by the eval harness.
3. **Free tier** — Generous daily quota makes development and evaluation cycles cost-free.

Trade-off: no fallback model. A production system would add retry logic and a cheaper fallback for rate-limit errors.

### Vector DB — PostgreSQL + pgvector

PostgreSQL with the `pgvector` extension was chosen over Pinecone, Qdrant, or Weaviate:

- **No extra service** — the application database already runs Postgres; co-locating vectors avoids a second connection pool, separate auth, and network round-trips.
- **Hybrid search for free** — Postgres `tsvector` + `ts_rank_cd` gives BM25-style keyword scoring without external plugins. Vectors and keywords merge in a single SQL query.
- **HNSW indexing** — pgvector's HNSW index (`vector_cosine_ops`) gives sub-millisecond ANN recall for the corpus size (~1 300 chunks). A dedicated vector DB's main advantage (faster indexing at millions of rows) is irrelevant here.
- **Row-level multi-tenancy** — every chunk has a `user_id` column; all queries filter by it. No per-user index required at this scale.

Trade-off: pgvector's HNSW recall degrades vs. Pinecone at >100k rows. Accepted for the current corpus.

### Embedding Model — all-MiniLM-L6-v2

`all-MiniLM-L6-v2` (via `@xenova/transformers`) runs entirely in-process:

- **Zero API latency** — no HTTP round-trip per chunk; embedding is a local matrix multiply.
- **Zero cost** — no per-token charge at ingestion time (39 articles × many chunks) or at query time.
- **384 dimensions** — well-matched to ~1 200-char chunk size; larger models (text-embedding-3-large at 3 072 dim) add cost without proportional gain for encyclopedic content where both query and document share vocabulary.

Trade-off: lags behind `text-embedding-3-small` on asymmetric retrieval (short query vs. long document). Acceptable for Wikipedia content where the language is encyclopedic on both sides.

---

## Chunking Rationale

### Ingestion-time chunking

Articles are split at Wikipedia section boundaries first, then each section is sentence-boundary chunked to ≤ 1 500 characters with 150-character overlap:

- **Section-first** — keeps semantically coherent text together. A chunk never crosses a heading boundary, so retrieval returns topically focused content.
- **1 500-char ceiling** — fits comfortably within the embedding model's 256-token window (~1 200–1 500 chars of English). Longer chunks would be silently truncated by the model.
- **150-char overlap** — prevents a sentence being split across two adjacent chunks, which would cause it to appear in neither at retrieval time. Overlap is small enough not to introduce significant duplicate content.
- **Noise section filtering** — "References", "External Links", "See Also", "Notes", "Bibliography" are excluded. These sections contain no factual prose, only bibliographic metadata that confuses semantic search.

### Retrieval-time re-aggregation

When the search tool is called, the query returns the top-scored `(article, section)` pairs and then re-fetches *all* chunks belonging to those sections, concatenating them in chunk-index order. This means the model always sees the complete section text, not a partial mid-section slice — the 1 500-char ingestion limit is purely a technical constraint on embedding, not on what the model receives.

---

## Prompt Design

### Query intent prompt (`QUERY_ANALYSIS_SYSTEM`)

Uses few-shot examples to establish two behaviours:

1. Factual AI/ML questions → `needsSearch: true` + a standalone, context-resolved query
2. Conversational messages → `needsSearch: false` + empty string

The examples cover the hardest edge cases: pronoun resolution ("he" after a prior assistant turn about Hinton), rephrasing requests, and thanks messages. Without examples, Gemini occasionally marks follow-up rephrases as needing a search. The `optimizedQuery` is injected as a routing hint into the generation prompt rather than used directly to call the tool — the model can still refine it or split it across multiple calls.

### RAG generation prompt (`rag-system.md`)

Five numbered rules establish a strict contract:

| Rule | Purpose |
|------|---------|
| Search first | Prevents the model from answering from training memory |
| Adaptive depth | Calibrates response length to question complexity |
| Cite every claim | Enforces `[N]` footnotes consistent with tool-result numbering |
| Stay grounded | Explicit fallback text when context is insufficient |
| Search discipline | Hard cap of 7 tool calls; each call must use a different query angle; stop immediately on "no new sections found" |

The search discipline rule was added to prevent the model from making redundant calls with near-identical queries after the first few results were already retrieved — a pattern observed before the cap was introduced.

---

## Quick Start

### Prerequisites

- Node.js ≥ 20, pnpm ≥ 9
- PostgreSQL ≥ 15 with the `pgvector` extension
- Google AI API key (free at [aistudio.google.com](https://aistudio.google.com))

### 1. Install dependencies

```bash
pnpm install          # installs both ai-backend and ai-frontend
```

Or install each workspace separately:

```bash
cd ai-backend && pnpm install
cd ai-frontend && pnpm install
```

### 2. Configure the backend

Create `ai-backend/.env`:

```env
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here

DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_backend
DB_USER=postgres
DB_PASSWORD=postgres

# Scope for the knowledge base (default used by CLI and frontend)
RAG_USER_ID=cli-system
```

Create `ai-frontend/.env.local`:

```env
BACKEND_URL=http://localhost:3001
```

### 3. Create the database

```bash
psql -U postgres -c "CREATE DATABASE ai_backend;"
psql -U postgres -d ai_backend -f ai-backend/scripts/init.sql
```

The schema creates the `chunks`, `sessions`, `messages`, and `citations` tables, plus the HNSW and GIN indexes.

### 4. Populate the knowledge base

```bash
pnpm ingest
```

This embeds 39 curated AI/ML Wikipedia articles (~1 300 chunks). Takes 5–10 minutes on first run; subsequent runs are idempotent — unchanged articles (same `revisionId`) are skipped.

### 5. Start both services

```bash
# Terminal 1
cd ai-backend && pnpm start:dev   # http://localhost:3001

# Terminal 2
cd ai-frontend && pnpm dev        # http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000), enter a username, and start chatting.

---

## API Reference

```bash
# Streaming chat (Server-Sent Events)
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is backpropagation?",
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "username": "demo"
  }'

# Corpus health check
curl http://localhost:3001/debug?userId=cli-system
```

---

## Evaluation

### Running

```bash
pnpm evaluate          # from repo root
# or
cd ai-backend && pnpm evaluate
```

The harness runs 14 test cases against the live `RagAgent` and produces `ai-backend/eval-results.json`.

### Test case categories

| Category | Cases | What it tests |
|----------|-------|---------------|
| `simple-factual` | 6 | Single-concept factual recall with citations |
| `multi-document` | 2 | Cross-article synthesis (e.g. Hinton + backpropagation) |
| `follow-up` | 2 | Pronoun resolution and context carry-over |
| `out-of-scope` | 2 | Graceful refusal for non-AI/ML topics |
| `conversational` | 2 | No search triggered for thanks/rephrase messages |

### Metrics

**Phase 1 — Behavioural (deterministic)**

| Metric | Passes when |
|--------|------------|
| `tool_called` | Matches `expectToolCall` exactly |
| `has_citations` | Response contains at least one `[N]` footnote (factual cases only) |
| `keyword_hit_rate` | ≥ `minKeywordHitRate` of expected domain keywords found |

**Phase 2 — LLM-as-judge (Gemini 2.5 Flash, 1–5 scale)**

| Dimension | What it measures |
|-----------|-----------------|
| Groundedness | Answer relies on retrieved sources; no hallucination |
| Accuracy | Factual correctness using judge's own knowledge |
| Relevance | Directly and completely addresses the question |
| Tool discipline | Right number of calls, diverse queries, stopped when sufficient |
| Citation quality | Citations present, correctly numbered, anchored to claims |

### Results analysis

See [`ai-backend/eval-results.json`](ai-backend/eval-results.json) for the full machine-readable run.

**Summary (latest run)**

| Metric | Score |
|--------|-------|
| Behavioural pass rate | 13 / 14 (93%) |
| Tool call accuracy | 100% |
| Citation rate | 92% |
| Avg keyword hit rate | 88% |
| Avg LLM judge score | 4.1 / 5.0 |

**Per-dimension judge scores**

| Dimension | Score |
|-----------|-------|
| Groundedness | 4.3 |
| Accuracy | 4.2 |
| Relevance | 4.4 |
| Tool discipline | 3.9 |
| Citation quality | 3.7 |

**Observations**

- **Tool discipline is the weakest dimension (3.9/5)** — the model occasionally makes 2–3 calls when 1 would suffice for simple factual questions. The 7-call cap and search discipline prompt rule prevent runaway loops but don't eliminate mild over-searching on ambiguous queries.
- **Citation quality (3.7/5)** — citations are consistently present on factual responses, but the judge penalises cases where a numbered footnote refers to a source that only tangentially supports the claim. This is a retrieval-precision issue rather than a prompting issue.
- **Out-of-scope refusal is imperfect** — one of the two OOB cases (FIFA World Cup) sometimes triggers a search attempt before correctly refusing. The query-intent router correctly marks `needsSearch: true` because football is factual, but the knowledge base returns nothing, which causes a graceful fallback. The behavioural test passes (correct refusal), but the judge scores relevance lower because the refusal message is longer than necessary.
- **Follow-up context works reliably** — both follow-up cases pass; pronoun resolution in the `optimizedQuery` correctly expands "he" to "Geoffrey Hinton" and "it" to "self-attention", confirmed by the keyword hit rates (100% on both cases).
- **Multi-document synthesis is strong (accuracy 4.5/5 on those cases)** — the full-section aggregation change means the model receives complete section text for both articles in a single tool round-trip, enabling coherent cross-article comparisons.

Re-run `pnpm evaluate` after any prompt or retrieval changes to update the committed results.

---

## Project Structure

```
ai-project-tappz/
├── README.md                      ← you are here
├── package.json                   ← pnpm workspace root (ingest / evaluate scripts)
├── pnpm-workspace.yaml
│
├── ai-backend/                    ← NestJS + Fastify API
│   ├── eval-results.json          ← committed evaluation output
│   ├── prompts/
│   │   ├── rag-system.md          ← RAG generation prompt
│   │   └── query-analysis.md      ← query intent prompt
│   ├── scripts/
│   │   └── init.sql               ← database schema (run once)
│   └── src/
│       ├── ai/
│       │   ├── ai.controller.ts   ← POST /chat — validates, streams, persists
│       │   ├── rag.agent.ts       ← two-stage RAG pipeline
│       │   └── prompts.ts         ← prompt builders + QUERY_ANALYSIS_SYSTEM
│       ├── embedding/
│       │   └── embedding.service.ts  ← all-MiniLM-L6-v2 via @xenova/transformers
│       ├── ingest/
│       │   ├── ingest.service.ts  ← search → rank → chunk → embed → upsert
│       │   └── wikipedia.client.ts   ← Wikipedia API + quality scorer + chunker
│       ├── db/
│       │   ├── vector.repositorty.ts ← hybrid search (pgvector + FTS)
│       │   └── chat.repository.ts    ← sessions, messages, citations
│       ├── eval/
│       │   ├── harness.ts         ← evaluation runner (behavioural + LLM judge)
│       │   └── test-cases.json    ← 14 test cases across 5 categories
│       └── cli/
│           └── ingest.ts          ← batch ingest CLI for the curated corpus
│
└── ai-frontend/                   ← Next.js 16 + React 19
    └── src/
        ├── app/
        │   ├── api/chat/route.ts  ← Next.js route → backend proxy + SSE reformat
        │   └── chat/page.tsx      ← main chat page (useChat, session mgmt)
        └── components/
            ├── ChatWindow.tsx
            ├── MessageWindow.tsx
            ├── Sidebar.tsx        ← session list
            ├── SourcePanel.tsx    ← citations sidebar
            └── Citations.tsx
```
