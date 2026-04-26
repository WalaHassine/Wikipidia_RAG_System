import { streamText, generateObject, tool, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { Pool } from 'pg';
import { EmbeddingService } from 'src/embedding/embedding.service';
import { VectorRepository } from 'src/db/vector.repositorty';
import {
  QUERY_ANALYSIS_SYSTEM,
  buildRagSystemPrompt,
  buildSearchHint,
} from './prompts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const queryIntentSchema = z.object({
  needsSearch: z
    .boolean()
    .describe('True if factual knowledge lookup is required to answer the user.'),
  optimizedQuery: z
    .string()
    .describe(
      'Standalone, context-resolved search query. Empty string when needsSearch is false.',
    ),
});

// Structured citations schema required by the challenge spec.
export const CitationSchema = z.object({
  citations: z.array(
    z.object({
      id: z.number(),
      sourceTitle: z.string(),
      excerpt: z.string(),
    }),
  ),
});

export type StructuredCitations = z.infer<typeof CitationSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type QueryIntent={
  needsSearch: boolean;
  optimizedQuery: string;
}
export interface RetrievedChunk {
  title: string;
  section: string;
  url: string;
  content: string;
  score: number;
}

export interface ChatSource {
  title: string;
  url: string;
  content: string;
}

export interface ChatResult {
  textStream: AsyncIterable<string>;
  getSources: () => ChatSource[];
  generateStructuredCitations: (
    answer: string,
  ) => Promise<StructuredCitations>;
}

// ---------------------------------------------------------------------------
// RagAgent
// ---------------------------------------------------------------------------

/**
 * Two-stage RAG pipeline:
 *  Stage 1 — generateObject: analyse query intent, decide if retrieval is needed,
 *             produce an optimised standalone search query.
 *  Stage 2 — streamText with tool use: generate a grounded, cited response using
 *             the search_knowledge_base tool backed by hybrid search (pgvector
 *             cosine + PostgreSQL full-text tsvector BM25-style scoring).
 *
 * Separation rationale: query-intent analysis is a small, fast, structured call
 * that improves retrieval precision and reduces unnecessary tool invocations.
 * The two-stage design follows the "router + generator" RAG pattern.
 */

async function safeGenerateIntent(messages: any[], maxRetries = 3) {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await generateObject({
        model: google('gemini-2.5-flash'),
        system: QUERY_ANALYSIS_SYSTEM,
        messages,
        schema: queryIntentSchema,
      });

      const intent = result?.object;

      // Basic sanity checks (augment beyond schema if needed)
      if (
        intent &&
        typeof intent.needsSearch === 'boolean' &&
        typeof intent.optimizedQuery === 'string'
      ) {
        return intent;
      }

      throw new Error('Invalid intent structure');
    } catch (err) {
      lastError = err;
      console.warn(`[IntentRetry] attempt=${attempt} failed`, err);
    }
  }

  throw lastError;
}

function fallbackIntent(messages: any[]) : QueryIntent   {
  const lastUserMessage =
    messages?.filter(m => m.role === 'user').pop()?.content ?? '';

  return {
    needsSearch: true, // bias toward recall
    optimizedQuery: lastUserMessage.slice(0, 200), // crude but effective
  };
}
export class RagAgent {
  private repo: VectorRepository;

  constructor(
    private pool: Pool,
    private embedder: EmbeddingService,
  ) {
    this.repo = new VectorRepository(pool);
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  async searchVectorDb(
    userId: string,
    query: string,
    limit = 5,
  ): Promise<RetrievedChunk[]> {
    const queryVector = await this.embedder.embed(query);

    console.log(
      `[Retrieval] userId="${userId}" dims=${queryVector.length} query="${query.slice(0, 80)}"`,
    );

    const results = await this.repo.searchHybrid(userId, query, queryVector, limit);

    console.log(`[Retrieval] rows returned: ${results.length}`);

    return results.map(r => ({
      title: r.article,
      section: r.section,
      url: r.url,
      content: r.content,
      score: r.score,
    }));
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  async chat(userId: string, messages: any[]): Promise<ChatResult> {
    // Stage 1: Query intent analysis with fallback logic (retry mechanism)
    let intent: QueryIntent;
    try {
      intent = await safeGenerateIntent(messages);
    } catch (err) {
      console.error('[IntentFallback] using fallback intent', err);
      intent = fallbackIntent(messages);
    }
    console.log(
      `[QueryIntent] needsSearch=${intent.needsSearch} query="${intent.optimizedQuery}"`
    );
    const searchHint = buildSearchHint(
      intent.needsSearch,
      intent.optimizedQuery
    );

    const sources: ChatSource[] = [];
    // Tracks (article § section) pairs already returned to the model so
    // repeated tool calls never surface the same section twice.
    const seenSections = new Set<string>();

    // Stage 2: Tool-augmented streaming generation
    const stream = streamText({
      model: google('gemini-2.5-flash'),
      system: buildRagSystemPrompt(searchHint),
      messages,
      stopWhen: stepCountIs(8),
      tools: {
        search_knowledge_base: tool({
          description:
            'Search the Wikipedia knowledge base for relevant AI/ML context. ' +
            'Call this whenever you need factual information to answer the user. ' +
            'Use a different, more specific query each time to avoid retrieving the same sections.',
          inputSchema: z.object({
            query: z
              .string()
              .describe(
                'Precise semantic search query. Use technical AI/ML vocabulary.',
              ),
          }),
          execute: async (input) => {
            console.log(`[Tool:search] query="${input.query}"`);
            const raw = await this.searchVectorDb(userId, input.query, 5);

            // Filter out sections already seen in earlier tool calls.
            const results = raw.filter((r) => {
              const key = `${r.title}§${r.section}`;
              if (seenSections.has(key)) return false;
              seenSections.add(key);
              return true;
            });

            if (!results.length) {
              return 'No new relevant sections found — all top matches were already retrieved. Try a different angle or stop searching.';
            }

            const offset = sources.length;
            sources.push(
              ...results.map((r) => ({
                title: r.title,
                url: r.url,
                content: r.content,
              })),
            );

            return results
              .map(
                (r, i) =>
                  `[${offset + i + 1}] ${r.title} › ${r.section} (relevance: ${r.score.toFixed(3)})\n${r.content}`,
              )
              .join('\n\n');
          },
        }),
      },
      onStepFinish: (step) => {
        console.log(
          `[Step] reason=${step.finishReason} ` +
            `toolCalls=${step.toolCalls?.length ?? 0} ` +
            `toolResults=${step.toolResults?.length ?? 0}`,
        );
      },
    });

    const generateStructuredCitations = async (
      answer: string,
    ): Promise<StructuredCitations> => {
      if (!sources.length) return { citations: [] };

      const numbered = sources
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title}\n${(s.content ?? '').slice(0, 600)}`,
        )
        .join('\n\n');

      try {
        const result = await generateObject({
          model: google('gemini-2.5-flash'),
          schema: CitationSchema,
          system:
            'Extract structured citations from the assistant answer. ' +
            'For each numbered footnote [N] the assistant used, produce a citation ' +
            'object with id=N, sourceTitle (from the provided sources), and a short ' +
            'verbatim excerpt (<=240 chars) from that source that supports the claim. ' +
            'Only include citations actually referenced in the answer.',
          prompt: `SOURCES:\n${numbered}\n\nASSISTANT ANSWER:\n${answer}`,
        });
        return result.object;
      } catch (err) {
        console.warn('[Citations] generateObject failed, falling back', err);
        return {
          citations: sources.map((s, i) => ({
            id: i + 1,
            sourceTitle: s.title,
            excerpt: (s.content ?? '').slice(0, 240),
          })),
        };
      }
    };

    return {
      textStream: stream.textStream,
      getSources: () => sources,
      generateStructuredCitations,
    };
  }
}
