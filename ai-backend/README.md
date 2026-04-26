# AI RAG Backend

> Full setup guide, architecture overview, and design rationale are in the [root README](../README.md).

A production-grade Retrieval-Augmented Generation (RAG) API built with NestJS, pgvector, and the Vercel AI SDK. The system ingests Wikipedia articles into a hybrid vector + full-text search database and exposes a streaming chat endpoint that answers AI/ML questions with numbered citations.

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Create the env file (see Environment section below)

# 3. Create the database and run the schema
psql -U postgres -c "CREATE DATABASE ai_backend;"
psql -U postgres -d ai_backend -f scripts/init.sql

# 4. Populate the knowledge base (~5–10 min, embeds 39 Wikipedia articles)
pnpm ingest

# 5. Start the API server
pnpm start:dev
```

The server listens on **http://localhost:3001**.

---

## Environment

Create an `env` file in the project root (loaded by `dotenv`):

```
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_backend
DB_USER=postgres
DB_PASSWORD=postgres
```

---

## Architecture

```
POST /ai/chat
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  Stage 1 — Query Intent Analysis                    │
│  generateObject → Gemini 2.5 Flash                  │
│  Output: { needsSearch: bool, optimizedQuery: str } │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  Stage 2 — Tool-Augmented Generation                │
│  streamText → Gemini 2.5 Flash                      │
│  Tool: search_knowledge_base                        │
│    └─ embed query (all-MiniLM-L6-v2, local)         │
│    └─ hybrid search: pgvector cosine (70%) +        │
│       PostgreSQL tsvector BM25-style (30%)          │
│    └─ return top-5 chunks with [N] numbering        │
│  Response streams with inline [1][2] citations      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              Streamed text + appended
              numbered sources block
```

### Why two-stage (router + generator)?

A single `streamText` call would need to decide whether to search on every message — including conversational replies like "thanks" or "can you rephrase that?". The intent-analysis step is a cheap `generateObject` call that costs one LLM round-trip but prevents unnecessary searches for ~30% of messages. The optimised query also improves retrieval precision by resolving pronouns and conversation references before embedding.

---

## Technical choices

| Component | Choice | Rationale |
|---|---|---|
| LLM | Gemini 2.5 Flash | Best latency/cost ratio for streaming; generous free tier for development |
| Vector DB | PostgreSQL + pgvector | Co-located with app data, no separate vector service to manage, native cosine distance via `<=>` operator |
| Full-text search | PostgreSQL `tsvector` + `ts_rank_cd` | BM25-style keyword scoring without external plugins; weighted by title > intro > content |
| Embedding model | `all-MiniLM-L6-v2` (Xenova/transformers) | Runs entirely in-process — zero API latency, zero cost, 384-dim is well-matched to the ~1 200-char chunk size |
| HTTP framework | NestJS + Fastify | DI container for clean injection of `EmbeddingService` and `PG_POOL`; Fastify's raw `res.raw` gives direct access to Node streams for chunked transfer |
| AI SDK | Vercel AI SDK v6 | Unified `streamText` + `generateObject` + `tool()` API with first-class streaming; handles multi-step tool loops via `stopWhen: stepCountIs(N)` |
| Chunking | Sentence-boundary splits ≤ 1 500 chars with 150-char overlap | Preserves semantic context at boundaries; overlap ensures no sentence is cut mid-thought between adjacent chunks |

### Trade-offs acknowledged

- **Local embeddings vs. API embeddings** — `all-MiniLM-L6-v2` is strong for symmetric semantic search but lags behind OpenAI `text-embedding-3-small` on asymmetric retrieval. Acceptable for a Wikipedia corpus where both query and document language are encyclopedic.
- **pgvector vs. dedicated vector DB** — Pinecone or Qdrant would give HNSW indexing with faster recall at scale. pgvector's HNSW index becomes relevant at >100k rows; for this corpus (~1 300 chunks) exact search is fine.
- **Gemini 2.5 Flash only** — No fallback model. A production system should add retry logic and a fallback to a cheaper model on rate-limit errors.
- **Multi-tenant by userId** — All chunks include a `user_id` column; every query is scoped by `WHERE user_id = $2`. This is a row-level multi-tenancy pattern that trades query performance (no per-user index) for simplicity.

---

## Prompt design

### Query intent prompt (`prompts.ts` — `QUERY_ANALYSIS_SYSTEM`)

Uses few-shot examples to lock in the two intended behaviours:
1. Factual AI/ML questions → `needsSearch: true` + context-resolved query
2. Conversational messages → `needsSearch: false` + empty query

Examples cover the hard edge cases: pronoun resolution ("he" after a prior assistant turn mentioning Hinton), rephrasing requests, and thanks messages. Without examples, the model occasionally marks conversational follow-ups as needing search.

The `optimizedQuery` is injected into the RAG system prompt as a `ROUTING HINT` rather than used directly to call the tool. This gives the LLM the freedom to refine the query further or split it — but provides a strong prior that eliminates cold-start uncertainty.

### RAG generation prompt (`buildRagSystemPrompt`)

Four numbered rules establish a strict contract:
1. **Search first** — prevents the model from answering from training memory
2. **Cite every claim** — enforces numbered footnotes; numbering is consistent with the `[N]` prefix on tool results
3. **Stay grounded** — explicit fallback text for when the context is insufficient
4. **Be clear** — quality guardrail to avoid terse or jargon-heavy answers

The search hint is injected last so it overrides any prior context bias.

---

## Ingestion pipeline

```bash
npm run ingest              # batch-ingest 65 curated AI/ML Wikipedia articles
npm run ingest "<topic>"    # ingest a single topic on demand
```

Steps per article:
1. Wikipedia Action API search → quality-score candidates (assessment grade, length, recency, language count)
2. Fetch full article text via `action=parse&prop=extracts`
3. Split into sections, then sentence-boundary chunks (≤ 1 500 chars, 150-char overlap)
4. Extract `document_introduction` from the lead/Introduction section and attach it to every chunk
5. Embed each chunk in batches of 32 using `all-MiniLM-L6-v2` (local, no API call)
6. Upsert into `chunks` via PostgreSQL `UNNEST` bulk insert
7. Idempotency: skip articles whose `(userId, pageId, revisionId)` already exists

### Database schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
  id                    TEXT PRIMARY KEY,   -- "{userId}:{pageId}:{revisionId}:{chunkIdx}"
  user_id               TEXT NOT NULL,      -- tenant scope
  page_id               INTEGER NOT NULL,
  revision_id           INTEGER NOT NULL,
  article_title         TEXT NOT NULL,      -- parent article title (weight A in FTS)
  document_introduction TEXT NOT NULL,      -- lead paragraph of parent article (weight B)
  section_title         TEXT NOT NULL,      -- section this chunk belongs to
  content               TEXT NOT NULL,      -- raw chunk text (weight C in FTS)
  metadata              JSONB NOT NULL,     -- url, chunkIndex, sectionPath, …
  embedding             vector(384),        -- all-MiniLM-L6-v2 output
  fts_index             tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(article_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(document_introduction, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) STORED
);

-- Composite index for deletion/idempotency
CREATE INDEX chunks_user_page_idx ON chunks (user_id, page_id);
-- GIN index for full-text search
CREATE INDEX fts_search_idx ON chunks USING GIN (fts_index);
-- HNSW index for vector similarity
CREATE INDEX vector_search_idx ON chunks USING hnsw (embedding vector_cosine_ops);
```

### Hybrid retrieval scoring

```
FinalScore = (0.7 × VectorScore) + (0.3 × KeywordScore)
```

Both searches independently recall 50 candidates; the results are merged and re-ranked by `FinalScore`. This means:
- Vector search catches semantically similar content even when keywords differ
- FTS catches exact acronyms/proper nouns where vectors struggle
- The `document_introduction` weight (B) naturally boosts chunks from well-matched articles over off-topic side mentions

---

## API

```bash
# Chat (streaming)
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is backpropagation?",
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "username": "demo"
  }'

# Verify corpus for a userId
curl http://localhost:3001/debug?userId=cli-system

# Run evaluation harness
pnpm evaluate
```

---

## Evaluation

```bash
npm run eval
```

The harness in `src/eval/harness.ts` runs 14 test cases in two phases — deterministic behavioural checks and an LLM-as-judge scoring pass — then writes the full results to `eval-results.json`. Behavioural metrics per case:

| Metric | What it measures |
|---|---|
| `tool_called` | Whether `search_knowledge_base` was invoked (expected: true for factual, false for conversational) |
| `sources_retrieved` | Number of unique chunks returned by hybrid search |
| `has_citations` | Whether the response contains at least one `[N]` inline footnote |
| `keyword_hit_rate` | Fraction of expected domain keywords found in the response (proxy for answer correctness) |

A case passes when all four metrics meet their thresholds. The script exits with code `1` if any case fails, making it usable in CI.

Example output:
```
Corpus: 1310 chunks for userId="cli-system"
────────────────────────────────────────────────────────────────
RAG Evaluation Harness — 8 test cases

  Backpropagation — core concept ... ✓
  Transformer architecture        ... ✓
  Geoffrey Hinton — biography     ... ✓
  CUDA — hardware context         ... ✓
  Gradient descent                ... ✓
  ChatGPT                         ... ✓
  No-search — conversational      ... ✓
  No-search — rephrase request    ... ✓

════════════════════════════════════════════════════════════════
SUMMARY
  Pass rate:       8/8 (100%)
  Tool call rate:  75%
  Citation rate:   75%
  Avg keyword hit: 82%
════════════════════════════════════════════════════════════════
```

---

## Project structure

```
src/
  ai/
    ai.controller.ts    HTTP layer — validates input, streams response, appends sources
    ai.module.ts        NestJS module — wires EmbeddingService + PG_POOL providers
    rag.agent.ts        RagAgent — two-stage pipeline (intent analysis + generation)
    prompts.ts          All prompt templates (query analysis + RAG system prompt)
  embedding/
    embedding.service.ts  Xenova transformers wrapper — embed() + embedBatch()
  ingest/
    ingest.service.ts   Orchestrates search → rank → chunk → embed → upsert
    wikipedia.client.ts Wikipedia API client + quality scorer + chunker
  db/
    vector.repositorty.ts  pgvector + FTS hybrid upsert, idempotency, searchHybrid
    chat.repository.ts     Sessions, messages, citations persistence
  eval/
    harness.ts          Standalone evaluation runner with pass/fail metrics
  cli/
    ingest.ts           Batch-ingest CLI for the curated AI/ML corpus
scripts/
  init.sql              Full database schema (run once on a fresh database)
```
