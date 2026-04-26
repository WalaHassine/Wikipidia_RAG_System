import { Pool } from "pg";

export interface UpsertRecord {
  id: string;
  userId: string;
  pageId: number;
  revisionId: number;
  articleTitle: string;
  documentIntroduction: string;
  sectionTitle: string;
  content: string;
  metadata: any;
  vector: number[];
}

export interface HybridResult {
  article: string;
  section: string;
  content: string;
  formattedContext: string;
  score: number;
  url: string;
}

export class VectorRepository {
  constructor(private pool: Pool) {}

  // 1. Check for Idempotency
  async existsForUser(userId: string, pageId: number, revisionId: number): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM chunks
       WHERE user_id = $1 AND page_id = $2 AND revision_id = $3
       LIMIT 1`,
      [userId, pageId, revisionId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // 2. Clear bad Chunks
  async deleteUserPage(userId: string, pageId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM chunks
       WHERE user_id = $1 AND page_id = $2`,
      [userId, pageId]
    );
  }

  // 3. Batch Upsert (Optimized with UNNEST)
  async upsertMany(records: UpsertRecord[]): Promise<void> {
    if (records.length === 0) return;

    const ids                   = records.map(r => r.id);
    const userIds               = records.map(r => r.userId);
    const pageIds               = records.map(r => r.pageId);
    const revisionIds           = records.map(r => r.revisionId);
    const articleTitles         = records.map(r => r.articleTitle);
    const documentIntroductions = records.map(r => r.documentIntroduction);
    const sectionTitles         = records.map(r => r.sectionTitle);
    const contents              = records.map(r => r.content);
    const metadatas             = records.map(r => JSON.stringify(r.metadata));
    const vectors               = records.map(r => `[${r.vector.join(",")}]`);

    await this.pool.query(
      `INSERT INTO chunks
         (id, user_id, page_id, revision_id, article_title,
          document_introduction, section_title, content, metadata, embedding)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::int[], $4::int[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::vector[]
       )
       ON CONFLICT (id)
       DO UPDATE SET
         content               = EXCLUDED.content,
         metadata              = EXCLUDED.metadata,
         embedding             = EXCLUDED.embedding,
         revision_id           = EXCLUDED.revision_id,
         article_title         = EXCLUDED.article_title,
         document_introduction = EXCLUDED.document_introduction,
         section_title         = EXCLUDED.section_title`,
      [ids, userIds, pageIds, revisionIds, articleTitles,
       documentIntroductions, sectionTitles, contents, metadatas, vectors]
    );
  }

  // 4. Hybrid Search (semantic vector + BM25-style tsvector)
  // Returns full section text by aggregating all chunks that belong to the
  // top-scored (article, section) pairs — prevents the model from seeing only
  // a partial slice of a section.
  async searchHybrid(
    userId: string,
    query: string,
    vector: number[],
    limit = 5,
  ): Promise<HybridResult[]> {
    const vectorStr = `[${vector.join(",")}]`;
    const alpha = 0.7;

    const res = await this.pool.query(
      `WITH vector_search AS (
         SELECT id, 1 - (embedding <=> $1::vector) AS vector_score
         FROM chunks WHERE user_id = $2
         ORDER BY embedding <=> $1::vector LIMIT 50
       ),
       keyword_search AS (
         SELECT id,
           ts_rank_cd(fts_index, websearch_to_tsquery('english', $3)) AS keyword_score
         FROM chunks
         WHERE user_id = $2
           AND fts_index @@ websearch_to_tsquery('english', $3)
         LIMIT 50
       ),
       scored AS (
         SELECT
           c.article_title,
           c.section_title,
           ($4 * COALESCE(v.vector_score, 0)) +
             ((1 - $4) * COALESCE(k.keyword_score, 0)) AS final_score
         FROM chunks c
         LEFT JOIN vector_search  v ON c.id = v.id
         LEFT JOIN keyword_search k ON c.id = k.id
         WHERE v.id IS NOT NULL OR k.id IS NOT NULL
       ),
       top_sections AS (
         SELECT article_title, section_title, MAX(final_score) AS section_score
         FROM scored
         GROUP BY article_title, section_title
         ORDER BY section_score DESC
         LIMIT $5
       )
       SELECT
         ts.article_title,
         ts.section_title,
         ts.section_score                                              AS final_score,
         string_agg(
           c.content, ' '
           ORDER BY COALESCE((c.metadata->>'chunkIndex')::int, 0)
         )                                                             AS content,
         MIN(c.metadata->>'url')                                       AS url
       FROM top_sections ts
       JOIN chunks c
         ON c.article_title = ts.article_title
        AND c.section_title = ts.section_title
        AND c.user_id = $2
       GROUP BY ts.article_title, ts.section_title, ts.section_score
       ORDER BY ts.section_score DESC`,
      [vectorStr, userId, query, alpha, limit],
    );

    return res.rows.map(r => ({
      article:          r.article_title,
      section:          r.section_title,
      content:          r.content,
      formattedContext: `[Article: ${r.article_title} > Section: ${r.section_title}]\n${r.content}`,
      score:            parseFloat(r.final_score),
      url:              (r.url as string) ?? '',
    }));
  }
}
