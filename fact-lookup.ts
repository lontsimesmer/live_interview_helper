/**
 * Up-to-date answers for Sarah's open Q&A at the end of the interview ("who won the
 * Ballon d'Or this year?", "who is the president of the United States?").
 *
 * 1. Gemini with Google Search grounding (best, but needs search quota on the API key —
 *    the current key returns 429 for it).
 * 2. Wikipedia (free, no key): search, read the top article intros, and let Gemini answer
 *    strictly from that text.
 * 3. Otherwise "UNKNOWN" — Sarah then says she isn't sure instead of guessing.
 */
import type { GoogleGenAI } from '@google/genai';
import { generateWithFallback } from './gemini-call';

// Wikipedia asks API clients to identify themselves with a User-Agent.
const WIKI_HEADERS = { 'User-Agent': 'InterviewAssistant/1.0 (server-side fact lookup)' };
const UNKNOWN = 'UNKNOWN';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

function todayText(): string {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Search grounding is not in this key's quota (429); after a refusal, skip it for an hour so
// the candidate isn't kept waiting on every question.
let searchUnavailableUntil = 0;

async function viaGoogleSearch(ai: GoogleGenAI, question: string): Promise<string | null> {
  // Off unless the key has search-grounding quota (set GEMINI_SEARCH_GROUNDING=1 after enabling billing).
  if (process.env.GEMINI_SEARCH_GROUNDING !== '1') return null;
  if (Date.now() < searchUnavailableUntil) return null;
  try {
    const resp = await generateWithFallback(
      ai,
      {
        contents: `Today is ${todayText()}. Answer this question in one short spoken sentence, using up-to-date information: ${question}`,
        config: { tools: [{ googleSearch: {} }], temperature: 0 },
      },
      { models: ['gemini-3.5-flash'], passes: 1, timeoutMs: 8000, urgent: true, label: 'fact lookup (search)' }
    );
    return resp.text.trim() || null;
  } catch (err: any) {
    if (/429|quota|RESOURCE_EXHAUSTED/i.test(String(err?.message || err))) {
      searchUnavailableUntil = Date.now() + 60 * 60_000;
    }
    throw err;
  }
}

/** Wikipedia article titles most likely to contain the answer (asked to the model first). */
async function likelyArticleTitles(ai: GoogleGenAI, question: string): Promise<string[]> {
  try {
    const resp = await generateWithFallback(
      ai,
      {
        contents: `Today is ${todayText()}. List up to 3 exact English Wikipedia article titles most likely to state the answer to this question (for example "President of the United States", "2026 Ballon d'Or", "2026 FIFA World Cup"). Reply with a JSON array of strings only.\n\nQuestion: ${question}`,
        config: { temperature: 0, responseMimeType: 'application/json' },
      },
      { passes: 1, timeoutMs: 6000, deadlineMs: 8000, urgent: true, label: 'fact lookup (titles)' }
    );
    const parsed = JSON.parse(resp.text || '[]');
    return Array.isArray(parsed) ? parsed.map((t) => String(t).trim()).filter(Boolean).slice(0, 3) : [];
  } catch {
    return [];
  }
}

async function keywordSearchTitles(question: string): Promise<string[]> {
  const search = await withTimeout(
    fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=2&srsearch=${encodeURIComponent(
        question
      )}`,
      { headers: WIKI_HEADERS }
    ),
    5000
  );
  if (!search.ok) return [];
  const found: any = await search.json();
  return (found?.query?.search || []).map((r: any) => String(r.title));
}

async function wikipediaContext(ai: GoogleGenAI, question: string): Promise<string> {
  const [suggested, searched] = await Promise.all([
    likelyArticleTitles(ai, question),
    keywordSearchTitles(question).catch(() => [] as string[]),
  ]);
  const titles = Array.from(new Set([...suggested, ...searched])).slice(0, 5);
  if (!titles.length) return '';
  const extracts = await withTimeout(
    fetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(
        titles.join('|')
      )}`,
      { headers: WIKI_HEADERS }
    ),
    5000
  );
  if (!extracts.ok) return '';
  const data: any = await extracts.json();
  // Map redirected titles back so the most relevant article comes first.
  const redirects = new Map<string, string>(
    (data?.query?.redirects || []).map((r: any) => [String(r.to), String(r.from)])
  );
  const rank = (title: string) => {
    const i = titles.indexOf(redirects.get(title) || title);
    return i < 0 ? titles.length : i;
  };
  const pages = (Object.values(data?.query?.pages || {}) as any[]).filter((p) => p.extract);
  pages.sort((a, b) => rank(a.title) - rank(b.title));
  // The most relevant article gets room for its whole intro (the current office holder or
  // winner is often in the intro's last sentence); shorter extracts for the others.
  return pages
    .map((p, i) => `## ${p.title}\n${String(p.extract).slice(0, i === 0 ? 8000 : 3000)}`)
    .join('\n\n');
}

async function viaWikipedia(ai: GoogleGenAI, question: string): Promise<string | null> {
  const context = await wikipediaContext(ai, question);
  if (!context) return null;
  const resp = await generateWithFallback(
    ai,
    {
      contents: `Today is ${todayText()}. Using ONLY the Wikipedia extracts below, answer the question in one short spoken sentence. If the extracts do not clearly contain the answer, reply exactly ${UNKNOWN}.

Question: ${question}

${context}`,
      config: { temperature: 0 },
    },
    { passes: 1, timeoutMs: 10000, deadlineMs: 14000, urgent: true, label: 'fact lookup (wikipedia)' }
  );
  const text = resp.text.trim();
  return text && !text.toUpperCase().startsWith(UNKNOWN) ? text : null;
}

export async function lookUpFact(ai: GoogleGenAI | null, question: string): Promise<string> {
  const q = String(question || '').trim().slice(0, 300);
  if (!q || !ai) return UNKNOWN;
  for (const source of [viaGoogleSearch, viaWikipedia]) {
    try {
      const answer = await source(ai, q);
      if (answer) return answer;
    } catch (err: any) {
      console.warn(`Fact lookup (${source.name}) failed:`, String(err?.message || err).slice(0, 160));
    }
  }
  return UNKNOWN;
}
