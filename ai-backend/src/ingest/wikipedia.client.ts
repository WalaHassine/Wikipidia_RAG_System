import axios, { AxiosInstance } from "axios";

const DEFAULT_USER_AGENT = "ai-backend/1.0 (j.arige2002@gmail.com)";

// Sections that add noise to RAG retrieval — skipped by default.
const NOISE_SECTIONS = new Set([
  "references", "external links", "see also", "notes",
  "further reading", "bibliography", "sources", "citations",
  "footnotes", "works cited",
]);

// Maintenance-template names that signal article quality problems.
// Easy to extend — these map to the ambox warning banners on the article.
const MAINTENANCE_TEMPLATES = [
  "Template:Unreliable sources",
  "Template:Refimprove",
  "Template:More citations needed",
  "Template:Citation needed",
  "Template:Disputed",
  "Template:POV",
  "Template:Original research",
  "Template:Cleanup",
  "Template:Confusing",
  "Template:Update",
  "Template:Advert",
  "Template:Notability",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiSearchResult {
  title: string;
  pageId: number;
  snippet: string;
  wordcount: number;
}

export interface WikiChunk {
  content: string;
  metadata: {
    source: "wikipedia";
    title: string;
    pageId: number;
    revisionId: number;
    url: string;
    section: string;
    sectionPath: string[];
    lastModified: string;
    lang: string;
    /** Zero-based position of this chunk in the full document. */
    chunkIndex: number;
    /** Total chunks emitted for this page. */
    totalChunks: number;
    /** Zero-based position of this chunk within its section. */
    sectionChunkIndex: number;
    /** Total chunks produced for this section; >1 means the section was split. */
    sectionChunkCount: number;
  };
}

export interface Citation {
  raw: string;
  url?: string;
  title?: string;
  author?: string;
  publisher?: string;
  date?: string;
}

export interface FetchOptions {
  excludeNoiseSections?: boolean;
  leadOnly?: boolean;
  minSectionChars?: number;
  maxChunkChars?: number;
  chunkOverlap?: number;
}

export type AssessmentClass =
  | "FA" | "FL" | "A" | "GA" | "B" | "C" | "Start" | "Stub" | "List";

export interface ArticleMetadata {
  title: string;
  pageId: number;
  lengthBytes: number;
  lastEdit: string;
  daysSinceEdit: number;
  languageCount: number;
  isDisambiguation: boolean;
  assessment?: AssessmentClass;
  maintenanceWarnings: string[];  // template titles flagged on the page
  url: string;
}

export interface ScoringWeights {
  assessment: number;
  length: number;
  recency: number;
  views: number;
  languages: number;
  searchRank: number;
  lexicalRelevance: number;
}

export interface ArticleScore {
  title: string;
  pageId: number;
  total: number;       // 0..1
  quality: number;     // 0..1
  relevance: number;   // 0..1
  rejected?: string;   // if set, candidate excluded; reason is human-readable
  signals: {
    assessment?: AssessmentClass;
    lengthChars: number;
    daysSinceEdit: number;
    languageCount: number;
    pageviewsMonthly?: number;
    warnings: string[];
    isDisambiguation: boolean;
  };
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  assessment: 0.30,
  length: 0.15,
  recency: 0.10,
  views: 0.10,
  languages: 0.10,
  searchRank: 0.10,
  lexicalRelevance: 0.15,
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WikipediaClient {
  private http: AxiosInstance;
  private lang: string;
  private userAgent: string;

  constructor(opts: { lang?: string; userAgent?: string } = {}) {
    this.lang = opts.lang ?? "en";
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.http = axios.create({
      baseURL: `https://${this.lang}.wikipedia.org/w/api.php`,
      headers: {
        "User-Agent": this.userAgent,
        "Api-User-Agent": this.userAgent,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
      },
      timeout: 15_000,
    });
  }

  // ------------------ search + fetch ----------------------------------------

  async search(topic: string, limit = 10): Promise<WikiSearchResult[]> {
    const { data } = await this.http.get("", {
      params: {
        action: "query",
        list: "search",
        srsearch: topic,
        srlimit: limit,
        srprop: "snippet|wordcount",
        format: "json",
        formatversion: 2,
        origin: "*",
      },
    });
    return (data.query?.search ?? []).map((r: any) => ({
      title: r.title,
      pageId: r.pageid,
      snippet: stripHtml(r.snippet ?? ""),
      wordcount: r.wordcount ?? 0,
    }));
  }

  async fetchChunks(title: string, opts: FetchOptions = {}): Promise<WikiChunk[]> {
    const {
      excludeNoiseSections = true,
      leadOnly = false,
      minSectionChars = 50,
      maxChunkChars = 1500,
      chunkOverlap = 150,
    } = opts;

    const params: Record<string, any> = {
      action: "query",
      prop: "extracts|info|revisions|pageprops",
      titles: title,
      explaintext: 1,
      exsectionformat: "wiki",
      inprop: "url",
      rvprop: "ids|timestamp",
      redirects: 1,
      format: "json",
      formatversion: 2,
      origin: "*",
    };
    if (leadOnly) params.exintro = 1;

    const { data } = await this.http.get("", { params });
    const page = data.query?.pages?.[0];
    if (!page || page.missing) throw new Error(`Wikipedia page not found: ${title}`);
    if (page.pageprops?.disambiguation !== undefined) return [];

    const extract: string = page.extract ?? "";
    if (!extract.trim()) return [];

    const rev = page.revisions?.[0];
    const baseMeta = {
      source: "wikipedia" as const,
      title: page.title as string,
      pageId: page.pageid as number,
      revisionId: rev?.revid ?? 0,
      url: page.fullurl ?? this.canonicalUrl(page.title),
      lastModified: rev?.timestamp ?? "",
      lang: this.lang,
    };

    const sections = splitSections(extract);
    const chunks: WikiChunk[] = [];
    let chunkIndex = 0;
    for (const sec of sections) {
      if (excludeNoiseSections && NOISE_SECTIONS.has(sec.title.toLowerCase())) continue;
      if (sec.content.length < minSectionChars) continue;
      const pieces = chunkText(sec.content, maxChunkChars, chunkOverlap);
      for (let i = 0; i < pieces.length; i++) {
        chunks.push({
          content: pieces[i],
          metadata: {
            ...baseMeta,
            section: sec.title,
            sectionPath: sec.path,
            chunkIndex: chunkIndex++,
            totalChunks: 0, // back-stamped below once we know the final count
            sectionChunkIndex: i,
            sectionChunkCount: pieces.length,
          },
        });
      }
    }
    for (const c of chunks) c.metadata.totalChunks = chunks.length;
    return chunks;
  }

  async fetchCitations(title: string): Promise<Citation[]> {
    const { data } = await this.http.get("", {
      params: {
        action: "parse", page: title, prop: "wikitext",
        redirects: 1, format: "json", formatversion: 2, origin: "*",
      },
    });
    return extractRefs(data.parse?.wikitext ?? "");
  }

  // ------------------ triage + scoring --------------------------------------

  /**
   * Batched quality-signals fetch. One HTTP call pulls info / pageprops /
   * revisions / langlinks / pageassessments / flagged-maintenance-templates
   * for up to 50 titles. Auto-splits into batches of 50 beyond that.
   */
  async fetchMetadataBatch(titles: string[]): Promise<Map<string, ArticleMetadata>> {
    if (titles.length === 0) return new Map();
    if (titles.length > 50) {
      const batches: string[][] = [];
      for (let i = 0; i < titles.length; i += 50) batches.push(titles.slice(i, i + 50));
      const results = await Promise.all(batches.map(b => this.fetchMetadataBatch(b)));
      return new Map(results.flatMap(r => [...r]));
    }

    const { data } = await this.http.get("", {
      params: {
        action: "query",
        titles: titles.join("|"),
        prop: "info|pageprops|revisions|langlinks|pageassessments|templates",
        inprop: "url",
        rvprop: "timestamp",
        lllimit: 500,
        tllimit: 500,
        tltemplates: MAINTENANCE_TEMPLATES.join("|"),
        redirects: 1,
        format: "json",
        formatversion: 2,
        origin: "*",
      },
    });

    const now = Date.now();
    const out = new Map<string, ArticleMetadata>();

    for (const page of data.query?.pages ?? []) {
      if (page.missing) continue;

      const lastEdit: string = page.revisions?.[0]?.timestamp ?? "";
      const daysSinceEdit = lastEdit
        ? (now - new Date(lastEdit).getTime()) / (1000 * 60 * 60 * 24)
        : Number.POSITIVE_INFINITY;

      out.set(page.title, {
        title: page.title,
        pageId: page.pageid,
        lengthBytes: page.length ?? 0,
        lastEdit,
        daysSinceEdit,
        languageCount: page.langlinks?.length ?? 0,
        isDisambiguation: page.pageprops?.disambiguation !== undefined,
        assessment: pickHighestAssessment(page.pageassessments),
        maintenanceWarnings: (page.templates ?? []).map((t: any) => t.title),
        url: page.fullurl ?? this.canonicalUrl(page.title),
      });
    }
    return out;
  }

  /** Monthly average pageviews via the Wikimedia Analytics REST API. Free, unauthenticated. */
  async fetchPageviews(title: string, months = 3): Promise<number> {
    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - months);
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const encoded = encodeURIComponent(title.replace(/ /g, "_"));
    const url =
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
      `${this.lang}.wikipedia/all-access/all-agents/` +
      `${encoded}/monthly/${fmt(start)}/${fmt(end)}`;
    try {
      const { data } = await axios.get(url, {
        headers: { "User-Agent": this.userAgent },
        timeout: 10_000,
      });
      const items: { views: number }[] = data.items ?? [];
      if (items.length === 0) return 0;
      return Math.round(items.reduce((s, i) => s + i.views, 0) / items.length);
    } catch {
      return 0; // swallow — pageviews is optional
    }
  }

  /**
   * Search, pull triage metadata for every hit, and return candidates sorted
   * by combined quality × relevance score. Does NOT fetch full article text.
   */
  async searchAndRank(
    query: string,
    opts: {
      limit?: number;
      weights?: Partial<ScoringWeights>;
      includePageviews?: boolean;
      minScore?: number;
    } = {},
  ): Promise<ArticleScore[]> {
    const { limit = 10, includePageviews = false, minScore = 0 } = opts;
    const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };

    const searchResults = await this.search(query, limit);
    if (searchResults.length === 0) return [];

    const titles = searchResults.map(r => r.title);
    const metaMap = await this.fetchMetadataBatch(titles);

    let pageviewsMap: Map<string, number> | undefined;
    if (includePageviews) {
      const pairs = await Promise.all(
        titles.map(async t => [t, await this.fetchPageviews(t)] as const),
      );
      pageviewsMap = new Map(pairs);
    }

    return searchResults
      .map((result, idx) => {
        const meta = metaMap.get(result.title);
        if (!meta) return null;
        return scoreCandidate(
          query, result, meta, idx,
          pageviewsMap?.get(result.title),
          weights,
        );
      })
      .filter((s): s is ArticleScore => s !== null)
      .filter(s => !s.rejected && s.total >= minScore)
      .sort((a, b) => b.total - a.total);
  }

  /**
   * Full pipeline: search → rank → fetch top-K best candidates as chunks.
   * Returns both the RAG-ready chunks and the full ranking (including
   * rejected candidates) so you can log / debug / expose provenance.
   */
  async fetchBest(
    query: string,
    opts: {
      topK?: number;
      searchLimit?: number;
      weights?: Partial<ScoringWeights>;
      includePageviews?: boolean;
      minScore?: number;
      fetchOptions?: FetchOptions;
    } = {},
  ): Promise<{ chunks: WikiChunk[]; ranking: ArticleScore[] }> {
    const { topK = 3, searchLimit = 10, fetchOptions } = opts;

    const ranking = await this.searchAndRank(query, {
      limit: searchLimit,
      weights: opts.weights,
      includePageviews: opts.includePageviews,
      minScore: opts.minScore,
    });

    const winners = ranking.slice(0, topK);
    const chunkArrays = await Promise.all(
      winners.map(w =>
        this.fetchChunks(w.title, fetchOptions).catch(() => [] as WikiChunk[]),
      ),
    );

    return { chunks: chunkArrays.flat(), ranking };
  }

  // --------------------------------------------------------------------------

  private canonicalUrl(title: string): string {
    return `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const ASSESSMENT_VALUES: Record<string, number> = {
  FA: 1.0, FL: 1.0,
  A: 0.85,
  GA: 0.8,
  B: 0.6,
  C: 0.4,
  List: 0.4,
  Start: 0.2,
  Stub: 0.05,
};

function pickHighestAssessment(pageassessments: unknown): AssessmentClass | undefined {
  if (!pageassessments || typeof pageassessments !== "object") return undefined;
  let best: { cls: string; val: number } | null = null;
  for (const p of Object.values(pageassessments) as Array<{ class?: string }>) {
    const cls = p?.class;
    if (!cls || !(cls in ASSESSMENT_VALUES)) continue;
    const val = ASSESSMENT_VALUES[cls];
    if (!best || val > best.val) best = { cls, val };
  }
  return (best?.cls as AssessmentClass) ?? undefined;
}

export function scoreCandidate(
  query: string,
  result: WikiSearchResult,
  meta: ArticleMetadata,
  searchRank: number,
  pageviewsMonthly: number | undefined,
  weights: ScoringWeights,
): ArticleScore {
  const signals: ArticleScore["signals"] = {
    assessment: meta.assessment,
    lengthChars: meta.lengthBytes,
    daysSinceEdit: Math.round(Number.isFinite(meta.daysSinceEdit) ? meta.daysSinceEdit : 9999),
    languageCount: meta.languageCount,
    pageviewsMonthly,
    warnings: meta.maintenanceWarnings,
    isDisambiguation: meta.isDisambiguation,
  };

  // Hard rejects — don't waste embedding cycles on these.
  if (meta.isDisambiguation) return reject(meta, signals, "Disambiguation page");
  if (meta.assessment === "Stub" || meta.lengthBytes < 1500) {
    return reject(meta, signals, `Stub-class or too short (${meta.lengthBytes} bytes)`);
  }
  // Unreliable-sources banner is kept as a soft signal; flip to hard-reject if your
  // domain demands it (e.g. medical, legal, financial content):
  // if (meta.maintenanceWarnings.some(w => /Unreliable sources/i.test(w))) {
  //   return reject(meta, signals, "Flagged: unreliable sources");
  // }

  // Quality components, each normalized to [0, 1].
  const assessment = meta.assessment ? ASSESSMENT_VALUES[meta.assessment] : 0.4;
  const length = clamp(Math.log10(Math.max(meta.lengthBytes, 1) / 500) / 2, 0, 1);
  const recency = clamp(1 - meta.daysSinceEdit / 730, 0.2, 1);
  const languages = clamp(meta.languageCount / 50, 0, 1);
  const views = pageviewsMonthly !== undefined
    ? clamp(Math.log10(Math.max(pageviewsMonthly, 1)) / 6, 0, 1)
    : 0.5;
  const warningsPenalty = Math.max(0.4, 1 - 0.15 * meta.maintenanceWarnings.length);

  const qualityNum =
    assessment * weights.assessment +
    length * weights.length +
    recency * weights.recency +
    views * weights.views +
    languages * weights.languages;
  const qualityDen =
    weights.assessment + weights.length + weights.recency + weights.views + weights.languages;
  const quality = (qualityNum / qualityDen) * warningsPenalty;

  // Relevance to query.
  const lexical = lexicalOverlap(query, meta.title, result.snippet);
  const rankScore = 1 / (1 + searchRank * 0.3);
  const relNum = rankScore * weights.searchRank + lexical * weights.lexicalRelevance;
  const relDen = weights.searchRank + weights.lexicalRelevance;
  const relevance = relNum / relDen;

  return {
    title: meta.title,
    pageId: meta.pageId,
    total: quality * relevance,
    quality,
    relevance,
    signals,
  };
}

function reject(
  meta: ArticleMetadata,
  signals: ArticleScore["signals"],
  reason: string,
): ArticleScore {
  return {
    title: meta.title,
    pageId: meta.pageId,
    total: 0, quality: 0, relevance: 0,
    signals,
    rejected: reason,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

interface Section { title: string; level: number; path: string[]; content: string; }

function splitSections(text: string): Section[] {
  const HEADING_RE = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  const sections: Section[] = [];
  const pathStack: { title: string; level: number }[] = [];
  let lastIndex = 0;
  let currentTitle = "Introduction";
  let currentLevel = 2;
  let currentPath: string[] = ["Introduction"];

  const flush = (end: number) => {
    const content = text.slice(lastIndex, end).trim();
    if (content) sections.push({ title: currentTitle, level: currentLevel, path: [...currentPath], content });
  };

  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(text)) !== null) {
    flush(m.index);
    const level = m[1].length;
    const heading = m[2].trim();
    while (pathStack.length && pathStack[pathStack.length - 1].level >= level) pathStack.pop();
    pathStack.push({ title: heading, level });
    currentPath = pathStack.map(p => p.title);
    currentTitle = heading;
    currentLevel = level;
    lastIndex = HEADING_RE.lastIndex;
  }
  flush(text.length);
  return sections;
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]+(?:\s|$)|[^.!?\n]+$/g) ?? [text];
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > maxChars && buf.length > 0) {
      chunks.push(buf.trim());
      buf = overlap > 0 ? buf.slice(-overlap) + s : s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function extractRefs(wikitext: string): Citation[] {
  const REF_RE = /<ref\b[^>]*>([\s\S]*?)<\/ref>/gi;
  const URL_RE = /https?:\/\/[^\s|\]}<>]+/;
  const field = (body: string, key: RegExp) => body.match(key)?.[1]?.trim();
  const seen = new Set<string>();
  const out: Citation[] = [];
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(wikitext)) !== null) {
    const body = m[1];
    const url = body.match(URL_RE)?.[0];
    const key = url ?? body.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      raw: body.trim(),
      url,
      title: field(body, /\btitle\s*=\s*([^|}\n]+)/i),
      author: field(body, /\b(?:author|last1?)\s*=\s*([^|}\n]+)/i),
      publisher: field(body, /\b(?:publisher|work|website|newspaper)\s*=\s*([^|}\n]+)/i),
      date: field(body, /\b(?:date|year)\s*=\s*([^|}\n]+)/i),
    });
  }
  return out;
}

const STOP = new Set([
  "a","an","the","of","in","on","for","to","and","or","is","are","with",
  "by","from","as","at","be","this","that","it","its","was","were","been","being",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));
}

function lexicalOverlap(query: string, title: string, snippet: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const t = new Set(tokenize(title));
  const s = new Set(tokenize(snippet));
  const titleHits = q.filter(w => t.has(w)).length / q.length;
  const snippetHits = q.filter(w => s.has(w)).length / q.length;
  return 0.6 * titleHits + 0.4 * snippetHits;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}