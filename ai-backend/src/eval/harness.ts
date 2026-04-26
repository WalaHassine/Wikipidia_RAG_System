/**
 * RAG Evaluation Harness — v2
 *
 * Run with:  pnpm evaluate        (repo root)
 *            pnpm run evaluate    (ai-backend/)
 *
 * Two-phase evaluation:
 *
 *  Phase 1 — Behavioural metrics (deterministic)
 *    tool_called        — search_knowledge_base invoked as expected?
 *    sources_retrieved  — sections returned per response
 *    has_citations      — [N] footnotes present in answer?
 *    keyword_hit_rate   — fraction of expected domain keywords found
 *
 *  Phase 2 — LLM-as-judge (Gemini 2.5 Flash, 1–5 per dimension)
 *    groundedness       — answer relies on retrieved sources; no hallucination
 *    accuracy           — factual correctness (judge's own knowledge)
 *    relevance          — directly addresses the question
 *    tool_discipline    — right number of calls, diverse queries, stopped early
 *    citation_quality   — citations present, correctly placed and numbered
 *
 * Results are written to ai-backend/eval-results.json.
 * Exit code 0 = all cases pass behavioural checks, 1 = any failure.
 */

import { config } from 'dotenv';
config({ path: 'env' });

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { EmbeddingService } from 'src/embedding/embedding.service';
import { RagAgent } from 'src/ai/rag.agent';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalCase {
  label: string;
  question: string;
  expectToolCall: boolean;
  expectedKeywords: string[];
  minKeywordHitRate: number;
  category?: string;
  conversation?: { role: 'user' | 'assistant'; content: string }[];
}

interface JudgeScore {
  groundedness: number;
  accuracy: number;
  relevance: number;
  toolDiscipline: number;
  citationQuality: number;
  overall: number;
  reasoning: string;
}

interface EvalResult {
  label: string;
  category: string;
  question: string;
  answer: string;
  toolCalled: boolean;
  sourcesRetrieved: number;
  hasCitations: boolean;
  keywordHitRate: number;
  keywordHits: string[];
  keywordMisses: string[];
  pass: boolean;
  judge?: JudgeScore;
  judgeError?: string;
}

// ---------------------------------------------------------------------------
// Test dataset
// ---------------------------------------------------------------------------

const TEST_CASES: EvalCase[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'),
);

// ---------------------------------------------------------------------------
// Behavioural scoring
// ---------------------------------------------------------------------------

function behaviourPass(
  tc: EvalCase,
  r: Pick<EvalResult, 'toolCalled' | 'hasCitations' | 'keywordHitRate'>,
): boolean {
  if (tc.expectToolCall !== r.toolCalled) return false;
  if (tc.expectToolCall && !r.hasCitations) return false;
  if (r.keywordHitRate < tc.minKeywordHitRate) return false;
  return true;
}

// ---------------------------------------------------------------------------
// LLM-as-judge
// ---------------------------------------------------------------------------

const judgeSchema = z.object({
  groundedness: z.number().min(1).max(5).describe(
    'Answer relies on retrieved sources; no fabrication. ' +
    '5 = fully grounded in sources, 1 = mostly hallucinated.',
  ),
  accuracy: z.number().min(1).max(5).describe(
    'Factual correctness based on your own knowledge. ' +
    '5 = fully accurate, 1 = clearly wrong on verifiable facts.',
  ),
  relevance: z.number().min(1).max(5).describe(
    'Directly and completely addresses the question. ' +
    '5 = perfectly on-point, 1 = off-topic or ignores key parts.',
  ),
  toolDiscipline: z.number().min(1).max(5).describe(
    'Tool use was appropriate: correct number of calls, each query distinct, ' +
    'stopped when enough information was gathered. ' +
    'For conversational cases where no search was expected, score 5 if no tool was called. ' +
    '5 = ideal, 1 = excessive calls, absent when needed, or repeated identical queries.',
  ),
  citationQuality: z.number().min(1).max(5).describe(
    'Citations are present, correctly numbered, and anchored to specific claims. ' +
    'For conversational cases, score 5 if citations are absent (none needed). ' +
    '5 = excellent, 1 = absent when expected or completely wrong placement.',
  ),
  reasoning: z.string().describe(
    'One sentence naming the main strength and one weakness of this response.',
  ),
});

async function judgeResponse(tc: EvalCase, r: EvalResult): Promise<JudgeScore> {
  const toolNote = r.toolCalled
    ? `The agent called search_knowledge_base and retrieved ${r.sourcesRetrieved} section(s).`
    : 'The agent did NOT call search_knowledge_base.';
  const expected = tc.expectToolCall
    ? 'A search call WAS expected for this factual question.'
    : 'No search was expected — this is a conversational message.';

  const lines = [
    `CATEGORY: ${tc.category ?? 'unknown'}`,
    `QUESTION: ${tc.question}`,
    tc.conversation?.length
      ? `PRIOR CONVERSATION:\n${tc.conversation.map(m => `  ${m.role}: ${m.content}`).join('\n')}`
      : null,
    `ANSWER:\n${r.answer.slice(0, 2500)}`,
    '',
    `TOOL USE: ${toolNote} ${expected}`,
    `CITATIONS PRESENT: ${r.hasCitations ? 'yes' : 'no'}.`,
    `KEYWORD HIT RATE: ${pct(r.keywordHitRate)} (keywords: ${tc.expectedKeywords.join(', ') || 'none required'}).`,
    r.keywordMisses.length ? `MISSED KEYWORDS: ${r.keywordMisses.join(', ')}.` : null,
  ].filter(Boolean).join('\n');

  const result = await generateObject({
    model: google('gemini-2.5-flash'),
    system:
      'You are an impartial evaluator of RAG chatbot responses. ' +
      'Score the response on the five given dimensions, each 1–5 (integers). ' +
      'Be strict: 5 means near-perfect with no noticeable flaw; 3 means acceptable but with clear issues. ' +
      'Do not give 5 across the board — identify the weakest dimension and score it honestly.',
    prompt: lines,
    schema: judgeSchema,
  });

  const s = result.object;
  const overall =
    (s.groundedness + s.accuracy + s.relevance + s.toolDiscipline + s.citationQuality) / 5;
  return { ...s, overall: Math.round(overall * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const USER_ID = 'cli-system';
const RESULTS_PATH = path.join(__dirname, '../../eval-results.json');

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'ai_backend',
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
  });

  // Sanity check — abort early if the corpus is missing
  const countRes = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM chunks WHERE user_id = $1',
    [USER_ID],
  );
  const chunkCount = parseInt(countRes.rows[0].count, 10);
  if (chunkCount === 0) {
    console.error(`\n[Error] No chunks found for userId="${USER_ID}". Run: pnpm ingest\n`);
    await pool.end();
    process.exit(1);
  }
  console.log(`\nCorpus: ${chunkCount} chunks for userId="${USER_ID}"`);

  const embedder = new EmbeddingService();
  await embedder.init();

  const agent = new RagAgent(pool, embedder);
  const results: EvalResult[] = [];

  // ── Phase 1: Behavioural metrics ──────────────────────────────────────────

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Phase 1 — Behavioural metrics  (${TEST_CASES.length} cases)`);
  console.log('─'.repeat(64));

  for (const tc of TEST_CASES) {
    process.stdout.write(`  ${tc.label.padEnd(48)}`);

    try {
      const messages = [
        ...(tc.conversation ?? []),
        { role: 'user' as const, content: tc.question },
      ];
      const { textStream, getSources } = await agent.chat(USER_ID, messages);

      let answer = '';
      for await (const chunk of textStream) answer += chunk;

      const sources = getSources();
      const toolCalled = sources.length > 0;
      const hasCitations = /\[\d+\]/.test(answer);
      const kwHits = tc.expectedKeywords.filter(k =>
        answer.toLowerCase().includes(k.toLowerCase()),
      );
      const kwMisses = tc.expectedKeywords.filter(k =>
        !answer.toLowerCase().includes(k.toLowerCase()),
      );
      const keywordHitRate =
        tc.expectedKeywords.length > 0 ? kwHits.length / tc.expectedKeywords.length : 1;

      const partial = {
        toolCalled,
        sourcesRetrieved: sources.length,
        hasCitations,
        keywordHitRate,
        keywordHits: kwHits,
        keywordMisses: kwMisses,
        answer,
      };
      const pass = behaviourPass(tc, partial);
      results.push({
        label: tc.label,
        category: tc.category ?? 'uncategorised',
        question: tc.question,
        pass,
        ...partial,
      });
      console.log(pass ? '✓' : '✗ FAIL');
    } catch (err) {
      console.log('✗ ERROR');
      results.push({
        label: tc.label,
        category: tc.category ?? 'uncategorised',
        question: tc.question,
        toolCalled: false,
        sourcesRetrieved: 0,
        hasCitations: false,
        keywordHitRate: 0,
        keywordHits: [],
        keywordMisses: tc.expectedKeywords,
        pass: false,
        answer: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── Phase 2: LLM-as-judge ─────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(64)}`);
  console.log('Phase 2 — LLM-as-judge  (Gemini 2.5 Flash)');
  console.log('─'.repeat(64));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const tc = TEST_CASES[i];
    process.stdout.write(`  ${r.label.padEnd(48)}`);
    try {
      r.judge = await judgeResponse(tc, r);
      console.log(`overall ${r.judge.overall.toFixed(1)}/5`);
    } catch (err) {
      r.judgeError = err instanceof Error ? err.message : String(err);
      console.log('judge failed');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.pass).length;
  const toolCallRate = results.filter(r => r.toolCalled).length / results.length;
  const citationRate = results.filter(r => r.hasCitations).length / results.length;
  const avgKeywords = results.reduce((s, r) => s + r.keywordHitRate, 0) / results.length;
  const judged = results.filter(r => r.judge);
  const avgJudge = judged.length
    ? judged.reduce((s, r) => s + r.judge!.overall, 0) / judged.length
    : 0;

  const dim = (key: keyof Omit<JudgeScore, 'overall' | 'reasoning'>) =>
    judged.length
      ? judged.reduce((s, r) => s + (r.judge![key] as number), 0) / judged.length
      : 0;

  console.log(`\n${'═'.repeat(64)}`);
  console.log('SUMMARY');
  console.log('─'.repeat(64));
  console.log(`  Behavioural pass rate:    ${passed}/${results.length}  (${pct(passed / results.length)})`);
  console.log(`  Tool call accuracy:       ${pct(toolCallRate)}`);
  console.log(`  Citation rate:            ${pct(citationRate)}`);
  console.log(`  Avg keyword hit rate:     ${pct(avgKeywords)}`);
  if (judged.length) {
    console.log(`  Avg LLM judge score:      ${avgJudge.toFixed(2)} / 5.0`);
    console.log(`    ├─ Groundedness:        ${dim('groundedness').toFixed(2)}`);
    console.log(`    ├─ Accuracy:            ${dim('accuracy').toFixed(2)}`);
    console.log(`    ├─ Relevance:           ${dim('relevance').toFixed(2)}`);
    console.log(`    ├─ Tool discipline:     ${dim('toolDiscipline').toFixed(2)}`);
    console.log(`    └─ Citation quality:    ${dim('citationQuality').toFixed(2)}`);
  }

  console.log(`\n${'─'.repeat(64)}`);
  for (const r of results) {
    const status = r.pass ? '✓' : '✗';
    const j = r.judge;
    const judgeStr = j
      ? `  judge=${j.overall.toFixed(1)} [G${j.groundedness} A${j.accuracy} R${j.relevance} T${j.toolDiscipline} C${j.citationQuality}]`
      : '';
    console.log(`  ${status}  ${r.label}`);
    console.log(`     kw=${pct(r.keywordHitRate)}  src=${r.sourcesRetrieved}  cite=${r.hasCitations}${judgeStr}`);
    if (j?.reasoning) console.log(`     "${j.reasoning}"`);
    if (r.keywordMisses.length) console.log(`     missing: ${r.keywordMisses.join(', ')}`);
  }
  console.log(`${'═'.repeat(64)}`);

  // ── Write JSON results ────────────────────────────────────────────────────

  const output = {
    runAt: new Date().toISOString(),
    modelId: 'gemini-2.5-flash',
    embeddingModel: 'all-MiniLM-L6-v2',
    corpusChunks: chunkCount,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: round3(passed / results.length),
      toolCallRate: round3(toolCallRate),
      citationRate: round3(citationRate),
      avgKeywordHitRate: round3(avgKeywords),
      avgJudgeScore: judged.length ? Math.round(avgJudge * 100) / 100 : null,
      judgeByDimension: judged.length
        ? {
            groundedness: Math.round(dim('groundedness') * 100) / 100,
            accuracy: Math.round(dim('accuracy') * 100) / 100,
            relevance: Math.round(dim('relevance') * 100) / 100,
            toolDiscipline: Math.round(dim('toolDiscipline') * 100) / 100,
            citationQuality: Math.round(dim('citationQuality') * 100) / 100,
          }
        : null,
    },
    cases: results.map(r => {
      const tc = TEST_CASES.find(t => t.label === r.label)!;
      return {
        label: r.label,
        category: r.category,
        question: r.question,
        expectToolCall: tc.expectToolCall,
        pass: r.pass,
        behavioural: {
          toolCalled: r.toolCalled,
          sourcesRetrieved: r.sourcesRetrieved,
          hasCitations: r.hasCitations,
          keywordHitRate: round3(r.keywordHitRate),
          keywordHits: r.keywordHits,
          keywordMisses: r.keywordMisses,
        },
        judge: r.judge ?? null,
        judgeError: r.judgeError ?? null,
        answerPreview: r.answer.slice(0, 400).replace(/\n+/g, ' '),
      };
    }),
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written → ${RESULTS_PATH}\n`);

  await pool.end();
  process.exit(passed === results.length ? 0 : 1);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

run().catch(err => {
  console.error('\nFatal eval error:', err);
  process.exit(1);
});
