/**
 * Resilient Gemini calls for post-call work (transcription, grading, fact lookup).
 *
 * Failures seen on this key (free tier):
 * - 429 RESOURCE_EXHAUSTED: a per-model daily quota is used up (gemini-3-flash-preview allows
 *   only 20 requests/day). The error says when to retry ("retryDelay": "55349s"); the model is
 *   skipped until then instead of being tried — and failing — first on every call.
 * - 503 "high demand": temporary; the model is skipped for a short while and the next one tried.
 * - Timeouts / "fetch failed": the next model is tried.
 *
 * Calls also share a small concurrency limit so a burst of post-call work (one transcription per
 * question + one grading per question) does not trip per-minute limits and 503s all at once.
 */
import type { GoogleGenAI } from '@google/genai';

// Order matters: first available model wins. Lite models are a last resort (lower quality, but
// a transcript/grade is better than none).
export const TEXT_MODELS = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
];

const OVERLOAD_COOLDOWN_MS = 20_000;
const MIN_QUOTA_COOLDOWN_MS = 60_000;
const MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
const MAX_CONCURRENT = 3;

/** model -> time (ms) until which it is not tried, unless every model is cooling down. */
const unavailableUntil = new Map<string, number>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function errorText(err: any): string {
  return String(err?.message || err);
}

function shortError(err: any): string {
  return errorText(err).replace(/\s+/g, ' ').slice(0, 160);
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return `${Math.round(ms / 1000)} s`;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** How long Google asks us to wait, from `"retryDelay": "55349s"` or "Please retry in 15h22m29s". */
function retryDelayMs(text: string): number | null {
  const field = text.match(/retryDelay\\?"\s*:\s*\\?"(\d+(?:\.\d+)?)s/);
  if (field) return Number(field[1]) * 1000;
  const prose = text.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?/i);
  if (prose && (prose[1] || prose[2] || prose[3])) {
    return ((Number(prose[1] || 0) * 60 + Number(prose[2] || 0)) * 60 + Number(prose[3] || 0)) * 1000;
  }
  return null;
}

function noteFailure(model: string, err: any): void {
  const text = errorText(err);
  if (/\b429\b|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(text)) {
    const perDay = /PerDay|per day/i.test(text);
    const wait = Math.min(
      MAX_QUOTA_COOLDOWN_MS,
      Math.max(MIN_QUOTA_COOLDOWN_MS, retryDelayMs(text) ?? (perDay ? 60 * 60_000 : MIN_QUOTA_COOLDOWN_MS))
    );
    unavailableUntil.set(model, Date.now() + wait);
    console.warn(
      `[Gemini] ${model}: ${perDay ? 'daily quota' : 'quota'} used up — skipping it for ${formatDuration(wait)}.`
    );
  } else if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(text)) {
    unavailableUntil.set(model, Math.max(unavailableUntil.get(model) || 0, Date.now() + OVERLOAD_COOLDOWN_MS));
  }
}

/** Models not cooling down, in order; if all are, the ones that become free soonest. */
function usableModels(models: string[]): string[] {
  const now = Date.now();
  const ready = models.filter((m) => (unavailableUntil.get(m) || 0) <= now);
  if (ready.length) return ready;
  // Everything is cooling down: overloaded models (short cooldown) are still worth a try;
  // quota-exhausted ones (long cooldown) are not.
  return models.filter((m) => (unavailableUntil.get(m) || 0) - now <= OVERLOAD_COOLDOWN_MS);
}

// Simple FIFO semaphore.
let active = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export async function generateWithFallback(
  ai: GoogleGenAI,
  request: { contents: any; config?: any },
  opts: {
    timeoutMs?: number;
    models?: string[];
    passes?: number;
    label?: string;
    /** Give up after this long in total (for live lookups where the candidate is waiting). */
    deadlineMs?: number;
    /** Skip the shared concurrency queue (live, latency-sensitive calls). */
    urgent?: boolean;
  } = {}
): Promise<{ text: string; model: string; raw: any }> {
  const models = opts.models || TEXT_MODELS;
  const passes = opts.passes ?? 3;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity;
  let lastErr: any;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) {
      const pause = 3000 * pass + Math.random() * 1500;
      if (Date.now() + pause >= deadline) break;
      await new Promise((r) => setTimeout(r, pause));
    }
    const candidates = usableModels(models);
    if (!candidates.length) {
      lastErr = lastErr || new Error(`No Gemini model available (quota used up on: ${models.join(', ')})`);
      continue;
    }
    for (const model of candidates) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) break;
      if (!opts.urgent) await acquire();
      try {
        const resp: any = await withTimeout(
          ai.models.generateContent({ model, ...request }),
          Math.min(timeoutMs, remaining)
        );
        return { text: String(resp.text || ''), model, raw: resp };
      } catch (err: any) {
        lastErr = err;
        noteFailure(model, err);
        console.warn(`[Gemini] ${opts.label || 'request'} on ${model} failed: ${shortError(err)}`);
      } finally {
        if (!opts.urgent) release();
      }
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}
