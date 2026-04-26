import * as fs from 'fs';
import * as path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

function loadPrompt(filename: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8').trim();
}

/**
 * System prompt for the query-intent generateObject call.
 * Loaded from prompts/query-analysis.md at module load.
 */
export const QUERY_ANALYSIS_SYSTEM = loadPrompt('query-analysis.md');

const RAG_SYSTEM_TEMPLATE = loadPrompt('rag-system.md');

/**
 * Build the RAG system prompt by injecting the routing hint into the template.
 */
export function buildRagSystemPrompt(searchHint: string): string {
  return RAG_SYSTEM_TEMPLATE.replace('{{SEARCH_HINT}}', searchHint);
}

/**
 * Produces the routing hint injected into the RAG system prompt.
 */
export function buildSearchHint(needsSearch: boolean, optimizedQuery: string): string {
  return needsSearch
    ? `ROUTING HINT: Pre-analysis determined a search is needed. Suggested query: "${optimizedQuery}"`
    : `ROUTING HINT: Pre-analysis determined no knowledge base search is needed for this message.`;
}
