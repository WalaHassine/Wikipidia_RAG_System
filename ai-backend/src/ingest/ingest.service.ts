import { WikipediaClient, WikiChunk, ArticleScore } from "./wikipedia.client";
import { VectorRepository } from "src/db/vector.repositorty";
import { EmbeddingService } from "src/embedding/embedding.service";

// --- Public types ------------------------------------------------------------

export interface IngestOptions {
  /** Tenant/owner. Every upserted vector is scoped to this user. */
  userId: string;
  /** Free-text topic the user wants indexed. */
  topic: string;
  /** How many search hits to consider for ranking. Default 15. */
  searchLimit?: number;
  /** How many ranked articles to actually fetch + embed. Default 5. */
  topK?: number;
  /** Reject anything whose total score is below this floor. Default 0.2. */
  minScore?: number;
  /** Max in-flight article pipelines. Default 3 — polite to Wikipedia. */
  concurrency?: number;
  /** Embedding batch size. Default 32. */
  embedBatchSize?: number;
  /** Opt-in to pageviews signal in ranking (adds N HTTP calls). Default false. */
  includePageviews?: boolean;
}

export type ArticleStatus =
  | "ingested"          // fetched, embedded, upserted
  | "skipped-cached"    // already indexed at this revisionId
  | "skipped-rejected"  // filtered by quality scorer
  | "skipped-empty"     // disambiguation / no indexable content
  | "failed";           // threw during processing

export interface ArticleReport {
  title: string;
  pageId: number;
  revisionId: number;
  status: ArticleStatus;
  chunkCount: number;
  score?: number;
  reason?: string;
}

export interface IngestResult {
  userId: string;
  topic: string;
  articles: ArticleReport[];
  totalChunksIngested: number;
  durationMs: number;
}

// --- Service -----------------------------------------------------------------

export class IngestService {
  constructor(
    private wiki: WikipediaClient,
    private embed: EmbeddingService,
    private db: VectorRepository,
  ) {}

  async ingest(opts: IngestOptions): Promise<IngestResult> {
    const {
      userId,
      topic,
      searchLimit = 15,
      topK = 5,
      minScore = 0.2,
      concurrency = 3,
      embedBatchSize = 32,
      includePageviews = false,
    } = opts;

    if (!userId) throw new Error("ingest: userId is required");
    if (!topic?.trim()) throw new Error("ingest: topic is required");

    const startedAt = Date.now();

    // 1. Rank candidates up front — this filters stubs + disambiguation cheaply.
    const ranking = await this.wiki.searchAndRank(topic, {
      limit: searchLimit,
      includePageviews,
    });

    const picks: ArticleScore[] = [];
    const rejects: ArticleReport[] = [];

    for (const r of ranking) {
      if (picks.length >= topK) break;
      if (r.rejected) {
        rejects.push({
          title: r.title, pageId: r.pageId, revisionId: 0,
          status: "skipped-rejected", chunkCount: 0,
          score: r.total, reason: r.rejected,
        });
        continue;
      }
      if (r.total < minScore) {
        rejects.push({
          title: r.title, pageId: r.pageId, revisionId: 0,
          status: "skipped-rejected", chunkCount: 0,
          score: r.total, reason: `score ${r.total.toFixed(3)} < ${minScore}`,
        });
        continue;
      }
      picks.push(r);
    }

    // 2. Bounded-concurrency per-article pipeline. One bad article doesn't
    //    kill the batch — failures are captured as status: "failed".
    const limit = makeLimiter(concurrency);
    const ingested = await Promise.all(
      picks.map(p =>
        limit(() => this.ingestOne(userId, p, embedBatchSize)),
      ),
    );

    const articles = [...ingested, ...rejects];
    const totalChunksIngested = articles
      .filter(a => a.status === "ingested")
      .reduce((s, a) => s + a.chunkCount, 0);

    return {
      userId,
      topic,
      articles,
      totalChunksIngested,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Process a single article end-to-end. Returns a report; never throws. */
  private async ingestOne(
    userId: string,
    pick: ArticleScore,
    embedBatchSize: number,
  ): Promise<ArticleReport> {
    try {
      const chunks = await this.wiki.fetchChunks(pick.title);

      if (chunks.length === 0) {
        return {
          title: pick.title, pageId: pick.pageId, revisionId: 0,
          status: "skipped-empty", chunkCount: 0, score: pick.total,
          reason: "Disambiguation page or no indexable sections",
        };
      }

      const revisionId = chunks[0].metadata.revisionId;

      // Idempotency: if we already indexed this exact revision for this user,
      // skip the embed cost entirely. Re-running ingest() is safe and cheap.
      if (await this.db.existsForUser(userId, pick.pageId, revisionId)) {
        return {
          title: pick.title, pageId: pick.pageId, revisionId,
          status: "skipped-cached", chunkCount: chunks.length,
          score: pick.total,
        };
      }

      // Clear stale chunks from any earlier revision of this page for this user.
      // Keeps the index free of abandoned vectors from prior article versions.
      await this.db.deleteUserPage(userId, pick.pageId);

      // Embed in batches — almost every embedding provider charges per request
      // and supports batch inputs. 32 is a safe default.
      const vectors = await this.embedInBatches(chunks, embedBatchSize);

      // Extract the document-level introduction from the lead/Introduction section.
      // Falls back to the first chunk if no introduction section is found.
      const introChunk =
        chunks.find(
          c => c.metadata.section === 'Introduction' || c.metadata.section === '',
        ) ?? chunks[0];
      const documentIntroduction = introChunk.content;

      // Upsert with user-scoped IDs + user-scoped metadata. Retrieval at query
      // time MUST filter by userId — make that the repository's responsibility.
      await this.db.upsertMany(
        chunks.map((chunk, i) => ({
          id: `${userId}:${pick.pageId}:${revisionId}:${chunk.metadata.chunkIndex}`,
          userId,
          pageId: pick.pageId,
          revisionId,
          articleTitle: pick.title,
          documentIntroduction,
          sectionTitle: chunk.metadata.section || 'Introduction',
          content: chunk.content,
          metadata: { ...chunk.metadata, userId },
          vector: vectors[i],
        })),
      );

      return {
        title: pick.title, pageId: pick.pageId, revisionId,
        status: "ingested", chunkCount: chunks.length, score: pick.total,
      };
    } catch (err) {
      return {
        title: pick.title, pageId: pick.pageId, revisionId: 0,
        status: "failed", chunkCount: 0, score: pick.total,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async embedInBatches(
    chunks: WikiChunk[],
    batchSize: number,
  ): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize).map(c => c.content);
      const vectors = await this.embed.embedBatch(batch);
      out.push(...vectors);
    }
    return out;
  }
}

// --- Zero-dep concurrency limiter -------------------------------------------
// Equivalent to p-limit(max). Returned function queues callers beyond `max`.

function makeLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  const pump = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (!run) return;
    active++;
    run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => { active--; pump(); });
      });
      pump();
    });
}