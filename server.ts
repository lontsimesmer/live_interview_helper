import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Type,
  Modality,
  FunctionDeclaration,
} from '@google/genai';
import dotenv from 'dotenv';
import {
  ANSWER_STARTED_WORDS,
  LIVE_MODELS,
  LIVE_NOTES,
  TURN_END_SILENCE_MS,
  buildInterviewerPrompt,
  buildLiveVoiceConfig,
  interviewerTextAsksQuestion,
  recentSpeechAsksQuestion,
  buildTranscriptionVocabulary,
  flagOffTopicAnswerDeclaration,
  lookUpFactDeclaration,
} from './interviewer-agent.js';
import { candidateRecorders, pruneRecorders, recorderFor, transcribeCandidateAudio } from './candidate-audio.js';
import { gradeAnswersWithRubric, wordCount } from './answer-grading.js';
import { lookUpFact } from './fact-lookup.js';
import mammoth from 'mammoth';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
const PORT = 3000;

// ============================================================================
// 0. BACKEND SECURITY: headers, body limits, rate limiting, admin & session auth
// ============================================================================
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Cloud Run / reverse proxy: use X-Forwarded-For for client IP

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Resumes are sent base64-encoded (~1.37x); 12MB covers a ~8MB document.
app.use(express.json({ limit: '12mb' }));

/** Minimal fixed-window, per-IP rate limiter (no external dependency). */
function rateLimit(opts: { windowMs: number; max: number; name: string }): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(opts.windowMs, 60_000)).unref();

  return (req, res, next) => {
    const key = `${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: `Too many requests (${opts.name}). Please wait a moment and try again.` });
    }
    return next();
  };
}

const limitResume = rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'resume' });
const limitStart = rateLimit({ windowMs: 10 * 60_000, max: 15, name: 'session start' });
const limitTurn = rateLimit({ windowMs: 60_000, max: 60, name: 'interview turn' });
const limitTts = rateLimit({ windowMs: 60_000, max: 90, name: 'tts' });
const limitLookup = rateLimit({ windowMs: 60_000, max: 30, name: 'lookup' });

app.use('/api/examine-resume', limitResume);
app.use('/api/start-interview-session', limitStart);
app.use(['/api/interview-turn', '/api/finalize-live-ws-session', '/api/resume-session'], limitTurn);
app.use('/api/interviewer-tts', limitTts);
app.use(['/api/candidate-history', '/api/candidate-status', '/api/candidate-profile-picture'], limitLookup);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

/**
 * Admin-only endpoints (candidate lists, answer key, DB sync) require ADMIN_API_KEY via the
 * `x-admin-key` header. If ADMIN_API_KEY is not set, these endpoints are disabled entirely.
 */
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!adminKey || adminKey.length < 16) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!safeEqual(String(req.header('x-admin-key') || ''), adminKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function generateSessionAccessToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateSessionId(): string {
  return `gh360_${Date.now()}_${crypto.randomBytes(9).toString('base64url')}`;
}

function readSessionToken(req: express.Request): string {
  return String(req.header('x-session-token') || '').trim();
}

/** Every session-scoped endpoint must present the session's secret token. */
function sessionTokenMatches(session: { accessToken?: string } | undefined, token: string): boolean {
  return Boolean(session?.accessToken) && safeEqual(token, session!.accessToken!);
}

/**
 * What the browser is allowed to see of a session: never the access token, and the
 * suggested answers / marking focus of questions are hidden until the interview is over
 * (otherwise a candidate could read the answer key from the network tab).
 */
function toPublicSession(session: any) {
  if (!session) return session;
  const { accessToken: _token, ...rest } = session;
  const finished = rest.currentPhase === 'finished';
  return {
    ...rest,
    questions: (rest.questions || []).map((q: any) =>
      finished ? q : { id: q.id, number: q.number, category: q.category, question: q.question, isBehavioralStar: q.isBehavioralStar }
    ),
  };
}

/** Wraps res.json so any `session` field in a response is passed through toPublicSession. */
app.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body?: any) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && body.session) {
      body = { ...body, session: toPublicSession(body.session) };
    }
    return originalJson(body);
  };
  next();
});

function clampText(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

// ============================================================================
// 1. SUPABASE DATABASE CLIENT & PERSISTENCE (Direct PostgREST API)
// ============================================================================
let warnedAboutAnonSupabaseKey = false;

function getSupabaseConfig(): { url: string; key: string; projectRef?: string } | null {
  const supabaseUrl = (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');

  // The backend must use the service-role key: the hardened schema (supabase-schema.sql)
  // revokes all table access from the public anon/authenticated roles.
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonFallbackKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();
  if (!serviceRoleKey && anonFallbackKey && !warnedAboutAnonSupabaseKey) {
    warnedAboutAnonSupabaseKey = true;
    console.warn(
      'SECURITY: SUPABASE_SERVICE_ROLE_KEY is not set; falling back to the public anon key. ' +
        'After applying the hardened supabase-schema.sql, anon writes are rejected — set SUPABASE_SERVICE_ROLE_KEY.'
    );
  }
  const supabaseKey = serviceRoleKey || anonFallbackKey;

  if (
    supabaseUrl &&
    supabaseKey &&
    supabaseUrl !== 'https://your-project-id.supabase.co' &&
    supabaseKey !== 'your-supabase-anon-key' &&
    supabaseKey !== 'your-supabase-service-role-key'
  ) {
    const refMatch = supabaseUrl.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
    return {
      url: supabaseUrl,
      key: supabaseKey,
      projectRef: refMatch ? refMatch[1] : undefined,
    };
  }
  return null;
}

async function provisionSupabaseTablesViaManagementApi(): Promise<{
  provisioned: boolean;
  message: string;
}> {
  const config = getSupabaseConfig();
  const accessToken = (
    process.env.SUPABASE_ACCESS_TOKEN ||
    process.env.SUPABASE_MANAGEMENT_TOKEN ||
    ''
  ).trim();

  if (!config?.projectRef || !accessToken) {
    return {
      provisioned: false,
      message:
        'To auto-run DDL from the backend without using the Supabase SQL Editor, set SUPABASE_ACCESS_TOKEN alongside SUPABASE_URL, or run /supabase-schema.sql once in Supabase Dashboard -> SQL Editor.',
    };
  }

  try {
    const schemaPath = path.join(process.cwd(), 'supabase-schema.sql');
    if (!fs.existsSync(schemaPath)) {
      return { provisioned: false, message: 'supabase-schema.sql not found.' };
    }
    const sqlQuery = fs.readFileSync(schemaPath, 'utf-8');
    const resp = await fetch(
      `https://api.supabase.com/v1/projects/${config.projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sqlQuery }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { provisioned: false, message: `Management API DDL response: ${errText}` };
    }
    return {
      provisioned: true,
      message: `Successfully created and seeded tables in Supabase project ${config.projectRef}.`,
    };
  } catch (err: any) {
    return {
      provisioned: false,
      message: err?.message || 'Supabase Management API DDL request failed.',
    };
  }
}

// In-memory store for active interview sessions during runtime
export interface TranscriptEntry {
  id: string;
  speaker: 'interviewer' | 'candidate';
  speakerName: string;
  text: string;
  timestamp: string;
  questionIndex?: number;
  eventTag?:
    | 'greeting'
    | 'question'
    | 'rephrase'
    | 'timeout'
    | 'termination'
    | 'closing'
    | 'answer'
    | 'misconduct_warning'
    | 'misconduct_termination';
}

export interface QuestionEvaluation {
  questionId: string;
  questionNumber: number;
  category: string;
  questionText: string;
  proposedAnswer?: string;
  candidateAnswer: string;
  attemptsUsed: number;
  timedOut: boolean;
  scoreOutOf5: number;
  feedback: string;
  strengths: string[];
  improvementTip: string;
  alignmentPercent?: number;
  matchedPoints?: string[];
  missedPoints?: string[];
  gradingMethod?: string;
}

export interface CandidateRecord {
  id: string;
  fullName: string;
  email: string;
  googleAvatarUrl?: string;
  resumeFileName: string;
  extractedJobPosition: string;
  confirmedJobPosition: string;
  experienceSummary: string;
  extractedSkills: string[];
  agreedToInstructions: boolean;
  sessionsCount: number;
  latestSessionId?: string;
  latestSessionStatus?: string;
  latestScoreOutOf20?: number;
  latestScoreOutOf25?: number;
  completedSessionsCount?: number;
  normalizedName?: string;
  suspendedUntil?: string | null;
  suspensionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewSessionRecord {
  id: string;
  candidateId: string;
  createdAt: string;
  completedAt?: string;
  maxDurationSeconds?: number;
  candidateName: string;
  candidateEmail: string;
  candidateGoogleAvatarUrl?: string;
  resumeFileName: string;
  detectedRole: string;
  candidateExperienceSummary: string;
  keySkills: string[];
  questions: {
    id: string;
    number: number;
    category: string;
    question: string;
    expectedFocus: string;
    proposedAnswer?: string;
    isBehavioralStar?: boolean;
  }[];
  status:
    | 'in_progress'
    | 'completed_success'
    | 'completed_unsuccessful'
    | 'terminated_attempts'
    | 'terminated_misconduct'
    | 'terminated_rules_violation'
    | 'abandoned';
  /** Secret bearer token for this session (never sent to Supabase, stripped from API payloads except on creation/resume). */
  accessToken?: string;
  /** True once the interview ran over the Gemini Live voice bridge (server builds the transcript). */
  liveMode?: boolean;
  /** Why the live call ended, decided by the server (never trusted from the browser). */
  liveEndReason?:
    | 'completed_all_questions'
    | 'time_up'
    | 'terminated_misconduct'
    | 'terminated_rules_violation'
    | 'terminated_after_two_attempts'
    | 'ended_by_candidate';
  isFirstTimeCandidate?: boolean;
  resumedCount?: number;
  /** Persistent email state so a result email is never sent twice, even across restarts. */
  emailStatus?: 'not_sent' | 'sending' | 'sent' | 'failed';
  emailId?: string;
  currentPhase:
    | 'greeting_how_are_you'
    | 'process_walkthrough'
    | 'questioning'
    | 'candidate_questions'
    | 'finished';
  currentQuestionIndex: number;
  currentQuestionAttempts: number;
  questionEvaluations: QuestionEvaluation[];
  transcript: TranscriptEntry[];
  totalScoreOutOf20: number;
  totalScoreOutOf25: number;
  maxScore: number;
  percentageScore: number;
  successful: boolean;
  interviewerFinalImpression: string;
  misconductCount?: number;
  misconductPenaltyPoints?: number;
  misconductNotes?: string[];
  suspendedUntil?: string | null;
  emailSent: boolean;
  emailDeliveryNote?: string;
  supabaseSaved?: boolean;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const CANDIDATES_FILE = path.join(DATA_DIR, 'candidates.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'interview_sessions.json');

const activeCandidates = new Map<string, CandidateRecord>();
const activeSessions = new Map<string, InterviewSessionRecord>();

function loadPersistedDataFromDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(CANDIDATES_FILE)) {
      const rawCandidates = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf-8'));
      if (Array.isArray(rawCandidates)) {
        for (const c of rawCandidates) {
          if (c && c.id) activeCandidates.set(c.id, c);
        }
      }
    }
    if (fs.existsSync(SESSIONS_FILE)) {
      const rawSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      if (Array.isArray(rawSessions)) {
        for (const s of rawSessions) {
          if (s && s.id) activeSessions.set(s.id, s);
        }
      }
    }
  } catch (err) {
    console.warn('Warning loading persisted JSON data:', err);
  }
}

function flushCandidatesAndSessionsToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      CANDIDATES_FILE,
      JSON.stringify(Array.from(activeCandidates.values()), null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify(Array.from(activeSessions.values()), null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('Warning flushing JSON data to disk:', err);
  }
}

loadPersistedDataFromDisk();

function buildCandidateIdFromEmail(email: string): string {
  const normalized = email.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `cand_${normalized || Date.now()}`;
}

const verifiedGoogleAvatarCache = new Map<string, string>();

const GOOGLE_ACCOUNT_PALETTE = [
  '#1A73E8', // Google Blue
  '#1E8E3E', // Google Green
  '#D93025', // Google Red
  '#E37400', // Google Amber
  '#9334E6', // Google Purple
  '#00897B', // Google Teal
  '#C2185B', // Google Magenta
  '#041E41', // Global Hire 360 Navy
];

function getGoogleAccountColorForEmail(email: string): string {
  const clean = (email || '').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  }
  return GOOGLE_ACCOUNT_PALETTE[hash % GOOGLE_ACCOUNT_PALETTE.length];
}

export function findCandidateProfilePicture(
  email: string,
  fullName: string
): {
  primaryUrl: string;
  gravatarUrl: string;
  fallbackAvatarUrl: string;
  emailHashMd5: string;
  emailHashSha256: string;
} {
  const cleanEmail = (email || '').trim().toLowerCase();
  const displayName = (fullName || '').trim() || cleanEmail || 'Candidate';
  const emailHashMd5 = crypto.createHash('md5').update(cleanEmail).digest('hex');
  const emailHashSha256 = crypto.createHash('sha256').update(cleanEmail).digest('hex');

  const fallbackAvatarUrl = `/api/google-avatar.svg?email=${encodeURIComponent(
    cleanEmail
  )}&name=${encodeURIComponent(displayName)}`;

  // Check if we already resolved a real photo for this Google account
  const cached = cleanEmail ? verifiedGoogleAvatarCache.get(cleanEmail) : undefined;
  const candidateId = cleanEmail ? buildCandidateIdFromEmail(cleanEmail) : '';
  const existingCandidate = candidateId ? activeCandidates.get(candidateId) : undefined;
  const savedCustomUrl =
    existingCandidate?.googleAvatarUrl &&
    !existingCandidate.googleAvatarUrl.includes('unavatar.io')
      ? existingCandidate.googleAvatarUrl
      : undefined;

  const gravatarWithFallback = `https://www.gravatar.com/avatar/${emailHashMd5}?s=256&d=404`;
  const primaryUrl = cached || savedCustomUrl || fallbackAvatarUrl;

  return {
    primaryUrl,
    gravatarUrl: gravatarWithFallback,
    fallbackAvatarUrl,
    emailHashMd5,
    emailHashSha256,
  };
}

async function resolveGoogleAccountProfilePicture(
  email: string,
  fullName: string
): Promise<{
  primaryUrl: string;
  source: 'saved_google_photo' | 'google_unavatar' | 'gravatar' | 'github' | 'google_account_monogram';
  gravatarUrl: string;
  fallbackAvatarUrl: string;
  emailHashMd5: string;
  emailHashSha256: string;
}> {
  const base = findCandidateProfilePicture(email, fullName);
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail) {
    return { ...base, source: 'google_account_monogram' };
  }

  // 1. Check if candidate already uploaded or synced a custom Google profile photo
  const candidateId = buildCandidateIdFromEmail(cleanEmail);
  const existingCandidate = activeCandidates.get(candidateId);
  if (
    existingCandidate?.googleAvatarUrl &&
    !existingCandidate.googleAvatarUrl.includes('unavatar.io') &&
    !existingCandidate.googleAvatarUrl.includes('/api/google-avatar.svg')
  ) {
    verifiedGoogleAvatarCache.set(cleanEmail, existingCandidate.googleAvatarUrl);
    return {
      ...base,
      primaryUrl: existingCandidate.googleAvatarUrl,
      source: 'saved_google_photo',
    };
  }

  const cachedUrl = verifiedGoogleAvatarCache.get(cleanEmail);
  if (cachedUrl && !cachedUrl.includes('/api/google-avatar.svg')) {
    return {
      ...base,
      primaryUrl: cachedUrl,
      source: 'google_unavatar',
    };
  }

  // 2. Query Unavatar Google JSON endpoint and verify it is a REAL user image (not favicon.svg or fallback.png)
  for (const endpoint of [
    `https://unavatar.io/google/${encodeURIComponent(cleanEmail)}?json`,
    `https://unavatar.io/${encodeURIComponent(cleanEmail)}?json`,
  ]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2200);
      const resp = await fetch(endpoint, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GlobalHire360-ProfileResolver/2.0' },
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const data: any = await resp.json();
        const resolvedUrl = String(data?.url || '').trim();
        if (
          resolvedUrl &&
          resolvedUrl.startsWith('http') &&
          !resolvedUrl.includes('favicon.svg') &&
          !resolvedUrl.includes('fallback.png') &&
          !resolvedUrl.includes('unavatar.io/fallback')
        ) {
          verifiedGoogleAvatarCache.set(cleanEmail, resolvedUrl);
          return {
            ...base,
            primaryUrl: resolvedUrl,
            source: 'google_unavatar',
          };
        }
      }
    } catch {
      // Continue to next source
    }
  }

  // 3. Check Gravatar with d=404 to see if a real profile picture is registered for this Google email
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const gravResp = await fetch(base.gravatarUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (gravResp.ok) {
      verifiedGoogleAvatarCache.set(cleanEmail, base.gravatarUrl);
      return {
        ...base,
        primaryUrl: base.gravatarUrl,
        source: 'gravatar',
      };
    }
  } catch {
    // Continue to GitHub check
  }

  // 4. Check public GitHub profile associated with this Google email
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const ghResp = await fetch(
      `https://api.github.com/search/users?q=${encodeURIComponent(cleanEmail)}+in:email`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'GlobalHire360-ProfileResolver/2.0' },
      }
    );
    clearTimeout(timeout);
    if (ghResp.ok) {
      const ghData: any = await ghResp.json();
      const ghAvatar = ghData?.items?.[0]?.avatar_url;
      if (ghAvatar && typeof ghAvatar === 'string') {
        verifiedGoogleAvatarCache.set(cleanEmail, ghAvatar);
        return {
          ...base,
          primaryUrl: ghAvatar,
          source: 'github',
        };
      }
    }
  } catch {
    // Fallback to Google Account monogram SVG
  }

  return {
    ...base,
    primaryUrl: base.fallbackAvatarUrl,
    source: 'google_account_monogram',
  };
}

function buildGoogleProfileAvatarUrl(email: string, fullName: string): string {
  return findCandidateProfilePicture(email, fullName).primaryUrl;
}

function getCandidateSuspensionStatus(email: string): {
  isSuspended: boolean;
  suspendedUntil?: string;
  remainingText?: string;
  reason?: string;
} {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return { isSuspended: false };

  const candidateId = buildCandidateIdFromEmail(normalizedEmail);
  let candidate = activeCandidates.get(candidateId);
  if (!candidate) {
    for (const c of activeCandidates.values()) {
      if (c.email.toLowerCase() === normalizedEmail) {
        candidate = c;
        break;
      }
    }
  }

  if (!candidate?.suspendedUntil) return { isSuspended: false };

  const untilMs = new Date(candidate.suspendedUntil).getTime();
  const nowMs = Date.now();
  if (Number.isNaN(untilMs) || untilMs <= nowMs) {
    // Suspension expired -> clear it
    candidate.suspendedUntil = null;
    candidate.suspensionReason = null;
    activeCandidates.set(candidate.id, candidate);
    flushCandidatesAndSessionsToDisk();
    return { isSuspended: false };
  }

  const diffMs = untilMs - nowMs;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.ceil((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const remainingText = `${hours}h ${mins}m`;

  return {
    isSuspended: true,
    suspendedUntil: candidate.suspendedUntil,
    remainingText,
    reason:
      candidate.suspensionReason ||
      'Inappropriate language or professional misconduct during a live interview session.',
  };
}

async function suspendCandidateFor24Hours(params: {
  email: string;
  candidateId?: string;
  reason: string;
}): Promise<string> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const candId = params.candidateId || buildCandidateIdFromEmail(normalizedEmail);
  const suspendedUntilIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  let candidate = activeCandidates.get(candId);
  if (!candidate) {
    for (const c of activeCandidates.values()) {
      if (c.email.toLowerCase() === normalizedEmail) {
        candidate = c;
        break;
      }
    }
  }

  if (candidate) {
    candidate.suspendedUntil = suspendedUntilIso;
    candidate.suspensionReason = params.reason;
    candidate.latestSessionStatus = 'terminated_misconduct';
    candidate.updatedAt = new Date().toISOString();
    activeCandidates.set(candidate.id, candidate);
    flushCandidatesAndSessionsToDisk();
    await saveCandidateToSupabase(candidate);
  }

  return suspendedUntilIso;
}

function detectCandidateMisconduct(text: string): {
  isMisconduct: boolean;
  severity: 'mild' | 'severe';
  reason: string;
} {
  const clean = (text || '').trim();
  if (!clean) return { isMisconduct: false, severity: 'mild', reason: '' };

  // Severe profanity, slurs, explicit abuse, or direct insults toward the interviewer
  const severeRegex =
    /\b(f+u+c+k+|f+u+c+k+i+n+g+|m+o+t+h+e+r+f+u+c+k+e+r+|b+i+t+c+h+|a+s+s+h+o+l+e+|c+u+n+t+|d+i+c+k+h+e+a+d+|s+l+u+t+|w+h+o+r+e+|b+a+s+t+a+r+d+|n+i+g+g+a+|n+i+g+g+e+r+|f+a+g+g+o+t+|r+e+t+a+r+d+|go\s+to\s+hell|shut\s+the\s+hell\s+up|shut\s+up\s+stupid|you\s+are\s+stupid|you'?re\s+an?\s+idiot|screw\s+you|piss\s+off)\b/i;

  if (severeRegex.test(clean)) {
    return {
      isMisconduct: true,
      severity: 'severe',
      reason: 'Use of explicit profanity, abusive language, or direct disrespect during the interview.',
    };
  }

  // Mild/moderate inappropriate language or vulgarity
  const mildRegex =
    /\b(s+h+i+t+|b+u+l+l+s+h+i+t+|d+a+m+n+\s+it|g+o+d+d+a+m+n+|c+r+a+p+|w+t+f+|stfu|lmaoo*\s+this\s+is\s+dumb|this\s+interview\s+is\s+stupid|you\s+suck|what\s+a\s+dumb\s+question)\b/i;

  if (mildRegex.test(clean)) {
    return {
      isMisconduct: true,
      severity: 'mild',
      reason: 'Use of unprofessional or inappropriate language during the interview session.',
    };
  }

  return { isMisconduct: false, severity: 'mild', reason: '' };
}

// ----------------------------------------------------------------------------
// Identity normalization (used for duplicate detection)
// ----------------------------------------------------------------------------
export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email);
  return e.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(e);
}

/** "  JOHN   o'Neil-Smith " -> "john o'neil-smith" (accents stripped, whitespace collapsed). */
export function normalizePersonName(name: string): string {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ----------------------------------------------------------------------------
// Generic PostgREST upsert that tolerates older tables missing newer columns
// ----------------------------------------------------------------------------
async function postgrestUpsert(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string,
  optionalColumns: string[] = []
): Promise<{ saved: boolean; error?: string }> {
  const config = getSupabaseConfig();
  if (!config) {
    return {
      saved: false,
      error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured yet.',
    };
  }

  const send = (body: unknown) =>
    fetch(`${config.url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(body),
    });

  try {
    let response = await send(rows);
    if (!response.ok && optionalColumns.length > 0) {
      const errText = await response.text();
      // PGRST204 = column not found in schema cache (table created before this column existed)
      if (/PGRST204|column|schema cache/i.test(errText)) {
        const strip = (r: Record<string, unknown>) => {
          const copy = { ...r };
          for (const col of optionalColumns) delete copy[col];
          return copy;
        };
        console.warn(
          `Supabase ${table}: newer columns missing (run supabase-schema.sql to add them). Retrying without: ${optionalColumns.join(', ')}`
        );
        response = await send(Array.isArray(rows) ? rows.map(strip) : strip(rows));
      } else {
        console.warn(`Supabase ${table} upsert warning:`, errText);
        return { saved: false, error: errText };
      }
    }
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`Supabase ${table} upsert warning:`, errText);
      return { saved: false, error: errText };
    }
    return { saved: true };
  } catch (err: any) {
    console.warn(`Supabase ${table} request exception:`, err?.message || err);
    return { saved: false, error: err?.message || `Supabase ${table} request failed` };
  }
}

async function postgrestSelect<T = any>(pathAndQuery: string): Promise<T[] | null> {
  const config = getSupabaseConfig();
  if (!config) return null;
  try {
    const resp = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
      method: 'GET',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function saveCandidateToSupabase(
  candidate: CandidateRecord
): Promise<{ saved: boolean; error?: string }> {
  return postgrestUpsert(
    'candidates',
    {
      id: candidate.id,
      full_name: candidate.fullName,
      normalized_name: candidate.normalizedName || normalizePersonName(candidate.fullName),
      email: candidate.email,
      resume_file_name: candidate.resumeFileName,
      extracted_job_position: candidate.extractedJobPosition,
      confirmed_job_position: candidate.confirmedJobPosition,
      experience_summary: candidate.experienceSummary,
      extracted_skills: candidate.extractedSkills,
      agreed_to_instructions: candidate.agreedToInstructions,
      sessions_count: candidate.sessionsCount,
      completed_sessions_count: candidate.completedSessionsCount ?? 0,
      latest_session_id: candidate.latestSessionId || null,
      latest_session_status: candidate.latestSessionStatus || 'in_progress',
      latest_score_out_of_20: candidate.latestScoreOutOf20 ?? 0,
      latest_score_out_of_25: candidate.latestScoreOutOf20 ?? candidate.latestScoreOutOf25 ?? 0,
      suspended_until: candidate.suspendedUntil || null,
      created_at: candidate.createdAt,
      updated_at: candidate.updatedAt,
    },
    'email',
    ['normalized_name', 'completed_sessions_count', 'latest_score_out_of_20', 'suspended_until']
  );
}

function candidateFromSupabaseRow(row: any): CandidateRecord {
  return {
    id: row.id,
    fullName: row.full_name,
    normalizedName: row.normalized_name || normalizePersonName(row.full_name),
    email: normalizeEmail(row.email),
    resumeFileName: row.resume_file_name || '',
    extractedJobPosition: row.extracted_job_position || '',
    confirmedJobPosition: row.confirmed_job_position || '',
    experienceSummary: row.experience_summary || '',
    extractedSkills: Array.isArray(row.extracted_skills) ? row.extracted_skills : [],
    agreedToInstructions: Boolean(row.agreed_to_instructions),
    sessionsCount: Number(row.sessions_count) || 0,
    completedSessionsCount: Number(row.completed_sessions_count) || 0,
    latestSessionId: row.latest_session_id || undefined,
    latestSessionStatus: row.latest_session_status || undefined,
    latestScoreOutOf20: row.latest_score_out_of_20 != null ? Number(row.latest_score_out_of_20) : undefined,
    latestScoreOutOf25: row.latest_score_out_of_25 != null ? Number(row.latest_score_out_of_25) : undefined,
    suspendedUntil: row.suspended_until || null,
    suspensionReason: null,
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

function countCompletedSessionsLocally(candidate: CandidateRecord): number {
  let count = 0;
  for (const s of activeSessions.values()) {
    if (
      (s.candidateId === candidate.id || s.candidateEmail === candidate.email) &&
      s.currentPhase === 'finished' &&
      s.status !== 'abandoned'
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Recognizes a returning candidate. The email address is the identity key: it is checked
 * in memory first, then in Supabase (so candidates are recognized after a restart or on
 * another server instance), and the record is hydrated into memory.
 * A name match alone is reported (nameMatchesExistingCandidate) but never merged, because
 * different people can share a name and merging on name would expose someone else's file.
 */
async function findExistingCandidate(params: {
  email: string;
  name?: string;
}): Promise<{ candidate: CandidateRecord | null; nameMatchesExistingCandidate: boolean }> {
  const email = normalizeEmail(params.email);
  const normalizedName = normalizePersonName(params.name || '');
  let candidate: CandidateRecord | null = null;

  if (email) {
    candidate = activeCandidates.get(buildCandidateIdFromEmail(email)) || null;
    if (!candidate) {
      for (const c of activeCandidates.values()) {
        if (normalizeEmail(c.email) === email) {
          candidate = c;
          break;
        }
      }
    }
    if (!candidate) {
      const rows = await postgrestSelect(
        `candidates?select=*&email=eq.${encodeURIComponent(email)}&limit=1`
      );
      if (rows && rows[0]) {
        candidate = candidateFromSupabaseRow(rows[0]);
        activeCandidates.set(candidate.id, candidate);
        flushCandidatesAndSessionsToDisk();
      }
    }
  }

  if (candidate) {
    const localCompleted = countCompletedSessionsLocally(candidate);
    candidate.completedSessionsCount = Math.max(candidate.completedSessionsCount || 0, localCompleted);
  }

  let nameMatchesExistingCandidate = false;
  if (!candidate && normalizedName.length >= 3) {
    for (const c of activeCandidates.values()) {
      if ((c.normalizedName || normalizePersonName(c.fullName)) === normalizedName) {
        nameMatchesExistingCandidate = true;
        break;
      }
    }
    if (!nameMatchesExistingCandidate) {
      const rows = await postgrestSelect(
        `candidates?select=id&normalized_name=eq.${encodeURIComponent(normalizedName)}&limit=1`
      );
      nameMatchesExistingCandidate = Boolean(rows && rows.length > 0);
    }
  }

  return { candidate, nameMatchesExistingCandidate };
}

/** Serializes check-ins per email so double-clicks / parallel tabs never create two rows. */
const candidateCheckInLocks = new Map<string, Promise<unknown>>();
async function withCandidateLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeEmail(email);
  const previous = candidateCheckInLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  const chained = previous.then(() => current);
  candidateCheckInLocks.set(key, chained);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (candidateCheckInLocks.get(key) === chained) candidateCheckInLocks.delete(key);
  }
}

async function upsertCandidateOnCheckIn(params: {
  existing: CandidateRecord | null;
  fullName: string;
  email: string;
  resumeFileName: string;
  extractedJobPosition: string;
  confirmedJobPosition: string;
  experienceSummary: string;
  extractedSkills: string[];
  agreedToInstructions: boolean;
  sessionId: string;
}): Promise<CandidateRecord> {
  const normalizedEmail = normalizeEmail(params.email);
  const nowIso = new Date().toISOString();
  const existing = params.existing;
  const googleAvatarUrl = buildGoogleProfileAvatarUrl(normalizedEmail, params.fullName);

  const candidate: CandidateRecord = existing
    ? {
        ...existing,
        // Same email = same person: update the single existing record, never create a second one.
        fullName: params.fullName.trim() || existing.fullName,
        normalizedName: normalizePersonName(params.fullName.trim() || existing.fullName),
        email: normalizedEmail,
        googleAvatarUrl: existing.googleAvatarUrl || googleAvatarUrl,
        resumeFileName: params.resumeFileName || existing.resumeFileName,
        extractedJobPosition: params.extractedJobPosition || existing.extractedJobPosition,
        confirmedJobPosition: params.confirmedJobPosition || existing.confirmedJobPosition,
        experienceSummary: params.experienceSummary || existing.experienceSummary,
        extractedSkills:
          Array.isArray(params.extractedSkills) && params.extractedSkills.length > 0
            ? params.extractedSkills
            : existing.extractedSkills,
        agreedToInstructions: params.agreedToInstructions,
        sessionsCount: (existing.sessionsCount || 0) + 1,
        latestSessionId: params.sessionId,
        latestSessionStatus: 'in_progress',
        updatedAt: nowIso,
      }
    : {
        id: buildCandidateIdFromEmail(normalizedEmail),
        fullName: params.fullName.trim(),
        normalizedName: normalizePersonName(params.fullName),
        email: normalizedEmail,
        googleAvatarUrl,
        resumeFileName: params.resumeFileName,
        extractedJobPosition: params.extractedJobPosition,
        confirmedJobPosition: params.confirmedJobPosition,
        experienceSummary: params.experienceSummary,
        extractedSkills: params.extractedSkills,
        agreedToInstructions: params.agreedToInstructions,
        sessionsCount: 1,
        completedSessionsCount: 0,
        latestSessionId: params.sessionId,
        latestSessionStatus: 'in_progress',
        latestScoreOutOf20: 0,
        latestScoreOutOf25: 0,
        suspendedUntil: null,
        suspensionReason: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

  activeCandidates.set(candidate.id, candidate);
  flushCandidatesAndSessionsToDisk();
  await saveCandidateToSupabase(candidate);
  return candidate;
}

/**
 * One row per answered question in public.candidate_answers (unique per session + question
 * number, so re-saving a session updates rows instead of duplicating them).
 */
async function saveCandidateAnswersToSupabase(
  session: InterviewSessionRecord
): Promise<{ saved: boolean; error?: string }> {
  const answered = session.questionEvaluations.filter((ev) => ev && ev.questionNumber);
  if (answered.length === 0) return { saved: true };
  const questionCount = Math.max(1, session.questions.length);
  const rows = answered.map((ev) => {
    const q = session.questions.find((qq) => qq.number === ev.questionNumber);
    return {
      id: `${session.id}_q${ev.questionNumber}`,
      session_id: session.id,
      candidate_id: session.candidateId,
      candidate_email: session.candidateEmail,
      candidate_name: session.candidateName,
      job_position: session.detectedRole,
      question_id: q?.id || ev.questionId,
      question_number: ev.questionNumber,
      question_category: ev.category,
      question_text: ev.questionText,
      candidate_answer: ev.candidateAnswer,
      suggested_answer: ev.proposedAnswer || q?.proposedAnswer || null,
      score_out_of_5: ev.scoreOutOf5,
      score_contribution_out_of_20: Number(((ev.scoreOutOf5 / (questionCount * 5)) * INTERVIEW_MAX_SCORE).toFixed(2)),
      alignment_percent: ev.alignmentPercent ?? null,
      matched_points: ev.matchedPoints || [],
      missed_points: ev.missedPoints || [],
      feedback: ev.feedback,
      improvement_tip: ev.improvementTip,
      attempts_used: ev.attemptsUsed,
      timed_out: ev.timedOut,
      grading_method: ev.gradingMethod || 'marking_guide',
      updated_at: new Date().toISOString(),
    };
  });
  return postgrestUpsert('candidate_answers', rows, 'session_id,question_number');
}

async function saveSessionToSupabase(session: InterviewSessionRecord): Promise<{ saved: boolean; error?: string }> {
  // Always update linked candidate record & flush to local disk first
  const linkedCandidate = activeCandidates.get(session.candidateId);
  if (linkedCandidate) {
    linkedCandidate.latestSessionId = session.id;
    linkedCandidate.latestSessionStatus = session.status;
    linkedCandidate.latestScoreOutOf20 = session.totalScoreOutOf20 ?? session.totalScoreOutOf25;
    linkedCandidate.latestScoreOutOf25 = linkedCandidate.latestScoreOutOf20;
    linkedCandidate.completedSessionsCount = countCompletedSessionsLocally(linkedCandidate);
    linkedCandidate.updatedAt = new Date().toISOString();
    activeCandidates.set(linkedCandidate.id, linkedCandidate);
  }
  activeSessions.set(session.id, session);
  flushCandidatesAndSessionsToDisk();

  if (!getSupabaseConfig()) {
    return {
      saved: false,
      error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured yet.',
    };
  }

  // Ensure parent candidate exists in Supabase first to satisfy the FK (interview_sessions.candidate_id -> candidates.id)
  if (linkedCandidate) {
    await saveCandidateToSupabase(linkedCandidate);
  }

  const sessionRes = await postgrestUpsert(
    'interview_sessions',
    {
      id: session.id,
      candidate_id: session.candidateId,
      candidate_name: session.candidateName,
      candidate_email: session.candidateEmail,
      resume_file_name: session.resumeFileName,
      job_position: session.detectedRole,
      experience_summary: session.candidateExperienceSummary,
      key_skills: session.keySkills,
      status: session.status,
      current_phase: session.currentPhase,
      question_count: session.questions.length,
      is_first_time_candidate: session.isFirstTimeCandidate !== false,
      total_score: session.totalScoreOutOf20 ?? 0,
      max_score: INTERVIEW_MAX_SCORE,
      percentage_score: session.percentageScore,
      successful: session.successful,
      final_impression: session.interviewerFinalImpression,
      question_evaluations: session.questionEvaluations,
      transcript: session.transcript,
      email_status: session.emailStatus || (session.emailSent ? 'sent' : 'not_sent'),
      email_sent: Boolean(session.emailSent),
      created_at: session.createdAt,
      completed_at: session.completedAt || null,
    },
    'id',
    ['current_phase', 'question_count', 'is_first_time_candidate', 'email_status', 'email_sent']
  );

  const answersRes = await saveCandidateAnswersToSupabase(session);
  if (!answersRes.saved) {
    console.warn('candidate_answers not saved (run supabase-schema.sql to create the table):', answersRes.error);
  }
  return sessionRes;
}

// ============================================================================
// 2. RESEND TRANSACTIONAL EMAIL INTEGRATION (https://api.resend.com/emails)
// ============================================================================
const sessionEmailLocks = new Set<string>();

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strips CR/LF so user-controlled values can never inject extra email headers/subject lines. */
function singleLine(value: unknown, max = 160): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/**
 * Sends the results email exactly once per session.
 * Duplicate protection (the cause of candidates receiving 3 result emails was several
 * finalize paths — Gemini end_call fired more than once, the End Call button, the 10-minute
 * timer and the manual "send email" endpoint — all racing on an in-memory flag):
 *  1. Persistent emailStatus ('sending'/'sent') written to disk BEFORE calling Resend,
 *     so a second caller, a restart, or a retry after a timeout never re-sends.
 *  2. In-process lock for concurrent callers in the same tick.
 *  3. Resend Idempotency-Key header derived from the session id, so even if two server
 *     instances race, Resend itself delivers only one email (24h idempotency window).
 *  4. No manual resend: candidates cannot trigger it; failed sends are retried automatically.
 */
async function sendResendAssessmentEmail(
  session: InterviewSessionRecord
): Promise<{ sent: boolean; note: string; emailId?: string; inProgress?: boolean }> {
  if (session.emailSent || session.emailStatus === 'sent') {
    session.emailSent = true;
    session.emailStatus = 'sent';
    return {
      sent: true,
      note: session.emailDeliveryNote || `Assessment report has already been delivered to ${session.candidateEmail}.`,
    };
  }

  // Only a send running in THIS process counts as "in progress". A 'sending' status left on
  // disk by a restart/crash mid-send is retried; Resend's Idempotency-Key (same per session)
  // guarantees the candidate still receives the email only once.
  if (sessionEmailLocks.has(session.id)) {
    return {
      sent: false,
      inProgress: true,
      note: `Assessment email dispatch is already in progress for ${session.candidateEmail}.`,
    };
  }

  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (!resendApiKey || resendApiKey === 're_your_resend_api_key') {
    return {
      sent: false,
      note: `Report prepared for ${session.candidateEmail} (Add RESEND_API_KEY in Secrets to enable live Resend email delivery).`,
    };
  }

  sessionEmailLocks.add(session.id);
  session.emailStatus = 'sending';
  activeSessions.set(session.id, session);
  flushCandidatesAndSessionsToDisk();

  try {
    const rawSenderEmail = (
      process.env.RESEND_FROM_EMAIL ||
      process.env.RESEND_SENDER_EMAIL ||
      'onboarding@resend.dev'
    ).trim();
    const senderName = singleLine(
      process.env.RESEND_FROM_NAME || process.env.RESEND_SENDER_NAME || 'Global Hire 360 Interview Coach',
      80
    );

    const formatFromHeader = (emailAddr: string) =>
      emailAddr.includes('<') ? emailAddr : `${senderName} <${emailAddr}>`;

    const appUrl = (process.env.APP_URL || 'https://www.globalhire360.com').replace(/\/+$/, '');
    const passed = Boolean(session.successful);
    const name = escapeHtml(session.candidateName);
    const role = escapeHtml(session.detectedRole);
    const totalDisplayScore = session.totalScoreOutOf20 ?? session.totalScoreOutOf25;
    const maxScore = INTERVIEW_MAX_SCORE;
    const appreciationTitle = passed
      ? 'Congratulations — You Passed This Practice Interview!'
      : 'Good Effort — Keep Practicing to Reach Placement Readiness';
    const appreciationBodyText = passed
      ? `Outstanding work, ${session.candidateName}! You demonstrated strong communication, clear role knowledge, and composure for the ${session.detectedRole} position. You are well-prepared for your upcoming employer interview.`
      : `Thank you for practicing with us, ${session.candidateName}. Every practice conversation builds your confidence for the real ${session.detectedRole} interview. Review the suggested answers on your results page and retake the practice session whenever you are ready.`;

    const htmlContent = `
    <div style="font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 14px; overflow: hidden; background: #FFFFFF;">
      <div style="background: #041E41; color: #FFFFFF; padding: 24px 28px; border-bottom: 4px solid #339A05;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #86EFAC; font-weight: 700; margin-bottom: 4px;">Global Hire 360 &bull; Candidate Readiness</div>
        <h1 style="margin: 0; font-size: 19px; font-weight: 800;">Interview Practice Summary</h1>
      </div>
      <div style="padding: 28px;">
        <p style="font-size: 15px; color: #0F172A; margin: 0 0 14px 0;">Hello <strong>${name}</strong>,</p>

        <div style="background: ${passed ? '#F0FDF4' : '#FFFBEB'}; border: 1px solid ${passed ? '#BBF7D0' : '#FDE68A'}; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
          <div style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: ${passed ? '#15803D' : '#B45309'};">
            ${passed ? 'PASSED ASSESSMENT' : 'PRACTICE RECOMMENDED'}
          </div>
          <div style="font-size: 32px; font-weight: 900; color: #041E41; margin: 6px 0;">
            ${escapeHtml(totalDisplayScore)} / ${maxScore} <span style="font-size: 16px; font-weight: 700; color: #339A05;">(${escapeHtml(session.percentageScore)}%)</span>
          </div>
          <div style="font-size: 14px; font-weight: 700; color: #1E293B; margin-top: 4px;">${appreciationTitle}</div>
          <p style="font-size: 13px; color: #475569; line-height: 1.55; margin: 8px 0 0 0;">${escapeHtml(appreciationBodyText)}</p>
        </div>

        <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px; padding: 16px; margin-bottom: 24px;">
          <div style="font-size: 12px; font-weight: 700; color: #041E41; text-transform: uppercase; margin-bottom: 6px;">Summary of Your Call (${role})</div>
          <p style="font-size: 13px; color: #334155; line-height: 1.6; margin: 0;">${escapeHtml(session.interviewerFinalImpression)}</p>
        </div>

        <div style="text-align: center; margin: 26px 0 10px 0;">
          <a href="${escapeHtml(appUrl)}" style="display: inline-block; background: #339A05; color: #FFFFFF; text-decoration: none; font-weight: 700; font-size: 14px; padding: 13px 26px; border-radius: 10px;">
            ${passed ? 'Practice Another Interview Session' : 'Retake the Practice Interview'}
          </a>
        </div>
      </div>
      <div style="background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 14px 28px; text-align: center; font-size: 11px; color: #64748B;">
        Global Hire 360 &bull; AI Interview Preparation &amp; Recruiting Readiness Platform
      </div>
    </div>
  `;

    const plainTextContent = [
      `GLOBAL HIRE 360 — INTERVIEW PRACTICE SUMMARY`,
      `Candidate: ${session.candidateName}`,
      `Role: ${session.detectedRole}`,
      `Overall Score: ${totalDisplayScore} / ${maxScore} (${session.percentageScore}%) — ${passed ? 'PASSED' : 'PRACTICE RECOMMENDED'}`,
      ``,
      appreciationTitle,
      appreciationBodyText,
      ``,
      `Summary of Your Call:`,
      session.interviewerFinalImpression,
      ``,
      `Retake or Practice Again: ${appUrl}`,
    ].join('\n');

    const subjectLine = singleLine(
      `Global Hire 360 Interview Results: ${session.candidateName} (${session.detectedRole}) — ${totalDisplayScore}/${maxScore}`,
      200
    );

    const requestBody = JSON.stringify({
      from: formatFromHeader(rawSenderEmail),
      to: [session.candidateEmail],
      subject: subjectLine,
      html: htmlContent,
      text: plainTextContent,
    });
    // Same key for every attempt (and after a restart): Resend delivers at most one email per
    // session even if an attempt that looked failed actually went through.
    const idempotencyKey = `gh360-results-${session.id}`;
    // Temporary problems (network, rate limit, Resend 5xx) are retried; anything else
    // (invalid address, sender not allowed...) will not get better by retrying.
    const retryDelaysMs = [0, 2000, 5000];
    let lastProblem = '';
    for (const delay of retryDelaysMs) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      let response: Response;
      try {
        response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: requestBody,
          signal: AbortSignal.timeout(15000),
        });
      } catch (netErr: any) {
        lastProblem = `network error: ${netErr?.message || netErr}`;
        console.warn('Resend request failed (will retry):', lastProblem);
        continue;
      }
      if (response.ok) {
        const resData = (await response.json().catch(() => ({}))) as { id?: string };
        session.emailSent = true;
        session.emailStatus = 'sent';
        session.emailId = resData?.id;
        session.emailDeliveryNote = `Your results were emailed to ${session.candidateEmail}.`;
        console.log(`[Resend] Results email sent for session ${session.id}${resData?.id ? ` (ID: ${resData.id})` : ''}.`);
        return { sent: true, emailId: resData?.id, note: session.emailDeliveryNote };
      }
      const errText = await response.text().catch(() => '');
      lastProblem = `HTTP ${response.status}: ${errText.slice(0, 300)}`;
      console.warn('Resend API non-200 response:', lastProblem);
      if (response.status !== 429 && response.status < 500) break;
    }

    session.emailStatus = 'failed';
    console.warn(`[Resend] Results email NOT sent for session ${session.id} (${lastProblem}).`);
    return {
      sent: false,
      note: `We couldn't email your results to ${session.candidateEmail} right now. We'll try again automatically.`,
    };
  } catch (err: any) {
    console.error('Resend email error:', err);
    // The idempotency key makes a later retry safe (Resend will not deliver a second copy).
    session.emailStatus = 'failed';
    return {
      sent: false,
      note: `We couldn't email your results to ${session.candidateEmail} right now. We'll try again automatically.`,
    };
  } finally {
    sessionEmailLocks.delete(session.id);
    activeSessions.set(session.id, session);
    flushCandidatesAndSessionsToDisk();
  }
}

async function retryResultEmail(session: InterviewSessionRecord): Promise<void> {
  if (session.emailSent || session.emailStatus === 'sent') return;
  const res = await sendResendAssessmentEmail(session);
  if (!res.inProgress) session.emailDeliveryNote = res.note;
  await saveSessionToSupabase(session).catch(() => undefined);
}

/**
 * At server start: finished interviews from the last 23 hours whose results email never went
 * out (server stopped mid-send, or Resend was unreachable) are sent now. Resend's idempotency
 * window is 24 hours, so a send that did go through is not delivered twice.
 */
async function retryUnsentResultEmails(): Promise<void> {
  const cutoff = Date.now() - 23 * 60 * 60_000;
  const pending = Array.from(activeSessions.values()).filter(
    (s) =>
      s.currentPhase === 'finished' &&
      !s.emailSent &&
      (s.emailStatus === 'sending' || s.emailStatus === 'failed') &&
      s.completedAt &&
      new Date(s.completedAt).getTime() > cutoff
  );
  for (const session of pending) await retryResultEmail(session);
  if (pending.length) console.log(`[Resend] Retried ${pending.length} unsent results email(s).`);
}

// ============================================================================
// 3. GEMINI CLIENT HELPER
// ============================================================================
function getGenAIClientOrNull(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: 'v1alpha', // needed for affective dialog & proactive audio
      headers: { 'User-Agent': 'aistudio-build' },
    },
  });
}

// ============================================================================
// 4. DEDICATED RESUME EXAMINATION & JOB POSITION EXTRACTION FUNCTION
// ============================================================================
export interface ResumeExaminationResult {
  detectedRole: string;
  candidateExperienceSummary: string;
  keySkills: string[];
  questions: {
    id: string;
    number: number;
    category: string;
    question: string;
    expectedFocus: string;
    proposedAnswer?: string;
    isBehavioralStar?: boolean;
  }[];
}

export const GLOBAL_HIRE_POSITIONS = [
  'Customer Service',
  'Virtual Assistant',
  'Data Entry',
  'Admin Support',
  'Executive Assistant',
] as const;

function collapseSpacedHeading(line: string): string {
  const trimmed = line.trim();
  // Match letter-spaced headings like "S K I L L S" or "W O R K   E X P E R I E N C E"
  if (/^(?:[A-Za-z]\s+){3,}[A-Za-z](?:\s+(?:&|AND|[A-Za-z])(?:\s+[A-Za-z])+)*$/i.test(trimmed)) {
    const words = trimmed.split(/\s{2,}/);
    const collapsed = words.map((w) => w.replace(/\s+/g, '')).join(' ');
    if (collapsed.length >= 4) {
      return collapsed;
    }
  }
  return trimmed;
}

async function extractTextWithPdfJs(
  buffer: Buffer
): Promise<{ streamText: string; columnSortedText: string }> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const streamPages: string[] = [];
  const columnPages: string[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width || 612;
    const textContent = await page.getTextContent();
    const rawItems = (textContent.items || []) as any[];

    interface PdfRun {
      str: string;
      x: number;
      y: number;
      width: number;
      height: number;
      hasEOL: boolean;
    }

    const runs: PdfRun[] = [];
    for (const item of rawItems) {
      if (typeof item.str !== 'string') continue;
      const x = Array.isArray(item.transform) ? Number(item.transform[4]) || 0 : 0;
      const y = Array.isArray(item.transform) ? Number(item.transform[5]) || 0 : 0;
      const height = Array.isArray(item.transform)
        ? Math.abs(Number(item.transform[3]) || Number(item.transform[0]) || 10)
        : 10;
      const width = Number(item.width) || item.str.length * (height * 0.5);
      runs.push({
        str: item.str,
        x,
        y,
        width,
        height,
        hasEOL: Boolean(item.hasEOL),
      });
    }

    // 1. STREAM-ORDER RECONSTRUCTION (preserves text boxes/frames/columns in Canva, Word, Figma, InDesign)
    const streamLines: string[] = [];
    let curLine = '';
    let prevXEnd: number | null = null;
    let prevY: number | null = null;
    let prevXStart: number | null = null;

    const flushStreamLine = () => {
      const cleaned = collapseSpacedHeading(curLine.replace(/[ \t]+/g, ' ').trim());
      if (cleaned) streamLines.push(cleaned);
      curLine = '';
      prevXEnd = null;
      prevY = null;
      prevXStart = null;
    };

    for (const run of runs) {
      if (!run.str.trim() && !run.hasEOL) {
        if (curLine && !curLine.endsWith(' ')) curLine += ' ';
        continue;
      }

      if (prevY !== null && prevXEnd !== null && prevXStart !== null) {
        const dy = Math.abs(run.y - prevY);
        const horizontalGap = run.x - prevXEnd;
        // Break line if Y changed, or if X jumped across a column gap (> 28pt), or carriage-returned left
        if (dy > 3.8 || horizontalGap > 28 || run.x < prevXStart - 8) {
          flushStreamLine();
        } else if (
          horizontalGap > 1.2 &&
          curLine &&
          !curLine.endsWith(' ') &&
          !run.str.startsWith(' ')
        ) {
          curLine += ' ';
        }
      }

      curLine += run.str;
      if (prevXStart === null) prevXStart = run.x;
      prevXEnd = run.x + Math.max(0, run.width);
      prevY = run.y;

      if (run.hasEOL) {
        flushStreamLine();
      }
    }
    flushStreamLine();
    streamPages.push(streamLines.join('\n'));

    // 2. COLUMN-AWARE COORDINATE RECONSTRUCTION (handles row-interleaved 2-column & 1-column PDFs)
    interface LineSegment {
      text: string;
      xStart: number;
      xEnd: number;
      y: number;
    }

    const nonEmptyRuns = runs.filter((r) => r.str.trim().length > 0);
    // Group runs into Y rows (tolerance 3.2pt)
    const sortedByY = [...nonEmptyRuns].sort((a, b) => {
      if (Math.abs(b.y - a.y) > 3.2) return b.y - a.y;
      return a.x - b.x;
    });

    const rowGroups: PdfRun[][] = [];
    for (const r of sortedByY) {
      const lastGroup = rowGroups[rowGroups.length - 1];
      if (!lastGroup || Math.abs(r.y - lastGroup[0].y) > 3.2) {
        rowGroups.push([r]);
      } else {
        lastGroup.push(r);
      }
    }

    const segments: LineSegment[] = [];
    for (const group of rowGroups) {
      group.sort((a, b) => a.x - b.x);
      let segText = group[0].str;
      let segXStart = group[0].x;
      let segXEnd = group[0].x + Math.max(0, group[0].width);
      const segY = group[0].y;

      for (let i = 1; i < group.length; i++) {
        const item = group[i];
        const gap = item.x - segXEnd;
        if (gap > 26) {
          // Separate column or table cell on the same Y coordinate
          const cleaned = collapseSpacedHeading(segText.replace(/[ \t]+/g, ' ').trim());
          if (cleaned) {
            segments.push({ text: cleaned, xStart: segXStart, xEnd: segXEnd, y: segY });
          }
          segText = item.str;
          segXStart = item.x;
          segXEnd = item.x + Math.max(0, item.width);
        } else {
          if (gap > 1.2 && !segText.endsWith(' ') && !item.str.startsWith(' ')) {
            segText += ' ';
          }
          segText += item.str;
          segXEnd = Math.max(segXEnd, item.x + Math.max(0, item.width));
        }
      }
      const cleaned = collapseSpacedHeading(segText.replace(/[ \t]+/g, ' ').trim());
      if (cleaned) {
        segments.push({ text: cleaned, xStart: segXStart, xEnd: segXEnd, y: segY });
      }
    }

    // Detect if the page has a 2-column vertical gutter
    let bestGutter: number | null = null;
    let bestSideScore = 0;
    let bestOverlapTopY = Infinity;
    let bestOverlapBottomY = -Infinity;

    for (let g = Math.round(pageWidth * 0.23); g <= Math.round(pageWidth * 0.77); g += 5) {
      const leftOnly = segments.filter(
        (s) => s.xEnd <= g + 6 && s.xEnd - s.xStart < pageWidth * 0.65
      );
      const rightOnly = segments.filter(
        (s) => s.xStart >= g - 6 && s.xEnd - s.xStart < pageWidth * 0.65
      );
      if (leftOnly.length < 4 || rightOnly.length < 4) continue;

      const leftMaxY = Math.max(...leftOnly.map((s) => s.y));
      const leftMinY = Math.min(...leftOnly.map((s) => s.y));
      const rightMaxY = Math.max(...rightOnly.map((s) => s.y));
      const rightMinY = Math.min(...rightOnly.map((s) => s.y));

      const overlapTop = Math.min(leftMaxY, rightMaxY);
      const overlapBottom = Math.max(leftMinY, rightMinY);
      if (overlapTop - overlapBottom < 60) continue;

      const crossingInOverlap = segments.filter(
        (s) =>
          s.y <= overlapTop + 4 &&
          s.y >= overlapBottom - 4 &&
          s.xStart < g - 8 &&
          s.xEnd > g + 8
      );

      if (crossingInOverlap.length === 0) {
        const score = Math.min(leftOnly.length, rightOnly.length) * 10 + ( leftOnly.length + rightOnly.length );
        if (score > bestSideScore) {
          bestSideScore = score;
          bestGutter = g;
          bestOverlapTopY = Math.max(leftMaxY, rightMaxY);
          bestOverlapBottomY = Math.min(leftMinY, rightMinY);
        }
      }
    }

    if (bestGutter !== null) {
      const topBanner = segments
        .filter((s) => s.y > bestOverlapTopY + 4 && s.xStart < bestGutter! - 8 && s.xEnd > bestGutter! + 8)
        .sort((a, b) => b.y - a.y || a.xStart - b.xStart);

      const bottomBanner = segments
        .filter((s) => s.y < bestOverlapBottomY - 4 && s.xStart < bestGutter! - 8 && s.xEnd > bestGutter! + 8)
        .sort((a, b) => b.y - a.y || a.xStart - b.xStart);

      const bannerSet = new Set([...topBanner, ...bottomBanner]);
      const colLeft = segments
        .filter((s) => !bannerSet.has(s) && s.xStart < bestGutter!)
        .sort((a, b) => b.y - a.y || a.xStart - b.xStart);

      const colRight = segments
        .filter((s) => !bannerSet.has(s) && s.xStart >= bestGutter!)
        .sort((a, b) => b.y - a.y || a.xStart - b.xStart);

      const ordered = [...topBanner, ...colLeft, ...colRight, ...bottomBanner].map((s) => s.text);
      columnPages.push(ordered.join('\n'));
    } else {
      const ordered = segments
        .sort((a, b) => (Math.abs(b.y - a.y) > 3.2 ? b.y - a.y : a.xStart - b.xStart))
        .map((s) => s.text);
      columnPages.push(ordered.join('\n'));
    }
  }

  return {
    streamText: streamPages.join('\n').trim(),
    columnSortedText: columnPages.join('\n').trim(),
  };
}

function decodePdfLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') {
        out += '\n';
        i++;
      } else if (next === 'r') {
        out += '\r';
        i++;
      } else if (next === 't') {
        out += ' ';
        i++;
      } else if (next === '(' || next === ')' || next === '\\') {
        out += next;
        i++;
      } else if (/[0-7]/.test(next)) {
        const octMatch = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (octMatch) {
          out += String.fromCharCode(parseInt(octMatch[0], 8));
          i += octMatch[0].length;
        }
      } else {
        out += next;
        i++;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function extractTextFromPdfBufferFallback(buffer: Buffer): string {
  const rawLatin = buffer.toString('latin1');
  const decompressedStreams: string[] = [];

  const streamRegex = /stream(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)?endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(rawLatin)) !== null) {
    const body = match[1];
    try {
      const inflated = zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
      decompressedStreams.push(inflated);
    } catch {
      try {
        const inflatedRaw = zlib.inflateRawSync(Buffer.from(body, 'latin1')).toString('latin1');
        decompressedStreams.push(inflatedRaw);
      } catch {
        if (body.includes('BT') && body.includes('ET')) {
          decompressedStreams.push(body);
        }
      }
    }
  }

  const extractedLines: string[] = [];
  for (const stream of decompressedStreams) {
    if (stream.includes('beginbfchar') || stream.includes('beginbfrange')) continue;
    let currentLine = '';
    let lastTmY: number | null = null;

    const flushLine = () => {
      if (currentLine.trim()) {
        extractedLines.push(collapseSpacedHeading(currentLine.replace(/\s+/g, ' ').trim()));
        currentLine = '';
      }
    };

    const tokenRegex =
      /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(?:Td|TD)|(T\*|\bET\b)|\[((?:[^\[\]]|\((?:\\.|[^\\()])*\))*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g;

    let tok: RegExpExecArray | null;
    while ((tok = tokenRegex.exec(stream)) !== null) {
      if (tok[6] !== undefined) {
        const y = parseFloat(tok[6]);
        if (lastTmY !== null && Math.abs(y - lastTmY) > 2.5) {
          flushLine();
        } else if (currentLine && !currentLine.endsWith(' ')) {
          currentLine += ' ';
        }
        lastTmY = y;
      } else if (tok[8] !== undefined) {
        const tx = parseFloat(tok[7]);
        const ty = parseFloat(tok[8]);
        if (Math.abs(ty) > 1.5 || Math.abs(tx) > 35) {
          flushLine();
        } else if (tx > 1.5 && currentLine && !currentLine.endsWith(' ')) {
          currentLine += ' ';
        }
      } else if (tok[9] !== undefined) {
        flushLine();
        lastTmY = null;
      } else if (tok[10] !== undefined) {
        const arrayContent = tok[10];
        const subTokenRegex = /\(((?:\\.|[^\\()])*)\)|(-?\d+(?:\.\d+)?)/g;
        let sub: RegExpExecArray | null;
        while ((sub = subTokenRegex.exec(arrayContent)) !== null) {
          if (sub[1] !== undefined) {
            currentLine += decodePdfLiteralString(sub[1]);
          } else if (sub[2] !== undefined) {
            const kerning = parseFloat(sub[2]);
            if (kerning < -120 && !currentLine.endsWith(' ')) {
              currentLine += ' ';
            }
          }
        }
      } else if (tok[11] !== undefined) {
        currentLine += decodePdfLiteralString(tok[11]);
      }
    }
    flushLine();
  }

  return extractedLines.join('\n').trim();
}

async function extractRawTextFromResumeBuffer(
  buffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<string[]> {
  const lowerName = (fileName || '').toLowerCase();
  const candidates: string[] = [];

  // 1. DOCX extraction via Mammoth (preserves paragraphs & bullet lines)
  if (
    lowerName.endsWith('.docx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const cleanDocx = (result.value || '')
        .split('\n')
        .map((l) => collapseSpacedHeading(l))
        .join('\n')
        .trim();
      return [cleanDocx];
    } catch (e) {
      console.warn('Mammoth DOCX parsing error:', e);
      return [''];
    }
  }

  // 2. PDF extraction via Mozilla PDF.js (per-font ToUnicode CMaps + stream & 2-column coordinate modes) + unclipped stream parser
  if (lowerName.endsWith('.pdf') || mimeType === 'application/pdf') {
    try {
      const { streamText, columnSortedText } = await extractTextWithPdfJs(buffer);
      if (columnSortedText.trim().length > 0) candidates.push(columnSortedText);
      if (streamText.trim().length > 0 && streamText !== columnSortedText) {
        candidates.push(streamText);
      }
    } catch {
      // Fallback to unclipped PDF stream parser below
    }

    try {
      const fallbackPdf = extractTextFromPdfBufferFallback(buffer);
      if (fallbackPdf.trim().length > 0) {
        candidates.push(fallbackPdf);
      }
    } catch (e) {
      console.warn('PDF fallback text parser warning:', e);
    }

    return candidates.length > 0 ? candidates : [''];
  }

  const utf8Text = buffer
    .toString('utf-8')
    .replace(/[^\x20-\x7E\n\r\u00A0-\u024F\u2022\u2013\u2014]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return [utf8Text];
}

// ============================================================================
// CUSTOMER SERVICE / CUSTOMER SUPPORT ROLE TABLE & MARKING GUIDE ENGINE
// ============================================================================
export interface MarkingPillar {
  label: string;
  tip: string;
  regex: RegExp;
}

export interface CustomerServiceQuestionRow {
  id: string;
  roleCategory: string;
  category: string;
  question: string;
  proposedAnswer: string;
  expectedFocus: string;
  isBehavioralStar: boolean;
  markingPillars: MarkingPillar[];
}

export const CUSTOMER_SERVICE_QUESTION_TABLE: CustomerServiceQuestionRow[] = [
  {
    id: 'cs_q1',
    roleCategory: 'Customer Service',
    category: 'Customer-Focused Introduction',
    question: 'Tell me about yourself.',
    proposedAnswer:
      'I’m a customer-focused professional with experience helping people, solving problems and communicating clearly. In my previous experience, I’ve learned how to stay calm, listen carefully and find practical solutions even when someone is frustrated. One of my strengths is making customers feel heard while still following company policies and procedures. I’m interested in this role because I enjoy helping people and I believe my communication and problem-solving skills would allow me to contribute positively to the team.',
    expectedFocus:
      'Customer-focused mindset, clear communication, staying calm and listening carefully when customers are frustrated, balancing empathy with company policies, and contributing positively to the team.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Customer-focused background & helping people solve problems',
        tip: 'Highlight your passion and experience in helping customers and solving problems.',
        regex:
          /\b(?:customer[\s-]?focused|help(?:ing)?\s+(?:people|customers|clients|others)|support(?:ing)?\s+(?:customers|clients|people)|solv(?:e|ing)\s+(?:problems|issues)|customer\s+(?:service|support|care|success))\b/i,
      },
      {
        label: 'Staying calm, listening carefully & clear communication with frustrated customers',
        tip: 'Mention staying calm, active listening, and clear communication when someone is frustrated.',
        regex:
          /\b(?:stay(?:ing)?\s+calm|calm|listen(?:ing)?(?:\s+carefully|\s+actively)?|communicat(?:e|ing|ion)|patient|patience|frustrated|upset|feel\s+heard|empathy|understand(?:ing)?)\b/i,
      },
      {
        label: 'Finding practical solutions while respecting company policies & procedures',
        tip: 'Explain how you make customers feel heard while following company policies and procedures.',
        regex:
          /\b(?:polic(?:y|ies)|procedure(?:s)?|guideline(?:s)?|standard(?:s)?|rule(?:s)?|practical\s+solution(?:s)?|find(?:ing)?\s+solution(?:s)?|resolv(?:e|ing))\b/i,
      },
      {
        label: 'Interest in the role & contributing positively to the team',
        tip: 'Connect your strengths to how you will contribute positively to the team.',
        regex:
          /\b(?:contribut(?:e|ing)|team|role|position|company|positive(?:ly)?|value|grow(?:th)?|strength(?:s)?)\b/i,
      },
    ],
  },
  {
    id: 'cs_q2',
    roleCategory: 'Customer Service',
    category: 'Motivation for Customer Service',
    question: 'Why do you want to work in customer service?',
    proposedAnswer:
      'I enjoy customer service because I like helping people find solutions. I understand that customers may contact a company when something is confusing, inconvenient or frustrating, so I believe patience and clear communication are important. I also enjoy learning about products and processes so I can give accurate information. I’m looking for a role where I can use those skills while continuing to grow professionally.',
    expectedFocus:
      'Genuine enjoyment of helping people find solutions, empathy/patience and clear communication when issues are confusing or frustrating, learning products/processes for accuracy, and professional growth.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Genuine enjoyment of helping people find solutions',
        tip: 'Express your genuine motivation to help people and resolve their issues.',
        regex:
          /\b(?:enjoy|love|like|passionate|rewarding|fulfilling|help(?:ing)?\s+(?:people|customers|clients|others)|find(?:ing)?\s+solution(?:s)?|solv(?:e|ing))\b/i,
      },
      {
        label: 'Patience, empathy & clear communication when customers face frustration or confusion',
        tip: 'Emphasize patience and clear communication when customers face confusing or frustrating situations.',
        regex:
          /\b(?:patien(?:ce|t)|communicat(?:e|ing|ion)|confus(?:ing|ed)|frustrat(?:ing|ed)|inconvenien(?:t|ce)|calm|empathy|listen(?:ing)?|understand(?:ing)?)\b/i,
      },
      {
        label: 'Learning products & processes to provide accurate information',
        tip: 'Mention learning company products and processes so you can give accurate information.',
        regex:
          /\b(?:product(?:s)?|process(?:es)?|service(?:s)?|system(?:s)?|accurat(?:e|ely)|accuracy|correct\s+information|knowledge|learn(?:ing)?)\b/i,
      },
      {
        label: 'Using skills to grow professionally',
        tip: 'Share how you want to apply your skills while continuing to grow professionally.',
        regex:
          /\b(?:grow(?:th|ing)?|professionally|career|develop(?:ment|ing)?|improv(?:e|ing)|long[\s-]?term|build\s+my\s+skills)\b/i,
      },
    ],
  },
  {
    id: 'cs_q3',
    roleCategory: 'Customer Service',
    category: 'Core Customer Service Strengths',
    question: 'What are your greatest strengths?',
    proposedAnswer:
      'My strongest qualities are patience, communication and problem-solving. I’m comfortable listening carefully before responding, which helps me understand what someone actually needs. I also try to stay organized and focused when several requests come in at once. Most importantly, I don’t give up quickly when a problem requires additional research or another approach.',
    expectedFocus:
      'Patience, communication, and problem-solving; listening carefully before responding; staying organized when multiple requests arrive; and persistence when a problem requires research or another approach.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Core qualities: patience, communication & problem-solving',
        tip: 'Highlight core customer service strengths like patience, communication, and problem-solving.',
        regex:
          /\b(?:patien(?:ce|t)|communicat(?:e|ing|ion)|problem[\s-]?solv(?:ing|er)|empathy|adaptab(?:le|ility)|calm)\b/i,
      },
      {
        label: 'Active listening before responding to understand actual customer needs',
        tip: 'Explain how listening carefully before responding helps you uncover what the customer actually needs.',
        regex:
          /\b(?:listen(?:ing)?|hear(?:ing)?|understand(?:ing)?\s+(?:what|their|the\s+customer)|needs|before\s+responding|attentive|clarify(?:ing)?)\b/i,
      },
      {
        label: 'Staying organized and focused across multiple requests',
        tip: 'Mention staying organized and focused when several customer requests come in at once.',
        regex:
          /\b(?:organiz(?:ed|ing|ation)|focus(?:ed)?|multi(?:ple|\s*tasking)|several\s+requests|prioritiz(?:e|ing)|busy|volume|time\s+management)\b/i,
      },
      {
        label: 'Persistence & willingness to research when a problem needs another approach',
        tip: 'Show persistence—not giving up quickly when an issue requires extra research or a different approach.',
        regex:
          /\b(?:don'?t\s+give\s+up|persist(?:ent|ence)|research(?:ing)?|another\s+approach|alternative|dig\s+deeper|follow\s+through|determined|resourceful|solution)\b/i,
      },
    ],
  },
  {
    id: 'cs_q4',
    roleCategory: 'Customer Service',
    category: 'Stress Management & Prioritization',
    question: 'How do you handle stress?',
    proposedAnswer:
      'When work becomes stressful, I first focus on what needs immediate attention and organize the remaining tasks by priority. I try not to let the pressure affect how I communicate with customers or coworkers. If I need clarification or additional support, I communicate that early rather than allowing a problem to grow. Breaking the workload into manageable steps helps me stay productive and maintain quality.',
    expectedFocus:
      'Focusing on immediate priorities, keeping calm and polite communication with customers/coworkers, asking for clarification or support early, and breaking tasks into manageable steps to maintain quality.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Focusing on immediate attention & organizing tasks by priority',
        tip: 'Explain how you identify what needs immediate attention and prioritize remaining tasks.',
        regex:
          /\b(?:immediate\s+attention|priorit(?:y|ize|izing|ies)|urgent|urgency|important\s+first|organiz(?:e|ing)|triage|order\s+of)\b/i,
      },
      {
        label: 'Maintaining calm, positive communication with customers and coworkers under pressure',
        tip: 'Emphasize that you never let stress negatively affect how you speak with customers or teammates.',
        regex:
          /\b(?:communicat(?:e|ing|ion)|calm|composure|patient|polite|professional|tone|customers\s+or\s+coworkers|team(?:mates)?|pressure)\b/i,
      },
      {
        label: 'Communicating early when clarification or support is needed',
        tip: 'Mention asking for clarification or support early before a small issue grows.',
        regex:
          /\b(?:clarification|support|ask(?:ing)?\s+for\s+help|escalat(?:e|ing)|early|before.*grow|supervisor|team\s+lead|colleague)\b/i,
      },
      {
        label: 'Breaking workload into manageable steps to stay productive and maintain quality',
        tip: 'Describe breaking large workloads into manageable steps to protect quality and accuracy.',
        regex:
          /\b(?:manageable\s+steps|step\s+by\s+step|break(?:ing)?\s+(?:down|the\s+workload|tasks)|productive|productivity|quality|accura(?:cy|te)|focused)\b/i,
      },
    ],
  },
  {
    id: 'cs_q5',
    roleCategory: 'Customer Service',
    category: 'Value Proposition & Professionalism',
    question: 'Why should we hire you?',
    proposedAnswer:
      'You should hire me because I bring strong communication, patience and a genuine focus on solving customer problems. I understand that customer service represents the company, so I take professionalism and accuracy seriously. I’m also willing to learn new systems and processes quickly. I would bring a dependable attitude, a willingness to improve and a strong commitment to giving customers a positive experience.',
    expectedFocus:
      'Strong communication, patience, and focus on solving customer problems; representing the company with professionalism and accuracy; quick learning of systems/processes; and dependability/commitment to positive customer experience.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Strong communication, patience & genuine focus on solving customer problems',
        tip: 'Highlight your communication, patience, and dedication to solving customer problems.',
        regex:
          /\b(?:communicat(?:e|ing|ion)|patien(?:ce|t)|solv(?:e|ing)\s+(?:customer\s+)?problems|help(?:ing)?\s+customers|empathy|listen(?:ing)?)\b/i,
      },
      {
        label: 'Representing the company with professionalism and accuracy',
        tip: 'Acknowledge that customer service represents the company brand, requiring professionalism and accuracy.',
        regex:
          /\b(?:represent(?:s|ing)?\s+the\s+company|professional(?:ism)?|accura(?:cy|te)|brand|reputation|detail|quality|standard(?:s)?)\b/i,
      },
      {
        label: 'Willingness to learn new systems, tools, and processes quickly',
        tip: 'Mention your ability and willingness to learn new CRM systems, tools, and workflows quickly.',
        regex:
          /\b(?:learn(?:ing)?\s+(?:new\s+)?(?:systems|tools|processes|software|quickly)|fast\s+learner|quick\s+learner|adapt(?:able|ability)|crm|coachable|improve)\b/i,
      },
      {
        label: 'Dependable attitude & commitment to a positive customer experience',
        tip: 'Emphasize your reliability, dependable work ethic, and commitment to positive customer experiences.',
        regex:
          /\b(?:dependab(?:le|ility)|reliab(?:le|ility)|commit(?:ted|ment)|positive\s+(?:customer\s+)?experience|satisfaction|dedicat(?:ed|ion)|ethic)\b/i,
      },
    ],
  },
  {
    id: 'cs_q6',
    roleCategory: 'Customer Service',
    category: 'De-Escalation & Difficult Customers (STAR)',
    question: 'Tell me about a time you dealt with a difficult customer.',
    proposedAnswer:
      'Situation: A customer contacted us frustrated because an order had not arrived when expected. Task: My responsibility was to understand what happened and help resolve the issue while following our procedures. Action: I listened carefully without interrupting, apologized for the inconvenience, checked the order information and explained the options available. I also followed up to make sure the correct next step was completed. Result: The customer accepted the solution and the conversation ended much more positively. It reinforced for me that listening and clear communication are extremely important when dealing with difficult situations.',
    expectedFocus:
      'STAR example: Situation/Task with a frustrated customer, Action of listening without interrupting, apologizing, checking details and explaining options within policy, and Result of following up to end on a positive note.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Clear Situation/Task: frustrated or upset customer with a specific issue',
        tip: 'Describe the specific situation where a customer was frustrated or upset (e.g., delayed order, billing issue, service delay).',
        regex:
          /\b(?:situation|customer|client|caller|frustrated|upset|angry|unhappy|dissatisfied|delayed|order|issue|complaint|problem)\b/i,
      },
      {
        label: 'Empathetic Action: listened carefully without interrupting & apologized',
        tip: 'Explain how you listened without interrupting, stayed calm, and acknowledged/apologized for their inconvenience.',
        regex:
          /\b(?:listen(?:ed|ing)?|without\s+interrupting|apologiz(?:ed|ing)|sorry|empath(?:y|ized)|calm(?:ly)?|acknowledged|understood|heard)\b/i,
      },
      {
        label: 'Resolution Action: investigated details, followed procedures & explained options',
        tip: 'Detail the concrete steps you took—checking the account/order, following procedures, explaining options, and following up.',
        regex:
          /\b(?:check(?:ed|ing)|investigat(?:ed|ing)|looked\s+into|verified|option(?:s)?|solution|procedure(?:s)?|polic(?:y|ies)|follow(?:ed)?\s+up|next\s+step(?:s)?)\b/i,
      },
      {
        label: 'Positive Result & Takeaway: customer satisfied and conversation ended positively',
        tip: 'Share the positive outcome—how the customer accepted the solution and left satisfied.',
        regex:
          /\b(?:result|outcome|accepted|positive(?:ly)?|satisfied|happy|thanked|calmed\s+down|resolved|reinforced|learned)\b/i,
      },
    ],
  },
  {
    id: 'cs_q7',
    roleCategory: 'Customer Service',
    category: 'Working Under Pressure (STAR)',
    question: 'Tell me about a time you had to work under pressure.',
    proposedAnswer:
      'Situation: During a particularly busy period, our team received a much higher volume of customer requests than normal. Task: I needed to keep responses moving while making sure customers received accurate information. Action: I organized requests by urgency, handled the most time-sensitive issues first and used our available resources to work efficiently. When something required additional research, I communicated that clearly instead of rushing an incorrect answer. Result: I was able to complete the priority work on time while maintaining professional communication and accuracy.',
    expectedFocus:
      'STAR example: High-volume or urgent situation, organizing requests by urgency, communicating clearly instead of rushing inaccurate answers, and completing priority work on time with accuracy.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Clear Situation/Task: high volume of customer requests or tight deadline',
        tip: 'Describe the busy period, high volume of tickets/calls, or tight deadline that created pressure.',
        regex:
          /\b(?:busy|high(?:er)?\s+volume|surge|peak|pressure|deadline|many\s+requests|queue|backlog|rush|situation|task)\b/i,
      },
      {
        label: 'Triage Action: organized requests by urgency and handled time-sensitive issues first',
        tip: 'Explain how you triaged and organized customer requests by urgency and priority.',
        regex:
          /\b(?:organiz(?:ed|ing)|urgen(?:cy|t)|time[\s-]?sensitive|priorit(?:y|ized|izing)|first|triage|most\s+important|order)\b/i,
      },
      {
        label: 'Quality Action: used resources efficiently & communicated clearly rather than rushing wrong answers',
        tip: 'Show how you protected accuracy—using resources and communicating transparently instead of rushing an incorrect answer.',
        regex:
          /\b(?:accura(?:te|cy)|resources|efficient(?:ly)?|research|communicat(?:ed|ing)|instead\s+of\s+rushing|correct|verified|tools|templates)\b/i,
      },
      {
        label: 'Result: completed priority work on time while maintaining professionalism and accuracy',
        tip: 'Share the result: meeting deadlines/SLAs while keeping accuracy and professional service high.',
        regex:
          /\b(?:result|outcome|on\s+time|completed|resolved|maintained|professional|quality|satisfied|sla|target)\b/i,
      },
    ],
  },
  {
    id: 'cs_q8',
    roleCategory: 'Customer Service',
    category: 'Accountability & Mistake Recovery (STAR)',
    question: 'Tell me about a time you made a mistake with a customer.',
    proposedAnswer:
      'Situation: I once gave a customer incorrect information because I misunderstood part of a process. Task: As soon as I realized the mistake, my responsibility was to correct it quickly and make sure the customer had accurate information. Action: I verified the correct procedure, acknowledged my mistake rather than trying to hide it, contacted the customer with the corrected information and reviewed the process afterward. Result: The customer received the correct guidance, and I changed the way I verified information so I would be less likely to make the same mistake again.',
    expectedFocus:
      'STAR example: Honest mistake with a customer, taking immediate ownership instead of hiding it, verifying the correct procedure and updating the customer promptly, and changing habits to prevent repeating the mistake.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Clear Situation/Task: honest example of a mistake or misunderstanding and responsibility to fix it',
        tip: 'Share a genuine example where a misunderstanding or mistake happened and you realized it needed immediate correction.',
        regex:
          /\b(?:mistake|incorrect|wrong|misunderstood|error|oversight|realized|responsibility|correct\s+it|situation|task)\b/i,
      },
      {
        label: 'Accountability Action: acknowledged and owned the mistake instead of hiding it',
        tip: 'Emphasize taking ownership and acknowledging the mistake honestly rather than hiding it.',
        regex:
          /\b(?:acknowledg(?:ed|ing)|admitted|owned\s+up|ownership|honest(?:ly)?|apologiz(?:ed|ing)|rather\s+than\s+(?:trying\s+to\s+)?hid(?:e|ing)|accountab(?:le|ility))\b/i,
      },
      {
        label: 'Correction Action: verified the right procedure and contacted the customer with accurate info',
        tip: 'Explain how you verified the right procedure and promptly followed up with the customer with accurate information.',
        regex:
          /\b(?:verif(?:ied|ying)|correct\s+(?:procedure|information|guidance)|contacted|reached\s+out|updated|informed|fixed|resolved|checked)\b/i,
      },
      {
        label: 'Result & Prevention: customer received accurate guidance & improved verification process',
        tip: 'Share what you changed in your workflow afterward so you would not repeat the same mistake.',
        regex:
          /\b(?:result|learned|changed|prevent|again|double[\s-]?check|checklist|review(?:ed)?|appreciated|trust|accurate\s+guidance)\b/i,
      },
    ],
  },
  {
    id: 'cs_q9',
    roleCategory: 'Customer Service',
    category: 'Complex Problem Solving (STAR)',
    question: 'Describe a time you solved a difficult problem.',
    proposedAnswer:
      'Situation: I once handled a customer issue that could not be resolved through the normal first step. Task: I needed to find a practical solution without giving the customer inaccurate information. Action: I gathered the relevant details, checked our available resources, reviewed the possible options and asked for clarification when necessary. I then explained the solution and next steps clearly to the customer. Result: The issue was resolved, and the experience helped me become more comfortable researching problems instead of immediately assuming there was no solution.',
    expectedFocus:
      'STAR example: Complex issue beyond standard first step, gathering details and researching resources/asking for clarification, explaining the solution and next steps clearly, and resolving the problem.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Clear Situation/Task: complex or non-standard customer problem requiring deeper investigation',
        tip: 'Describe a challenging customer problem that could not be solved by the normal first step.',
        regex:
          /\b(?:difficult|complex|unusual|non[\s-]?standard|normal\s+first\s+step|challenging|issue|problem|couldn'?t\s+be\s+resolved|situation|task)\b/i,
      },
      {
        label: 'Investigation Action: gathered details, researched resources & asked for clarification',
        tip: 'Explain how you gathered details, checked knowledge bases/resources, and asked for clarification where needed.',
        regex:
          /\b(?:gather(?:ed|ing)|details|research(?:ed|ing)?|resources|knowledge\s+base|options|clarification|investigat(?:ed|ing)|checked|collaborated)\b/i,
      },
      {
        label: 'Communication Action: explained the practical solution and clear next steps to the customer',
        tip: 'Mention how you communicated the practical solution and clear next steps to the customer.',
        regex:
          /\b(?:explain(?:ed|ing)|next\s+steps|clearly|practical\s+solution|walked\s+them\s+through|guided|communicated|options)\b/i,
      },
      {
        label: 'Result & Growth: issue resolved and stronger confidence in researching tough problems',
        tip: 'Share the outcome—how the issue was resolved and how it strengthened your problem-solving skills.',
        regex:
          /\b(?:resolved|solved|fixed|result|outcome|comfortable\s+researching|learned|confident|satisfied|happy)\b/i,
      },
    ],
  },
  {
    id: 'cs_q10',
    roleCategory: 'Customer Service',
    category: 'Turning Negative into Positive (STAR)',
    question: 'Tell me about a time you turned a negative customer experience into a positive one.',
    proposedAnswer:
      'Situation: A customer contacted us disappointed because their expectations had not been met. Task: My goal was not only to address the practical issue but also to rebuild their confidence. Action: I listened carefully, acknowledged the concern, explained what I could do and followed through on the solution I promised. I also made sure the customer understood the next step rather than ending the conversation abruptly. Result: The customer became much more satisfied with the interaction, and it reminded me that follow-through can be just as important as the initial solution.',
    expectedFocus:
      'STAR example: Disappointed customer whose expectations were not met, aiming to fix the issue and rebuild confidence, listening/acknowledging and following through on promised solutions with clear next steps, resulting in customer satisfaction.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Clear Situation/Task: disappointed customer & goal to rebuild their trust/confidence',
        tip: 'Describe the negative starting point (disappointed customer) and your goal to both solve the issue and rebuild their confidence.',
        regex:
          /\b(?:disappointed|negative|unhappy|frustrated|expectations|rebuild|confidence|trust|turn(?:ed)?\s+around|situation|task)\b/i,
      },
      {
        label: 'Empathetic Action: listened carefully and acknowledged the customer’s concern',
        tip: 'Explain how you listened carefully and validated/acknowledged the customer’s concern.',
        regex:
          /\b(?:listen(?:ed|ing)?|acknowledg(?:ed|ing)|empath(?:y|ized)|apologiz(?:ed|ing)|validated|understood|concern)\b/i,
      },
      {
        label: 'Follow-Through Action: explained what could be done, followed through on promises & clarified next steps',
        tip: 'Detail how you followed through on the promised solution and ensured the customer knew the next steps.',
        regex:
          /\b(?:follow(?:ed)?\s+through|promis(?:ed|e)|next\s+step(?:s)?|explained\s+what\s+i\s+could\s+do|solution|kept\s+them\s+updated|resolved)\b/i,
      },
      {
        label: 'Positive Result: customer became satisfied & reinforced the importance of follow-through',
        tip: 'Highlight the turnaround result—how the customer left satisfied and their confidence was restored.',
        regex:
          /\b(?:satisfied|positive|happy|appreciated|thanked|loyal|restored|result|outcome|reminded|important)\b/i,
      },
    ],
  },
];

// Sync the 10 Customer Service questions to Supabase customer_service_questions table if configured
async function seedCustomerServiceQuestionsToSupabase(): Promise<{
  seeded: boolean;
  error?: string;
}> {
  if (!getSupabaseConfig()) {
    return {
      seeded: false,
      error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured.',
    };
  }

  const toRow = (row: CustomerServiceQuestionRow) => ({
    id: row.id,
    role_category: row.roleCategory,
    category: row.category,
    question_text: row.question,
    proposed_answer: row.proposedAnswer,
    expected_focus: row.expectedFocus,
    is_behavioral_star: row.isBehavioralStar,
  });

  // Legacy table (Customer Service only) kept for backward compatibility.
  const legacy = await postgrestUpsert(
    'customer_service_questions',
    CUSTOMER_SERVICE_QUESTION_TABLE.map(toRow),
    'id'
  );

  // All banks (Universal first question, Customer Service, Virtual Assistant, Technical Support).
  const all = await postgrestUpsert(
    'interview_questions',
    ALL_STANDARD_QUESTION_ROWS.map((row) => ({
      ...toRow(row),
      alternative_wordings: row.id === UNIVERSAL_FIRST_QUESTION_ROW.id ? UNIVERSAL_FIRST_QUESTION_VARIANTS : [],
      marking_points: row.markingPillars.map((p) => p.label),
    })),
    'id'
  );

  // One table per role, like customer_service_questions.
  const withPoints = (row: CustomerServiceQuestionRow) => ({
    ...toRow(row),
    marking_points: row.markingPillars.map((p) => p.label),
  });
  const va = await postgrestUpsert(
    'virtual_assistant_questions',
    VIRTUAL_ASSISTANT_QUESTION_TABLE.map(withPoints),
    'id'
  );
  const ts = await postgrestUpsert(
    'technical_support_questions',
    TECHNICAL_SUPPORT_QUESTION_TABLE.map(withPoints),
    'id'
  );

  if (!all.saved || !va.saved || !ts.saved) {
    return { seeded: false, error: all.error || va.error || ts.error || legacy.error };
  }
  return { seeded: true };
}

async function fetchShuffledCustomerServiceQuestionsFromSupabase(
  maxQuestions = 5
): Promise<ResumeExaminationResult['questions']> {
  const config = getSupabaseConfig();
  if (config) {
    try {
      await seedCustomerServiceQuestionsToSupabase();
      const resp = await fetch(
        `${config.url}/rest/v1/customer_service_questions?select=id,category,question_text,proposed_answer,expected_focus,is_behavioral_star`,
        {
          method: 'GET',
          headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            Accept: 'application/json',
          },
        }
      );

      if (resp.ok) {
        const rows = await resp.json();
        if (Array.isArray(rows) && rows.length >= maxQuestions) {
          const pool = [...rows];
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
          }
          return pool.slice(0, maxQuestions).map((r: any, idx: number) => ({
            id: r.id || `cs_q${idx + 1}`,
            number: idx + 1,
            category: r.category || 'Customer Service',
            question: r.question_text,
            expectedFocus: r.expected_focus,
            proposedAnswer: r.proposed_answer,
            isBehavioralStar: Boolean(r.is_behavioral_star),
          }));
        }
      }
    } catch {
      // Fallback to local Customer Service table below
    }
  }
  return selectShuffledCustomerServiceQuestions(maxQuestions);
}

export function isCustomerServiceOrSupportRole(role: string): boolean {
  const r = (role || '').toLowerCase();
  return /\b(?:customer\s+(?:service|support|success|care|experience|relations)|client\s+(?:service|services|support|success|care|relations)|(?:customer\s+)?success\s*(?:&|and)?\s*support|support\s*(?:&|and)?\s*success|call\s+center|contact\s+center|help\s*desk|service\s+desk|technical\s+support|support\s+(?:specialist|representative|agent|associate|advisor|coordinator|lead))\b/i.test(
    r
  );
}

/**
 * Randomly shuffles the 10-question Customer Service table using Fisher-Yates
 * so questions are NEVER asked in a fixed chronological order, and selects
 * at most 5 questions (`maxQuestions = 5`) for the 10-minute interview session.
 */
export function selectShuffledCustomerServiceQuestions(
  maxQuestions = 5
): ResumeExaminationResult['questions'] {
  const pool = [...CUSTOMER_SERVICE_QUESTION_TABLE];

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = pool[i];
    pool[i] = pool[j];
    pool[j] = temp;
  }

  return pool.slice(0, maxQuestions).map((item, idx) => ({
    id: item.id,
    number: idx + 1,
    category: item.category,
    question: item.question,
    expectedFocus: item.expectedFocus,
    proposedAnswer: item.proposedAnswer,
    isBehavioralStar: item.isBehavioralStar,
  }));
}

export const UNIVERSAL_FIRST_QUESTION_ROW: CustomerServiceQuestionRow = {
  id: 'universal_q1',
  roleCategory: 'Universal First Question',
  category: 'Professional Experience & Role Fit',
  question: 'Walk me through your professional experience and why are you the best fit for this job?',
  proposedAnswer:
    'Over my professional career, I have developed strong practical experience in organizing workflows, solving problems, and communicating clearly with teams and clients. I take pride in being dependable, detail-oriented, and quick to master new tools and responsibilities. What makes me the best fit for this job is my ability to deliver accurate work under deadlines while maintaining a positive, professional attitude. I am excited to bring my skills to this position, support the team\'s goals, and make an immediate, positive impact.',
  expectedFocus:
    'Clear overview of relevant professional experience, practical strengths in organization and communication, ability to learn tools quickly and meet deadlines, and compelling alignment on why you are the best fit for this position.',
  isBehavioralStar: false,
  markingPillars: [
    {
      label: 'Relevant professional experience & background',
      tip: 'Walk through your relevant professional experience and key responsibilities.',
      regex:
        /\b(?:experience|background|career|work(?:ed|ing)?|role|history|field|track\s+record|professional)\b/i,
    },
    {
      label: 'Core practical strengths: organization, communication & problem-solving',
      tip: 'Highlight core strengths like organization, clear communication, or problem-solving.',
      regex:
        /\b(?:strength(?:s)?|organi[sz](?:ed|ation|ing)|communicat(?:e|ion|ing)|problem[\s-]?solv(?:e|ing|er)|detail[\s-]?oriented|dependab(?:le|ility)|accura(?:cy|te))\b/i,
    },
    {
      label: 'Adaptability, learning tools & managing deadlines',
      tip: 'Mention your ability to learn tools quickly and deliver accurate work under deadlines.',
      regex:
        /\b(?:learn(?:ing)?|tool(?:s)?|system(?:s)?|software|deadline(?:s)?|time\s+management|adapt(?:able|ability)?|priority|priorities)\b/i,
    },
    {
      label: 'Fit for the position & making a positive team impact',
      tip: 'Explain why you are the best fit and how you will make a positive impact on the team.',
      regex:
        /\b(?:best\s+fit|fit\s+for|contribut(?:e|ing)|team|impact|value|excite(?:d)?|goal(?:s)?|hire\s+me)\b/i,
    },
  ],
};

export const VIRTUAL_ASSISTANT_QUESTION_TABLE: CustomerServiceQuestionRow[] = [
  {
    id: 'va_q1',
    roleCategory: 'Virtual Assistant',
    category: 'Organization, Time Management & Core VA Skills',
    question: 'Tell me about yourself.',
    proposedAnswer:
      'I’m an organized and dependable professional who enjoys keeping tasks, information and communication moving efficiently. My strengths include attention to detail, time management and learning new tools quickly. I’m comfortable working with documents, schedules, email, data and multiple priorities. I’m interested in administrative or virtual assistant work because I enjoy creating structure and making it easier for a team to stay organized and productive.',
    expectedFocus:
      'Organized and dependable mindset, attention to detail, time management, quick learning of new software, comfort with schedules, email, data, and creating structure to keep a team productive.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Organized and dependable professional managing tasks & communication',
        tip: 'Highlight your organizational skills, dependability, and experience managing communications.',
        regex:
          /\b(?:organiz(?:ed|ing|ation)|dependab(?:le|ility)|task(?:s)?|information|communicat(?:e|ion|ing)|efficient(?:ly)?)\b/i,
      },
      {
        label: 'Attention to detail, time management & learning new tools quickly',
        tip: 'Emphasize your attention to detail, time management, and ability to master software quickly.',
        regex:
          /\b(?:attention\s+to\s+detail|detail(?:s)?|time\s+management|learn(?:ing)?\s+new\s+tools|quick\s+learner|software)\b/i,
      },
      {
        label: 'Comfort with documents, schedules, email, data & multiple priorities',
        tip: 'Mention your day-to-day comfort handling documents, calendars, email, data, and multitasking.',
        regex:
          /\b(?:document(?:s)?|schedule(?:s)?|calendar(?:s)?|email(?:s)?|data|priorit(?:y|ies)|multi(?:ple|\s*tasking))\b/i,
      },
      {
        label: 'Creating structure to make a team organized and productive',
        tip: 'Explain how you create structure and make it easier for a team to stay productive.',
        regex:
          /\b(?:creat(?:e|ing)\s+structure|structure|team|productive|productivity|stay\s+organized|support)\b/i,
      },
    ],
  },
  {
    id: 'va_q2',
    roleCategory: 'Virtual Assistant',
    category: 'Urgency, Deadlines & Work Prioritization',
    question: 'How do you prioritize your work?',
    proposedAnswer:
      'I prioritize tasks based on urgency, importance and deadlines. I first identify anything time-sensitive or affecting other people, then I organize the remaining work into a clear list. If two priorities conflict, I communicate with the appropriate person rather than making assumptions. I also leave some flexibility for unexpected requests while still protecting important deadlines.',
    expectedFocus:
      'Prioritization based on urgency, importance, and deadlines; identifying time-sensitive items affecting others first; proactive communication when priorities clash; and flexibility for unexpected tasks.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Prioritizing based on urgency, importance and deadlines',
        tip: 'Explain how you evaluate urgency, importance, and deadlines across your task list.',
        regex:
          /\b(?:urgency|urgent|importance|important|deadline(?:s)?|priorit(?:y|ize|izing|ies))\b/i,
      },
      {
        label: 'Identifying time-sensitive items affecting other people first',
        tip: 'Note that you first identify items that are time-sensitive or that unblock other team members.',
        regex:
          /\b(?:time[\s-]?sensitive|affecting\s+other(?:s|people)|unblock|first|clear\s+list|list)\b/i,
      },
      {
        label: 'Communicating proactively rather than making assumptions during conflict',
        tip: 'Highlight that when priorities conflict, you communicate directly rather than guessing.',
        regex:
          /\b(?:communicat(?:e|ing)|conflict(?:s)?|appropriate\s+person|clarif(?:y|ication)|assumptions?|ask(?:ing)?)\b/i,
      },
      {
        label: 'Maintaining flexibility for unexpected requests while protecting deadlines',
        tip: 'Mention leaving buffer room for unexpected requests while shielding core deliverables.',
        regex:
          /\b(?:flexib(?:le|ility)|unexpected|buffer|protect(?:ing)?|deliver(?:y|ing)?|schedule)\b/i,
      },
    ],
  },
  {
    id: 'va_q3',
    roleCategory: 'Virtual Assistant',
    category: 'Attention to Detail & Quality Review',
    question: 'How do you make sure your work is accurate?',
    proposedAnswer:
      'I build a review step into my workflow rather than assuming the first version is perfect. Depending on the task, I check names, numbers, dates, formatting and source information, and I use tools such as spellcheck when appropriate. For important work, I do a final review from the perspective of the person who will receive it. This helps me catch small errors before they become bigger problems.',
    expectedFocus:
      'Building an intentional review step into the workflow; verifying names, numbers, dates, formatting, and source data; leveraging tools; and reviewing through the recipient\'s perspective to catch errors early.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Building a review step into the workflow',
        tip: 'Describe how you build an intentional review step instead of assuming the first draft is perfect.',
        regex:
          /\b(?:review\s+step|review(?:ing)?|check(?:ing)?|workflow|double[\s-]?check|audit|first\s+version)\b/i,
      },
      {
        label: 'Auditing names, numbers, dates, formatting & source information',
        tip: 'Mention specific checks: names, numbers, dates, formatting, and source data.',
        regex:
          /\b(?:name(?:s)?|number(?:s)?|date(?:s)?|format(?:ting)?|source|data|information)\b/i,
      },
      {
        label: 'Utilizing proofreading & validation tools (e.g. spellcheck)',
        tip: 'Point to using tools like spellcheck, formulas, or formatting tools.',
        regex:
          /\b(?:spellcheck|proofread(?:ing)?|tool(?:s)?|validation|grammarly|accuracy)\b/i,
      },
      {
        label: 'Reviewing through the recipient\'s perspective to catch errors early',
        tip: 'Explain doing a final pass from the recipient\'s viewpoint to catch issues before delivery.',
        regex:
          /\b(?:recipient|perspective|receive(?:r)?|catch\s+(?:small\s+)?errors?|before.*problem|client\s+view)\b/i,
      },
    ],
  },
  {
    id: 'va_q4',
    roleCategory: 'Virtual Assistant',
    category: 'Software Adaptability & Self-Guided Learning',
    question: 'How do you learn a new software tool quickly?',
    proposedAnswer:
      'When I need to learn a new tool, I first identify the tasks I will actually need to perform with it. I learn the basic workflow, practice those tasks and use documentation or tutorials when I get stuck. I also take notes on important steps so I don’t have to repeatedly ask the same question. Once I understand the basics, I look for shortcuts and features that improve efficiency.',
    expectedFocus:
      'Targeting required tasks first, practicing core workflows with documentation/tutorials, taking structured notes to retain steps, and looking for shortcuts/features that improve efficiency.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Identifying specific tasks required for the workflow',
        tip: 'Explain how you target the specific tasks and workflows you actually need to perform.',
        regex:
          /\b(?:identify\s+tasks?|specific\s+tasks?|actual(?:ly)?\s+need|workflow|use\s+case)\b/i,
      },
      {
        label: 'Hands-on practice using documentation and tutorials',
        tip: 'Mention practicing the basics and referencing documentation, video tutorials, or guides.',
        regex:
          /\b(?:practic(?:e|ing)|documentation|tutorial(?:s)?|guide(?:s)?|hands[\s-]?on|learn\s+the\s+basic)\b/i,
      },
      {
        label: 'Taking structured notes to remember key steps independently',
        tip: 'Emphasize taking notes on key steps so you retain them and work independently.',
        regex:
          /\b(?:take\s+notes?|notetaking|documentation|steps?|repeatedly\s+ask|independent(?:ly)?)\b/i,
      },
      {
        label: 'Finding shortcuts and features to improve efficiency',
        tip: 'Share how you look for shortcuts and advanced features to boost overall speed and quality.',
        regex:
          /\b(?:shortcut(?:s)?|feature(?:s)?|efficien(?:t|cy)|speed|optimize|productivity)\b/i,
      },
    ],
  },
  {
    id: 'va_q5',
    roleCategory: 'Virtual Assistant',
    category: 'Reliability, Administrative Value & Adaptability',
    question: 'Why should we hire you?',
    proposedAnswer:
      'You should hire me because I’m organized, dependable and focused on completing work accurately. I understand that administrative support often involves many small details, deadlines and communication points, and I take those responsibilities seriously. I’m also comfortable learning new systems and adjusting when priorities change. My goal would be to become someone the team can trust to keep tasks moving and details under control.',
    expectedFocus:
      'Organized and dependable mindset; taking ownership of small details, deadlines, and communications; adaptability to new systems; and becoming a trusted partner who keeps tasks under control.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Organized, dependable and focused on accuracy',
        tip: 'Highlight that you are organized, dependable, and focused on accurate deliverables.',
        regex:
          /\b(?:organiz(?:ed|ation)|dependab(?:le|ility)|accura(?:te|cy)|reliable|consistent)\b/i,
      },
      {
        label: 'Taking ownership of small details, deadlines & communication points',
        tip: 'Acknowledge the importance of managing small details, deadlines, and team communications.',
        regex:
          /\b(?:small\s+details?|deadline(?:s)?|communicat(?:e|ion|ing)|responsibilit(?:y|ies)|serious(?:ly)?)\b/i,
      },
      {
        label: 'Comfortable learning new systems and adjusting when priorities change',
        tip: 'Show adaptability when systems change or priorities shift throughout the day.',
        regex:
          /\b(?:learn(?:ing)?\s+new\s+systems?|adjust(?:ing)?|priorit(?:y|ies)\s+change|adaptab(?:le|ility)|flexib(?:le|ility))\b/i,
      },
      {
        label: 'Becoming someone the team can trust to keep tasks under control',
        tip: 'Express your goal of becoming a trusted contributor who keeps operations moving smoothly.',
        regex:
          /\b(?:trust(?:ed)?|keep\s+tasks?\s+moving|under\s+control|asset|contribut(?:e|ing)|team)\b/i,
      },
    ],
  },
  {
    id: 'va_q6',
    roleCategory: 'Virtual Assistant',
    category: 'Managing Multiple Deadlines (STAR)',
    question: 'Tell me about a time you had multiple deadlines at once.',
    proposedAnswer:
      'Situation: I had several important assignments with deadlines that were close together. Task: I needed to complete each one accurately without allowing one deadline to interfere with another. Action: I listed all deliverables, identified which tasks were most urgent and which depended on other work, and then created a schedule with focused blocks of time. When I saw a potential conflict, I communicated early instead of waiting until the deadline was close. Result: I completed the priority work on time and maintained quality across the remaining assignments.',
    expectedFocus:
      'STAR example: several close deadlines, listing deliverables, identifying urgency and dependencies, scheduling focused time blocks, communicating potential conflicts early, and delivering priority work on time without losing quality.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: several close deadlines that all had to be met accurately',
        tip: 'Set the scene: several important assignments with deadlines close together, each needing to be done accurately.',
        regex:
          /\b(?:deadlines?|assignments?|several|multiple|close\s+together|overlapp(?:ed|ing)|same\s+(?:time|week|day)|accurate(?:ly)?)\b/i,
      },
      {
        label: 'Action: listed deliverables, judged urgency & dependencies, scheduled focused time blocks',
        tip: 'Explain how you listed every deliverable, worked out what was most urgent or dependent on other work, and scheduled focused blocks of time.',
        regex:
          /\b(?:list(?:ed)?|deliverables?|urgen(?:t|cy)|depend(?:ed|ent|ency|encies|s)?|schedul(?:e|ed)|time\s+blocks?|blocks?\s+of\s+time|priorit(?:y|ized|ised|ies))\b/i,
      },
      {
        label: 'Action: communicated potential conflicts early instead of waiting',
        tip: 'Mention that when you saw a potential conflict you raised it early rather than waiting until the deadline was close.',
        regex:
          /\b(?:communicat(?:e|ed|ing)|early|conflict|let\s+(?:them|my\s+\w+)\s+know|informed|flagged|raised|update(?:d)?)\b/i,
      },
      {
        label: 'Result: priority work delivered on time with quality maintained',
        tip: 'Close with the result: the priority work was completed on time and the quality of the remaining work was maintained.',
        regex:
          /\b(?:on\s+time|completed|delivered|met\s+(?:all|every|the)|quality|result|finished|successfully)\b/i,
      },
    ],
  },
  {
    id: 'va_q7',
    roleCategory: 'Virtual Assistant',
    category: 'Catching Mistakes & Quality Control (STAR)',
    question: 'Describe a time you caught an important mistake before it caused a problem.',
    proposedAnswer:
      'Situation: While reviewing a document before it was finalized, I noticed that one piece of information did not match the original source. Task: I needed to determine whether it was an error and correct it before the document moved forward. Action: I went back to the source, verified the information and updated the document before submission. I then reviewed the surrounding information to make sure there were no related errors. Result: The mistake was corrected before it caused a problem, and it reinforced for me why a final quality check is important even when a task appears finished.',
    expectedFocus:
      'STAR example: noticing a mismatch during a review, checking it against the original source, correcting it before submission, reviewing related information for further errors, and valuing a final quality check.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation: noticed information that did not match during a review',
        tip: 'Describe how you spotted something that did not match (for example during a review before a document was finalized).',
        regex:
          /\b(?:notic(?:e|ed)|spotted|caught|found|review(?:ed|ing)?|did\s*n[o']?t\s+match|mismatch|discrepanc(?:y|ies)|incorrect|error|mistake|wrong)\b/i,
      },
      {
        label: 'Action: went back to the source and verified the information',
        tip: 'Explain that you went back to the original source and verified the information before changing anything.',
        regex:
          /\b(?:source|verif(?:y|ied|ying)|confirm(?:ed)?|double[\s-]?check(?:ed)?|cross[\s-]?check(?:ed)?|checked|original)\b/i,
      },
      {
        label: 'Action: corrected it before submission & checked for related errors',
        tip: 'Mention correcting the document before it moved forward, then reviewing the surrounding information for related errors.',
        regex:
          /\b(?:correct(?:ed)?|fix(?:ed)?|updat(?:e|ed)|amend(?:ed)?|before\s+(?:it\s+was\s+)?(?:submi(?:t|ssion|tted)|sent|finali[sz]ed|moved\s+forward)|related\s+errors?|surrounding)\b/i,
      },
      {
        label: 'Result: problem prevented & value of a final quality check',
        tip: 'Close with the result: the mistake was fixed before it caused a problem, and what it taught you about final quality checks.',
        regex:
          /\b(?:prevent(?:ed)?|avoid(?:ed)?|before\s+it\s+caused|quality\s+check|final\s+(?:check|review)|learn(?:ed|t)|reinforced|result|lesson)\b/i,
      },
    ],
  },
  {
    id: 'va_q8',
    roleCategory: 'Virtual Assistant',
    category: 'Organizing a Difficult Task (STAR)',
    question: 'Describe a time you had to organize a difficult task.',
    proposedAnswer:
      'Situation: I was given a task that involved several pieces of information and multiple steps, and it initially felt difficult to organize. Task: I needed to create enough structure to complete it accurately and on time. Action: I broke the project into smaller steps, created a checklist, identified which items depended on others and tracked progress as I worked. Result: The task became much more manageable, I was able to keep track of the details and the work was completed successfully.',
    expectedFocus:
      'STAR example: a complex multi-step task, creating structure, breaking it into smaller steps, using a checklist, identifying dependencies, tracking progress, and completing it accurately and on time.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: a complex, multi-step task that needed structure',
        tip: 'Describe a task with many pieces of information or steps that was hard to organize at first.',
        regex:
          /\b(?:difficult|complex|complicated|challenging|multiple\s+steps|several\s+(?:pieces|parts|steps)|overwhelming|large|structure|organi[sz]e)\b/i,
      },
      {
        label: 'Action: broke it into smaller steps and created a checklist',
        tip: 'Explain how you broke the work into smaller steps and created a checklist or plan.',
        regex:
          /\b(?:br(?:oke|eak|eaking)\s+(?:it|the\s+\w+)?\s*(?:down|into)|smaller\s+(?:steps|tasks|parts)|checklist|to[\s-]?do\s+list|plan(?:ned)?|step[\s-]?by[\s-]?step)\b/i,
      },
      {
        label: 'Action: identified dependencies and tracked progress',
        tip: 'Mention identifying which items depended on others and tracking your progress as you worked.',
        regex:
          /\b(?:depend(?:ed|ent|ency|encies|s)?|track(?:ed|ing)?|progress|spreadsheet|tracker|monitor(?:ed)?|order|sequence)\b/i,
      },
      {
        label: 'Result: task became manageable and was completed successfully',
        tip: 'Close with the result: the task became manageable, details stayed under control, and it was completed successfully.',
        regex:
          /\b(?:manageable|completed|successfully|on\s+time|result|finished|delivered|kept\s+track|accurate(?:ly)?)\b/i,
      },
    ],
  },
  {
    id: 'va_q9',
    roleCategory: 'Virtual Assistant',
    category: 'Working Independently (STAR)',
    question: 'Tell me about a time you had to work independently.',
    proposedAnswer:
      "Situation: I was assigned a task while the person who normally provided guidance was not immediately available. Task: I needed to keep the work moving without making decisions outside my responsibility. Action: I reviewed the information I already had, used available resources to answer routine questions and identified the few items that genuinely required clarification. I communicated those questions clearly and continued with the work I could complete independently. Result: The task was completed successfully and I became more confident in knowing when to act independently and when to ask for help.",
    expectedFocus:
      'STAR example: working without immediate guidance, keeping work moving within your responsibility, using available resources for routine questions, isolating the few items needing clarification, communicating clearly, and knowing when to ask for help.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: no immediate guidance, but work had to keep moving within your responsibility',
        tip: 'Describe a time your usual guidance was unavailable and you had to keep work moving without overstepping your responsibility.',
        regex:
          /\b(?:independent(?:ly)?|on\s+my\s+own|without\s+(?:guidance|supervision|help)|not\s+(?:immediately\s+)?available|away|unavailable|responsibilit(?:y|ies)|keep\s+(?:the\s+)?work\s+moving)\b/i,
      },
      {
        label: 'Action: used available information & resources for routine questions',
        tip: 'Explain how you reviewed the information you already had and used available resources to answer routine questions yourself.',
        regex:
          /\b(?:review(?:ed)?|resources?|information\s+i\s+(?:already\s+)?had|documentation|notes|guides?|research(?:ed)?|figured\s+out|routine)\b/i,
      },
      {
        label: 'Action: identified what truly needed clarification and communicated it clearly',
        tip: 'Mention that you identified the few items that genuinely needed clarification and communicated those questions clearly.',
        regex:
          /\b(?:clarif(?:y|ication|ied)|questions?|communicat(?:e|ed|ing)|ask(?:ed)?|email(?:ed)?|messag(?:e|ed)|follow(?:ed)?\s+up)\b/i,
      },
      {
        label: 'Result: task completed & confidence in when to act alone vs. ask for help',
        tip: 'Close with the result: the task was completed and you learned when to act independently and when to ask for help.',
        regex:
          /\b(?:completed|successfully|confiden(?:t|ce)|when\s+to\s+(?:act|ask)|ask\s+for\s+help|result|learn(?:ed|t)|finished)\b/i,
      },
    ],
  },
  {
    id: 'va_q10',
    roleCategory: 'Virtual Assistant',
    category: 'Learning a New Tool Quickly (STAR)',
    question: 'Tell me about a time you had to learn a new tool quickly.',
    proposedAnswer:
      'Situation: I was asked to use a software tool that I had not worked with before. Task: I needed to learn the functions required for my work quickly so the project would not be delayed. Action: I focused first on the specific tasks I needed to perform, used available tutorials and documentation, practiced the workflow and wrote down important steps. Once I was comfortable with the basics, I explored shortcuts that could improve my efficiency. Result: I became productive with the tool quickly and was able to complete the required work without depending on someone else for every step.',
    expectedFocus:
      'STAR example: unfamiliar software needed quickly, focusing on the tasks actually required, using tutorials and documentation, practicing and writing down steps, exploring shortcuts, and becoming productive without depending on others.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: unfamiliar tool that had to be learned quickly to avoid delays',
        tip: 'Describe the new tool you had never used before and why you needed to learn it quickly.',
        regex:
          /\b(?:new\s+(?:tool|software|system|platform|app)|never\s+(?:used|worked)|had\s+not\s+(?:used|worked)|unfamiliar|quickly|delay(?:ed)?)\b/i,
      },
      {
        label: 'Action: focused on required tasks using tutorials & documentation',
        tip: 'Explain how you focused on the specific tasks you needed first and used tutorials or documentation.',
        regex:
          /\b(?:specific\s+tasks?|tasks?\s+i\s+needed|tutorials?|documentation|videos?|guides?|help\s+(?:articles|center)|youtube|course)\b/i,
      },
      {
        label: 'Action: practiced the workflow, noted key steps, then explored shortcuts',
        tip: 'Mention practicing the workflow, writing down important steps, and later exploring shortcuts to work faster.',
        regex:
          /\b(?:practic(?:e|ed|ing)|wrote\s+down|notes?|steps?|shortcuts?|features?|efficien(?:t|cy)|hands[\s-]?on)\b/i,
      },
      {
        label: 'Result: became productive quickly without depending on others',
        tip: 'Close with the result: you became productive quickly and completed the work without relying on someone else for every step.',
        regex:
          /\b(?:productive|proficient|comfortable|without\s+(?:depending|relying|help)|independent(?:ly)?|result|completed|quickly)\b/i,
      },
    ],
  },
];

export const TECHNICAL_SUPPORT_QUESTION_TABLE: CustomerServiceQuestionRow[] = [
  {
    id: 'it_q1',
    roleCategory: 'Technical Support',
    category: 'Technical Support Introduction',
    question: 'Tell me about yourself.',
    proposedAnswer:
      'I’m a technically minded professional who enjoys troubleshooting problems and helping people use technology effectively. I’m comfortable researching issues, following logical troubleshooting steps and learning new systems. I also understand that technical support is not only about fixing the technology — it is about communicating clearly with the person experiencing the problem. I’m interested in this role because it would allow me to combine problem-solving with customer support.',
    expectedFocus:
      'Technically minded, enjoys troubleshooting and helping people use technology, researching issues and following logical steps, learning new systems, communicating clearly with users, and combining problem-solving with customer support.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Technically minded & enjoys troubleshooting problems',
        tip: 'Introduce yourself as someone technically minded who enjoys troubleshooting and solving technical problems.',
        regex:
          /\b(?:technical(?:ly)?|technology|tech|troubleshoot(?:ing)?|it\b|computers?|systems?|hardware|software|problem[\s-]?solv(?:e|ing))\b/i,
      },
      {
        label: 'Research, logical troubleshooting steps & learning new systems',
        tip: 'Mention being comfortable researching issues, following logical troubleshooting steps and learning new systems.',
        regex:
          /\b(?:research(?:ing)?|logical|step[\s-]?by[\s-]?step|steps|methodical|learn(?:ing)?\s+new|new\s+systems?|diagnos(?:e|ing))\b/i,
      },
      {
        label: 'Support is also about communicating clearly with the user',
        tip: 'Show you understand support is not only fixing technology but communicating clearly with the person affected.',
        regex:
          /\b(?:communicat(?:e|ing|ion)|clear(?:ly)?|users?|people|explain(?:ing)?|person\s+experiencing|patient|patience)\b/i,
      },
      {
        label: 'Motivation: combining problem-solving with customer support',
        tip: 'Explain why this role interests you — combining problem-solving with helping customers.',
        regex:
          /\b(?:interested|combine|customer\s+support|help(?:ing)?\s+(?:people|users|customers)|this\s+role|enjoy|passion(?:ate)?)\b/i,
      },
    ],
  },
  {
    id: 'it_q2',
    roleCategory: 'Technical Support',
    category: 'Structured Troubleshooting Method',
    question: 'How do you troubleshoot a technical problem?',
    proposedAnswer:
      'I start by clearly defining the problem and gathering information about what changed, what the user sees and when the issue started. Then I try to isolate the cause by testing the most likely possibilities one at a time. I avoid making several changes at once because that can make the problem harder to diagnose. After applying a solution, I verify that the issue is actually resolved and document the steps when appropriate.',
    expectedFocus:
      'Defining the problem and gathering information (what changed, what the user sees, when it started), isolating the cause by testing likely possibilities one at a time, avoiding multiple simultaneous changes, verifying the fix, and documenting steps.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Define the problem & gather information (what changed, what the user sees, when it started)',
        tip: 'Start by explaining how you define the problem and gather details: what changed, what the user sees and when it started.',
        regex:
          /\b(?:defin(?:e|ing)|gather(?:ing)?|information|details|what\s+changed|when\s+(?:it|the\s+issue)\s+started|error\s+messages?|ask(?:ing)?\s+(?:the\s+)?(?:user|questions)|symptoms?)\b/i,
      },
      {
        label: 'Isolate the cause by testing likely possibilities one at a time',
        tip: 'Describe isolating the cause by testing the most likely possibilities one at a time.',
        regex:
          /\b(?:isolat(?:e|ing)|narrow(?:ing)?\s+down|one\s+at\s+a\s+time|test(?:ing)?|most\s+likely|possibilit(?:y|ies)|root\s+cause|reproduc(?:e|ing)|eliminat(?:e|ing))\b/i,
      },
      {
        label: 'Avoid making several changes at once',
        tip: 'Mention that you avoid changing several things at once because it makes the problem harder to diagnose.',
        regex:
          /\b(?:several\s+changes|multiple\s+changes|changes\s+at\s+once|one\s+change|at\s+once|simultaneous(?:ly)?|harder\s+to\s+diagnose|controlled)\b/i,
      },
      {
        label: 'Verify the fix & document the steps',
        tip: 'Finish by confirming the issue is actually resolved and documenting the steps when appropriate.',
        regex:
          /\b(?:verif(?:y|ied|ying)|confirm(?:ed|ing)?|actually\s+resolved|test(?:ed)?\s+again|document(?:ed|ing|ation)?|notes?|ticket|knowledge\s+base)\b/i,
      },
    ],
  },
  {
    id: 'it_q3',
    roleCategory: 'Technical Support',
    category: 'Learning New Technology',
    question: 'How do you learn new technology quickly?',
    proposedAnswer:
      'I focus first on understanding what I need the technology to accomplish rather than trying to learn every feature at once. I use official documentation, tutorials or knowledge bases, then practice the most common workflows. If I run into a problem, I research the specific issue and ask targeted questions when necessary. Once I understand the basics, I continue learning through hands-on use.',
    expectedFocus:
      'Focusing on what the technology must accomplish instead of every feature, using official documentation, tutorials and knowledge bases, practicing common workflows, researching specific issues and asking targeted questions, and continuing through hands-on use.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Focus on what the technology needs to accomplish, not every feature',
        tip: 'Explain that you start with what you need the technology to accomplish rather than learning every feature at once.',
        regex:
          /\b(?:accomplish|purpose|what\s+i\s+need|goal|use\s+cases?|every\s+feature|core\s+functions?|basics|priorit(?:y|ize))\b/i,
      },
      {
        label: 'Use official documentation, tutorials or knowledge bases',
        tip: 'Mention using official documentation, tutorials or knowledge bases.',
        regex:
          /\b(?:documentation|docs|tutorials?|knowledge\s+bases?|manuals?|guides?|videos?|courses?|official)\b/i,
      },
      {
        label: 'Practice common workflows; research specific issues & ask targeted questions',
        tip: 'Describe practicing the most common workflows, researching specific issues and asking targeted questions when needed.',
        regex:
          /\b(?:practic(?:e|ing)|workflows?|research(?:ing)?|specific\s+issue|targeted\s+questions?|ask(?:ing)?\s+(?:questions|colleagues|for\s+help)|forums?|lab|sandbox)\b/i,
      },
      {
        label: 'Keep learning through hands-on use',
        tip: 'Close by explaining that you keep building your knowledge through hands-on use.',
        regex:
          /\b(?:hands[\s-]?on|continu(?:e|ing)\s+(?:to\s+)?learn(?:ing)?|keep\s+learning|daily\s+use|experience|over\s+time|experiment(?:ing)?)\b/i,
      },
    ],
  },
  {
    id: 'it_q4',
    roleCategory: 'Technical Support',
    category: 'Handling Frustrated Users',
    question: 'How do you handle a frustrated user?',
    proposedAnswer:
      'I first let the user explain the issue without interrupting and acknowledge the frustration. Then I ask focused questions so I can understand the technical problem. I explain what I’m going to check in simple language rather than using unnecessary technical terms. Once I identify the solution, I guide the user through it clearly and confirm that the issue is resolved before ending the interaction.',
    expectedFocus:
      'Letting the user explain without interrupting, acknowledging the frustration, asking focused questions, explaining checks in simple language without jargon, guiding the user through the fix, and confirming resolution before ending.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Let the user explain without interrupting & acknowledge the frustration',
        tip: 'Start by letting the user explain without interrupting and acknowledging their frustration.',
        regex:
          /\b(?:listen(?:ing)?|without\s+interrupting|let\s+(?:them|the\s+user)\s+explain|acknowledg(?:e|ing)|empath(?:y|ize|ise)|understand\s+(?:their|the)\s+frustration|calm|apologi[sz]e)\b/i,
      },
      {
        label: 'Ask focused questions to understand the technical problem',
        tip: 'Mention asking focused questions to understand the actual technical problem.',
        regex:
          /\b(?:focused\s+questions?|ask(?:ing)?\s+(?:questions|them)|questions?|understand\s+the\s+(?:technical\s+)?problem|details|clarif(?:y|ying))\b/i,
      },
      {
        label: 'Explain checks in simple language without unnecessary jargon',
        tip: 'Explain what you are going to check in simple language rather than unnecessary technical terms.',
        regex:
          /\b(?:simple\s+(?:language|terms|words)|plain\s+(?:language|english)|jargon|technical\s+terms|explain(?:ing)?\s+what|non[\s-]?technical|easy\s+to\s+understand)\b/i,
      },
      {
        label: 'Guide them through the fix & confirm it is resolved before ending',
        tip: 'Finish by guiding the user through the solution and confirming it is resolved before ending the interaction.',
        regex:
          /\b(?:guide|walk(?:ed)?\s+(?:them|the\s+user)\s+through|step\s+by\s+step|confirm(?:ing)?|resolved|before\s+ending|follow(?:ing)?\s+up|make\s+sure)\b/i,
      },
    ],
  },
  {
    id: 'it_q5',
    roleCategory: 'Technical Support',
    category: 'Value Proposition for Technical Support',
    question: 'Why should we hire you for technical support?',
    proposedAnswer:
      'You should hire me because I combine technical problem-solving with patience and communication. I approach issues logically instead of guessing, and I’m comfortable researching unfamiliar problems when I don’t immediately know the answer. I also understand that users need clear explanations, not just technical jargon. I would bring a dependable attitude, a willingness to keep learning and a focus on resolving issues effectively.',
    expectedFocus:
      'Combining technical problem-solving with patience and communication, a logical approach instead of guessing, comfort researching unfamiliar problems, clear explanations instead of jargon, dependability, willingness to learn and a focus on resolving issues.',
    isBehavioralStar: false,
    markingPillars: [
      {
        label: 'Technical problem-solving combined with patience & communication',
        tip: 'Highlight that you combine technical problem-solving with patience and communication.',
        regex:
          /\b(?:problem[\s-]?solv(?:e|ing|er)|technical\s+skills?|patien(?:ce|t)|communicat(?:e|ion|ing)|troubleshoot(?:ing)?)\b/i,
      },
      {
        label: 'Logical approach & comfortable researching unfamiliar problems',
        tip: 'Mention approaching issues logically instead of guessing, and researching problems you do not immediately know.',
        regex:
          /\b(?:logical(?:ly)?|instead\s+of\s+guessing|methodical|research(?:ing)?|unfamiliar|don'?t\s+(?:immediately\s+)?know|find\s+(?:the\s+)?answers?)\b/i,
      },
      {
        label: 'Clear explanations for users, not just technical jargon',
        tip: 'Show that you understand users need clear explanations, not just technical jargon.',
        regex:
          /\b(?:clear\s+explanations?|explain(?:ing)?|jargon|plain\s+language|simple\s+terms|users?\s+need|non[\s-]?technical)\b/i,
      },
      {
        label: 'Dependable, keeps learning, focused on resolving issues',
        tip: 'Finish with what you bring: dependability, willingness to keep learning and a focus on resolving issues effectively.',
        regex:
          /\b(?:dependab(?:le|ility)|reliab(?:le|ility)|keep\s+learning|willing(?:ness)?|resolv(?:e|ing)\s+issues|effective(?:ly)?|attitude|commit(?:ted|ment))\b/i,
      },
    ],
  },
  {
    id: 'it_q6',
    roleCategory: 'Technical Support',
    category: 'Solving a Difficult Technical Problem (STAR)',
    question: 'Tell me about a difficult technical problem you solved.',
    proposedAnswer:
      "Situation: A user reported a technical issue that was not resolved by the normal first troubleshooting steps. Task: I needed to identify the likely cause and restore the user's ability to work. Action: I gathered information about when the issue started and what the user had already tried. I then isolated the problem by testing the likely causes one at a time rather than changing several things simultaneously. Once I identified the cause, I applied the appropriate fix and tested the system again. Result: The issue was resolved, the user was able to continue working and I documented the solution so it could be referenced if the problem appeared again.",
    expectedFocus:
      'STAR example: issue not fixed by first-line steps, gathering when it started and what was tried, isolating causes one at a time, applying the fix and retesting, restoring the user, and documenting the solution.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: issue not fixed by normal first steps; restore the user’s ability to work',
        tip: 'Describe a technical issue the usual first steps did not fix, and your goal of getting the user working again.',
        regex:
          /\b(?:difficult|complex|unusual|not\s+resolved|first\s+(?:troubleshooting\s+)?steps|issue|problem|user\s+reported|restore|ability\s+to\s+work|couldn'?t\s+(?:log|connect|access))\b/i,
      },
      {
        label: 'Action: gathered information — when it started & what was already tried',
        tip: 'Explain how you gathered information: when the issue started and what the user had already tried.',
        regex:
          /\b(?:gather(?:ed|ing)|information|when\s+(?:it|the\s+issue)\s+started|already\s+tried|asked|logs?|error\s+messages?|details)\b/i,
      },
      {
        label: 'Action: isolated the cause one at a time, applied the fix & retested',
        tip: 'Describe testing likely causes one at a time, applying the right fix and testing the system again.',
        regex:
          /\b(?:isolat(?:e|ed|ing)|one\s+at\s+a\s+time|test(?:ed|ing)?|likely\s+causes?|root\s+cause|appl(?:y|ied)\s+(?:the\s+)?(?:appropriate\s+)?fix|reinstall(?:ed)?|reconfigur(?:e|ed)|updated|replaced)\b/i,
      },
      {
        label: 'Result: issue resolved, user back to work & solution documented',
        tip: 'Close with the result: the issue was resolved, the user could keep working and you documented the solution.',
        regex:
          /\b(?:resolved|fixed|solved|continue(?:d)?\s+working|back\s+to\s+work|document(?:ed|ation)?|knowledge\s+base|result|referenced)\b/i,
      },
    ],
  },
  {
    id: 'it_q7',
    roleCategory: 'Technical Support',
    category: 'Troubleshooting Under Pressure (STAR)',
    question: 'Describe a time you had to troubleshoot under pressure.',
    proposedAnswer:
      'Situation: A technical issue occurred during a time-sensitive period and was affecting an important task. Task: I needed to restore functionality quickly without making the situation worse. Action: I stayed calm, identified the immediate impact, gathered the key facts and focused first on the most likely causes. I tested solutions in a controlled way and communicated updates so the user knew what was happening. Result: The issue was resolved within the available time, and the user was able to continue the task. The experience reinforced the importance of staying methodical even when the situation feels urgent.',
    expectedFocus:
      'STAR example: time-sensitive outage affecting an important task, restoring function quickly without making it worse, staying calm, identifying impact and key facts, testing likely causes in a controlled way, communicating updates, and staying methodical.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: time-sensitive issue; restore quickly without making it worse',
        tip: 'Describe the urgent, time-sensitive issue and your goal of restoring it quickly without making things worse.',
        regex:
          /\b(?:pressure|urgent|time[\s-]?sensitive|deadline|quickly|important\s+(?:task|meeting|presentation)|minutes|without\s+making\s+(?:it|the\s+situation)\s+worse|critical)\b/i,
      },
      {
        label: 'Action: stayed calm, identified the impact & gathered key facts',
        tip: 'Explain how you stayed calm, identified the immediate impact and gathered the key facts.',
        regex:
          /\b(?:calm|composed|focused|impact|key\s+facts|gather(?:ed|ing)|assess(?:ed)?|priorit(?:y|ized|ised))\b/i,
      },
      {
        label: 'Action: tested likely causes in a controlled way & communicated updates',
        tip: 'Mention testing the most likely causes in a controlled way and keeping the user updated.',
        regex:
          /\b(?:most\s+likely|controlled|test(?:ed|ing)?|one\s+at\s+a\s+time|communicat(?:e|ed|ing)|updat(?:e|es|ed)|kept\s+(?:them|the\s+user)\s+(?:informed|updated))\b/i,
      },
      {
        label: 'Result: resolved in time & lesson about staying methodical',
        tip: 'Close with the result: resolved within the time available, and how it reinforced staying methodical under urgency.',
        regex:
          /\b(?:resolved|fixed|restored|in\s+time|on\s+time|continue(?:d)?|methodical|result|learn(?:ed|t)|reinforced)\b/i,
      },
    ],
  },
  {
    id: 'it_q8',
    roleCategory: 'Technical Support',
    category: 'Learning New Technology Quickly (STAR)',
    question: 'Tell me about a time you learned a new technology quickly.',
    proposedAnswer:
      'Situation: I was required to work with a technology that I had not used before. Task: I needed to become productive with the core functions quickly. Action: I identified exactly what I needed to accomplish, reviewed the available documentation, practiced the workflow and researched specific questions as they came up. I focused on understanding why the system worked the way it did instead of simply memorizing clicks. Result: I became comfortable enough to complete the required work quickly and continued building my knowledge through hands-on use.',
    expectedFocus:
      'STAR example: unfamiliar technology needed quickly, identifying what had to be accomplished, reviewing documentation, practicing the workflow, researching questions as they arose, understanding why the system works rather than memorizing clicks, and continued hands-on learning.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: unfamiliar technology with core functions needed quickly',
        tip: 'Describe the technology you had not used before and why you needed to become productive quickly.',
        regex:
          /\b(?:new\s+(?:technology|tool|software|system|platform)|never\s+used|had\s+not\s+used|unfamiliar|quickly|core\s+functions?)\b/i,
      },
      {
        label: 'Action: identified goals, reviewed documentation & practiced the workflow',
        tip: 'Explain how you identified exactly what you needed to accomplish, reviewed documentation and practiced the workflow.',
        regex:
          /\b(?:documentation|docs|tutorials?|practic(?:e|ed|ing)|workflow|identif(?:y|ied)\s+(?:exactly\s+)?what|accomplish|guides?)\b/i,
      },
      {
        label: 'Action: researched questions & understood why the system works (not memorizing clicks)',
        tip: 'Mention researching questions as they came up and understanding why the system worked rather than memorizing clicks.',
        regex:
          /\b(?:research(?:ed|ing)?|understand(?:ing)?\s+why|how\s+(?:it|the\s+system)\s+work(?:s|ed)|memori[sz](?:e|ing)|under\s+the\s+hood|concepts?|questions?)\b/i,
      },
      {
        label: 'Result: productive quickly & kept learning hands-on',
        tip: 'Close with the result: you completed the required work quickly and kept learning through hands-on use.',
        regex:
          /\b(?:productive|comfortable|proficient|completed|quickly|hands[\s-]?on|continu(?:e|ed)\s+(?:building|learning)|result)\b/i,
      },
    ],
  },
  {
    id: 'it_q9',
    roleCategory: 'Technical Support',
    category: 'Supporting a Frustrated User (STAR)',
    question: 'Describe a time you dealt with a frustrated user.',
    proposedAnswer:
      'Situation: A user was frustrated because a technical problem was preventing them from completing an important task. Task: I needed to troubleshoot the issue while keeping the interaction professional and productive. Action: I let the user explain what was happening, acknowledged the frustration and asked focused questions to narrow down the problem. I explained the troubleshooting steps in simple language and kept the user updated instead of leaving them wondering what was happening. Result: We identified and resolved the issue, and the user understood what had been done. It reminded me that good technical support requires both technical reasoning and empathy.',
    expectedFocus:
      'STAR example: frustrated user blocked from an important task, keeping it professional, letting them explain, acknowledging frustration, focused questions, simple-language explanations and regular updates, resolving the issue, and balancing technical reasoning with empathy.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: frustrated user blocked from an important task; keep it professional',
        tip: 'Describe the frustrated user, what the problem was stopping them from doing, and your goal of keeping it professional.',
        regex:
          /\b(?:frustrat(?:ed|ion)|upset|angry|annoyed|stressed|important\s+task|deadline|professional|productive)\b/i,
      },
      {
        label: 'Action: let them explain, acknowledged frustration & asked focused questions',
        tip: 'Explain how you let the user explain, acknowledged their frustration and asked focused questions to narrow down the problem.',
        regex:
          /\b(?:listen(?:ed|ing)?|let\s+(?:them|the\s+user)\s+explain|acknowledg(?:ed|ing)|empath(?:y|ized|ised)|focused\s+questions?|narrow(?:ed)?\s+down|asked)\b/i,
      },
      {
        label: 'Action: explained steps in simple language & kept the user updated',
        tip: 'Mention explaining the troubleshooting steps in simple language and keeping the user updated throughout.',
        regex:
          /\b(?:simple\s+(?:language|terms)|plain\s+language|explain(?:ed|ing)|jargon|kept\s+(?:them|the\s+user)\s+(?:updated|informed)|updates?|reassur(?:e|ed))\b/i,
      },
      {
        label: 'Result: resolved, user understood the fix & lesson: reasoning plus empathy',
        tip: 'Close with the result: the issue was resolved, the user understood what was done, and support needs both technical reasoning and empathy.',
        regex:
          /\b(?:resolved|fixed|solved|understood|empathy|technical\s+reasoning|result|thank(?:ed|ful)|satisfied|reminded)\b/i,
      },
    ],
  },
  {
    id: 'it_q10',
    roleCategory: 'Technical Support',
    category: 'Technical Mistake & Correction (STAR)',
    question: 'Tell me about a technical mistake you made and how you corrected it.',
    proposedAnswer:
      'Situation: I once made a technical change that produced an unexpected result. Task: I needed to identify what happened, minimize the impact and restore the correct configuration. Action: I stopped making additional changes, reviewed the steps I had taken, corrected or restored the affected setting and then tested the system carefully before continuing. I also documented what happened and added an extra verification step to my process. Result: The issue was corrected, and the experience taught me to slow down and verify changes rather than assuming a configuration change will behave exactly as expected.',
    expectedFocus:
      'STAR example: a change with an unexpected result, owning it, minimizing impact, stopping further changes, reviewing the steps taken, restoring the correct setting and retesting, documenting it, adding a verification step, and learning to verify changes.',
    isBehavioralStar: true,
    markingPillars: [
      {
        label: 'Situation/Task: own technical change caused an unexpected result; minimize impact',
        tip: 'Honestly describe a technical change you made that had an unexpected result and your goal of minimizing the impact.',
        regex:
          /\b(?:mistake|error|i\s+(?:made|changed|configured|deleted|broke)|unexpected|wrong\s+(?:setting|configuration)|misconfigur(?:ed|ation)|minimi[sz]e\s+(?:the\s+)?impact|accidentally)\b/i,
      },
      {
        label: 'Action: stopped further changes & reviewed the steps taken',
        tip: 'Explain that you stopped making additional changes and reviewed the steps you had taken.',
        regex:
          /\b(?:stopp(?:ed|ing)|no\s+(?:further|more)\s+changes|additional\s+changes|review(?:ed|ing)?\s+(?:the\s+)?steps|retrac(?:e|ed)|figured\s+out\s+what\s+happened|identif(?:y|ied)\s+what\s+happened)\b/i,
      },
      {
        label: 'Action: restored the correct setting, retested & documented it',
        tip: 'Describe restoring the correct setting, testing carefully before continuing, and documenting what happened.',
        regex:
          /\b(?:restor(?:e|ed)|revert(?:ed)?|roll(?:ed)?\s+back|correct(?:ed)?|test(?:ed|ing)?|document(?:ed|ation)?|undo|backup)\b/i,
      },
      {
        label: 'Result: corrected & added a verification step — slow down and verify changes',
        tip: 'Close with the result: it was corrected, and you added a verification step and learned to verify changes before assuming they work.',
        regex:
          /\b(?:verif(?:y|ication|ied)|extra\s+step|checklist|slow\s+down|double[\s-]?check|learn(?:ed|t)|taught|process|result|lesson)\b/i,
      },
    ],
  },
];

export const ALL_STANDARD_QUESTION_ROWS: CustomerServiceQuestionRow[] = [
  UNIVERSAL_FIRST_QUESTION_ROW,
  ...CUSTOMER_SERVICE_QUESTION_TABLE,
  ...VIRTUAL_ASSISTANT_QUESTION_TABLE,
  ...TECHNICAL_SUPPORT_QUESTION_TABLE,
];

export function isVirtualAssistantRole(role: string): boolean {
  return /\b(?:virtual\s+assistant|executive\s+assistant|administrative\s+assistant|remote\s+assistant|personal\s+assistant|general\s+va|admin\s+support|office\s+assistant|\bva\b)\b/i.test(
    role || ''
  );
}

export function isTechnicalSupportRole(role: string): boolean {
  return /\b(?:tech(?:nical)?\s+support|it\s+support|help\s*desk|service\s*desk|desktop\s+support|systems?\s+support|network\s+support|tier\s*[123]\s*support|troubleshoot(?:er|ing)?|computer\s+technician|it\s+specialist)\b/i.test(
    role || ''
  );
}

/**
 * Alternative ways of asking the universal opening question. First-time candidates
 * always hear the canonical wording (UNIVERSAL_FIRST_QUESTION_ROW.question); returning
 * candidates hear one of these so repeat sessions still feel like a real interview.
 * All variants share the same id ('universal_q1') and therefore the same marking guide.
 * The wording is role-neutral so it works for any job position.
 */
export const UNIVERSAL_FIRST_QUESTION_VARIANTS: string[] = [
  'Can you take me through your work experience so far, and tell me what makes you the strongest candidate for this role?',
  'Give me an overview of your professional background, and explain why you believe you are the right fit for this position.',
  'Tell me about the experience you bring, and why you think you would be the best person for this job.',
  'Walk me through your career path up to now, and what makes you a great match for this opportunity.',
  'How has your professional experience prepared you for this role, and why should we choose you over other candidates?',
];

/** Max score every interview is marked on, regardless of how many questions were asked. */
export const INTERVIEW_MAX_SCORE = 20;
/** Passing benchmark on the /20 scale (65%). */
export const INTERVIEW_PASSING_SCORE = 13;
export const DEFAULT_QUESTION_COUNT = 4;
export const EXTENDED_QUESTION_COUNT = 5;

/**
 * Decides how many questions a session gets: 4 by default, 5 for returning candidates who
 * have already completed at least one interview (they get one extra role question so
 * repeat practice covers more of the bank). The total is always normalized to /20.
 */
export function decideQuestionCount(params: { completedSessionsCount: number }): number {
  return params.completedSessionsCount > 0 ? EXTENDED_QUESTION_COUNT : DEFAULT_QUESTION_COUNT;
}

/** Returns the role's question bank (used for selection and for marking-guide lookups). */
export function getQuestionBankForRole(role: string): CustomerServiceQuestionRow[] | null {
  if (isVirtualAssistantRole(role)) return VIRTUAL_ASSISTANT_QUESTION_TABLE;
  if (isTechnicalSupportRole(role)) return TECHNICAL_SUPPORT_QUESTION_TABLE;
  if (isCustomerServiceOrSupportRole(role)) return CUSTOMER_SERVICE_QUESTION_TABLE;
  return null;
}

/**
 * Builds the interview session question list:
 * Question 1: Universal First Question — canonical wording for first-time candidates,
 *             a rotating alternative wording for returning candidates.
 * Questions 2..N: shuffled from the 10-question bank matching the candidate's role
 *             (Q1 "Tell me about yourself" of each bank is skipped because the universal
 *             question already covers it).
 * N is 4 by default and 5 for returning candidates (see decideQuestionCount).
 * Each answer is graded 0-5 and the session total is normalized to /20.
 */
export function selectQuestionsForInterviewSession(
  role: string,
  skills: string[],
  options: { isFirstTimeCandidate?: boolean; questionCount?: number } = {}
): ResumeExaminationResult['questions'] {
  const isFirstTime = options.isFirstTimeCandidate !== false;
  const questionCount = Math.max(
    DEFAULT_QUESTION_COUNT,
    Math.min(EXTENDED_QUESTION_COUNT, options.questionCount || DEFAULT_QUESTION_COUNT)
  );
  const roleQuestionsNeeded = questionCount - 1;

  const q1Text = isFirstTime
    ? UNIVERSAL_FIRST_QUESTION_ROW.question
    : UNIVERSAL_FIRST_QUESTION_VARIANTS[crypto.randomInt(UNIVERSAL_FIRST_QUESTION_VARIANTS.length)];

  const q1 = {
    id: UNIVERSAL_FIRST_QUESTION_ROW.id,
    number: 1,
    category: UNIVERSAL_FIRST_QUESTION_ROW.category,
    question: q1Text,
    expectedFocus: UNIVERSAL_FIRST_QUESTION_ROW.expectedFocus,
    proposedAnswer: UNIVERSAL_FIRST_QUESTION_ROW.proposedAnswer,
    isBehavioralStar: false,
  };

  let pool: CustomerServiceQuestionRow[] = [];

  if (isVirtualAssistantRole(role)) {
    // Pick 3 from VA questions 2 through 10
    pool = VIRTUAL_ASSISTANT_QUESTION_TABLE.slice(1);
  } else if (isTechnicalSupportRole(role)) {
    // Pick 3 from Tech Support questions 2 through 10
    pool = TECHNICAL_SUPPORT_QUESTION_TABLE.slice(1);
  } else if (isCustomerServiceOrSupportRole(role)) {
    // Pick 3 from CS questions 2 through 10
    pool = CUSTOMER_SERVICE_QUESTION_TABLE.slice(1);
  } else {
    // Fallback tailored questions
    const tailored = buildTailoredQuestionsForRole(role, skills).slice(1);
    const shuffledTailored = [...tailored]
      .sort(() => Math.random() - 0.5)
      .slice(0, roleQuestionsNeeded);
    return [
      q1,
      ...shuffledTailored.map((q, idx) => ({
        ...q,
        number: idx + 2,
      })),
    ];
  }

  // Shuffle pool using Fisher-Yates
  const shuffledPool = [...pool];
  for (let i = shuffledPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffledPool[i];
    shuffledPool[i] = shuffledPool[j];
    shuffledPool[j] = temp;
  }

  const selectedRoleQuestions = shuffledPool.slice(0, roleQuestionsNeeded);

  return [
    q1,
    ...selectedRoleQuestions.map((item, idx) => ({
      id: item.id,
      number: idx + 2,
      category: item.category,
      question: item.question,
      expectedFocus: item.expectedFocus,
      proposedAnswer: item.proposedAnswer,
      isBehavioralStar: item.isBehavioralStar,
    })),
  ];
}

/**
 * Finds the marking-guide row for a question. Several banks share identical question text
 * ("Tell me about yourself.", "Why should we hire you?"), so the lookup must be by id first;
 * a text match is only attempted inside the candidate's own role bank (plus the universal row).
 */
export function findMarkingGuideRow(
  questionId: string,
  questionText: string,
  role: string
): CustomerServiceQuestionRow | null {
  const byId = ALL_STANDARD_QUESTION_ROWS.find((r) => r.id === questionId);
  if (byId) return byId;

  const normalizedText = (questionText || '').toLowerCase().trim();
  if (!normalizedText) return null;
  const scopedRows = [UNIVERSAL_FIRST_QUESTION_ROW, ...(getQuestionBankForRole(role) || [])];
  return (
    scopedRows.find((r) => r.question.toLowerCase().trim() === normalizedText) ||
    (UNIVERSAL_FIRST_QUESTION_VARIANTS.some((v) => v.toLowerCase() === normalizedText)
      ? UNIVERSAL_FIRST_QUESTION_ROW
      : null)
  );
}

export interface AnswerAlignmentResult {
  isOnTopic: boolean;
  scoreOutOf5: number;
  /** 0-100: how closely the answer follows the direction of the suggested answer. */
  alignmentPercent: number;
  /** Marking-guide points the answer covered / missed (from the question's pillars). */
  matchedPoints: string[];
  missedPoints: string[];
  feedback: string;
  strengths: string[];
  improvementTip: string;
  gradingMethod: 'marking_guide' | 'marking_guide+ai';
}

/**
 * Grades an answer by how closely it follows the direction of the suggested answer for
 * that position. The deterministic marking guide (pillars + concept overlap) is always
 * computed; when an AI score is available it is blended (60% AI semantic judgement,
 * 40% marking guide) and kept within 1.5 points of the guide score, so the mark stays
 * anchored to the suggested answer instead of drifting with the model.
 */
export function gradeAnswerAgainstSuggestedAnswer(params: {
  questionId: string;
  questionText: string;
  category: string;
  expectedFocus: string;
  proposedAnswer?: string;
  candidateText: string;
  role: string;
  aiScoreOutOf5?: number | null;
}): AnswerAlignmentResult {
  const guide = evaluateCandidateResponseWithMarkingGuide(params);
  const row = findMarkingGuideRow(params.questionId, params.questionText, params.role);
  const matchedPoints: string[] = [];
  const missedPoints: string[] = [];
  if (row) {
    for (const pillar of row.markingPillars) {
      (pillar.regex.test(params.candidateText || '') ? matchedPoints : missedPoints).push(pillar.label);
    }
  }

  let score = guide.isOnTopic ? guide.scoreOutOf5 : Math.min(guide.scoreOutOf5, 1);
  let method: AnswerAlignmentResult['gradingMethod'] = 'marking_guide';
  const ai = params.aiScoreOutOf5;
  if (typeof ai === 'number' && Number.isFinite(ai)) {
    const clampedAi = Math.max(0, Math.min(5, ai));
    // The AI judges whether the answer makes sense against the suggested answer (meaning,
    // not exact words), so it carries most of the weight; the marking guide keeps it honest
    // (an AI score can never move the mark more than 2 points away from the guide).
    const blended = clampedAi * 0.75 + score * 0.25;
    score = Math.max(score - 2, Math.min(score + 2, blended));
    method = 'marking_guide+ai';
  }
  score = Math.max(0, Math.min(5, Math.round(score * 2) / 2));

  const totalPillars = matchedPoints.length + missedPoints.length;
  const alignmentPercent = totalPillars
    ? Math.round((matchedPoints.length / totalPillars) * 100)
    : Math.round((score / 5) * 100);

  return {
    isOnTopic: guide.isOnTopic,
    scoreOutOf5: score,
    alignmentPercent,
    matchedPoints,
    missedPoints,
    feedback: guide.feedback,
    strengths: guide.strengths,
    improvementTip: guide.improvementTip,
    gradingMethod: method,
  };
}

/**
 * Normalizes a session's per-question scores (each 0-5) to the /20 scale, applies
 * misconduct penalties (which are expressed in /20 points) and updates the session.
 */
export function recomputeSessionScore(
  session: InterviewSessionRecord,
  opts: { forceZero?: boolean } = {}
): { rawOutOf20: number; totalOutOf20: number } {
  const qCount = Math.max(1, session.questions.length || DEFAULT_QUESTION_COUNT);
  const rawSum = session.questionEvaluations.reduce((sum, q) => sum + (Number(q.scoreOutOf5) || 0), 0);
  const rawOutOf20 = Number(((rawSum / (qCount * 5)) * INTERVIEW_MAX_SCORE).toFixed(1));
  const penalty = Number(session.misconductPenaltyPoints || 0);
  const totalOutOf20 = opts.forceZero
    ? 0
    : Math.max(0, Math.min(INTERVIEW_MAX_SCORE, Number((rawOutOf20 - penalty).toFixed(1))));
  session.totalScoreOutOf20 = totalOutOf20;
  // Kept for backward compatibility with older clients/rows; holds the same /20 value.
  session.totalScoreOutOf25 = totalOutOf20;
  session.maxScore = INTERVIEW_MAX_SCORE;
  session.percentageScore = Math.round((totalOutOf20 / INTERVIEW_MAX_SCORE) * 100);
  return { rawOutOf20, totalOutOf20 };
}

/**
 * Evaluates a candidate's response against the question's Proposed Answer (Marking Guide).
 * - Does NOT require word-for-word memorization.
 * - Checks whether the candidate's response makes sense and aligns with the core concepts
 *   and reasoning of the proposed answer, grading on a 0 to 5 scale (in 0.5 increments).
 */
export function evaluateCandidateResponseWithMarkingGuide(params: {
  questionId: string;
  questionText: string;
  category: string;
  expectedFocus: string;
  proposedAnswer?: string;
  candidateText: string;
  role: string;
}): {
  isOnTopic: boolean;
  scoreOutOf5: number;
  feedback: string;
  strengths: string[];
  improvementTip: string;
} {
  const { questionId, questionText, category, expectedFocus, proposedAnswer, candidateText, role } =
    params;
  const clean = (candidateText || '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // 1. Check if completely off-topic, refusal, or too short (< 6 words)
  const isRefusalOrGibberish =
    wordCount < 6 ||
    /^(?:i\s+don'?t\s+know|no\s+idea|skip|pass|nothing|none|not\s+sure|whatever|test|testing|hello|blah|asdf)\b/i.test(
      clean
    );

  if (isRefusalOrGibberish) {
    return {
      isOnTopic: false,
      scoreOutOf5: wordCount >= 3 ? 1 : 0,
      feedback: `Your response was too brief or did not address the question (${category}).`,
      strengths: [],
      improvementTip: `Focus on: ${expectedFocus}`,
    };
  }

  const matchedRow = findMarkingGuideRow(questionId, questionText, role);

  const refAnswer = proposedAnswer || matchedRow?.proposedAnswer || '';

  // 2. Compute concept overlap with the Proposed Answer / Marking Guide
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'that',
    'with',
    'this',
    'from',
    'have',
    'was',
    'were',
    'are',
    'not',
    'but',
    'what',
    'when',
    'where',
    'which',
    'who',
    'whom',
    'into',
    'about',
    'would',
    'could',
    'should',
    'their',
    'there',
    'they',
    'them',
    'then',
    'than',
    'also',
    'more',
    'most',
    'some',
    'such',
    'only',
    'other',
    'very',
    'just',
    'because',
    'while',
    'make',
    'made',
    'making',
    'situation',
    'task',
    'action',
    'result',
  ]);

  const stemWord = (w: string) =>
    w
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .replace(/(?:ing|ed|ly|es|s|tion|ment|ness|ity)$/, '');

  const refConcepts = new Set(
    (refAnswer || expectedFocus)
      .split(/\s+/)
      .map(stemWord)
      .filter((w) => w.length >= 4 && !stopWords.has(w))
  );

  const candidateStems = new Set(
    words.map(stemWord).filter((w) => w.length >= 4 && !stopWords.has(w))
  );

  let sharedStemCount = 0;
  for (const stem of candidateStems) {
    if (refConcepts.has(stem)) {
      sharedStemCount++;
    }
  }

  // 3. Evaluate Marking Guide Pillars (if defined on the question row)
  const matchedPillars: string[] = [];
  const missingTips: string[] = [];

  if (matchedRow && matchedRow.markingPillars.length > 0) {
    for (const pillar of matchedRow.markingPillars) {
      if (pillar.regex.test(clean)) {
        matchedPillars.push(pillar.label);
      } else {
        missingTips.push(pillar.tip);
      }
    }
  }

  // Check general professional & domain sense signals
  const hasProfessionalSense =
    /\b(?:customer(?:s)?|client(?:s)?|user(?:s)?|people|team|help(?:ed|ing)?|support(?:ed|ing)?|communicat(?:e|ed|ing|ion)|listen(?:ed|ing)?|solv(?:e|ed|ing)|solution(?:s)?|issue(?:s)?|problem(?:s)?|patient|patience|calm|polic(?:y|ies)|procedure(?:s)?|priorit(?:y|ize|ized|izing)|organiz(?:e|ed|ing)|accura(?:te|cy)|mistake|apologiz(?:e|ed)|follow(?:ed)?\s+up|resolv(?:e|ed|ing)|experience|work(?:ed|ing)?|troubleshoot(?:ing)?|software|hardware|network|deadline(?:s)?|schedule(?:s)?|notes?)\b/i.test(
      clean
    );

  // If the answer has 0 matched pillars, 0 shared stems with the marking guide, and no professional sense at all, it is off-topic!
  if (matchedPillars.length === 0 && sharedStemCount === 0 && !hasProfessionalSense) {
    return {
      isOnTopic: false,
      scoreOutOf5: 1,
      feedback: `The response did not align with the question or the marking guide expectations for ${category}.`,
      strengths: [],
      improvementTip: missingTips[0] || `Ensure your answer addresses: ${expectedFocus}`,
    };
  }

  // 4. Calculate Score on the 0 to 5 Scale based on Marking Guide alignment & sense
  let rawScore = 2.0;

  if (matchedRow) {
    const pillarCount = matchedPillars.length; // 0 to 4
    // Base score from semantic marking pillars:
    // 4 pillars -> 4.6, 3 pillars -> 3.9, 2 pillars -> 3.1, 1 pillar -> 2.4, 0 pillars (but on-topic) -> 2.0
    if (pillarCount === 4) rawScore = 4.6;
    else if (pillarCount === 3) rawScore = 3.9;
    else if (pillarCount === 2) rawScore = 3.1;
    else if (pillarCount === 1) rawScore = 2.4;
    else rawScore = 2.0;

    // Bonus for semantic concept overlap with the proposed answer (+0 to +0.5)
    const overlapBonus = Math.min(0.5, sharedStemCount * 0.08);
    rawScore += overlapBonus;

    // For behavioral STAR questions, reward clear action + result explanation
    if (matchedRow.isBehavioralStar) {
      const hasActionAndResult =
        /\b(?:listened|checked|explained|organized|verified|acknowledged|contacted|gathered|followed|resolved|accepted|completed|satisfied|restored|diagnosed|delivered|isolated|repaired|corrected|updated|implemented)\b/i.test(
          clean
        );
      if (hasActionAndResult && wordCount >= 25) {
        rawScore += 0.3;
      }
    } else if (wordCount >= 22) {
      rawScore += 0.25;
    }

    // Cap brief 1-sentence answers (< 14 words) at 3.0 max even if they hit keywords
    if (wordCount < 14) {
      rawScore = Math.min(rawScore, 3.0);
    }
  } else {
    // Non-table role fallback scoring based on expectedFocus & depth
    rawScore = 2.5 + Math.min(2.0, wordCount / 25) + Math.min(0.5, sharedStemCount * 0.1);
  }

  const scoreOutOf5 = Math.max(1.5, Math.min(5, Math.round(rawScore * 2) / 2));

  const strengths =
    matchedPillars.length > 0
      ? matchedPillars.slice(0, 3)
      : [
          `Addressed ${category} with relevant professional context`,
          'Communicated clearly and stayed on topic',
        ];

  const improvementTip =
    missingTips.length > 0
      ? missingTips[0]
      : scoreOutOf5 < 5
      ? `To reach a full 5/5, expand slightly on the specific outcome or how your actions impacted the customer and team.`
      : `Excellent alignment with the Global Hire 360 marking guide for ${category}.`;

  const feedback =
    scoreOutOf5 >= 4.5
      ? `Excellent response (${scoreOutOf5}/5)! Your answer aligns closely in meaning and structure with our marking guide for "${questionText}".`
      : scoreOutOf5 >= 3.5
      ? `Good, sensible response (${scoreOutOf5}/5) that covers the core ideas of our marking guide for ${category}. ${improvementTip}`
      : `Your answer makes basic sense (${scoreOutOf5}/5) and touches on the topic, but missed several key points from the marking guide. ${improvementTip}`;

  return {
    isOnTopic: true,
    scoreOutOf5,
    feedback,
    strengths,
    improvementTip,
  };
}

function buildTailoredQuestionsForRole(
  role: string,
  skills: string[]
): ResumeExaminationResult['questions'] {
  const normalizedRole = role.toLowerCase();
  const topSkills =
    skills.length > 0
      ? skills.slice(0, 4).join(', ')
      : 'your core professional tools and workflows';

  // For Virtual Assistant, Technical Support, or Customer Service, select 4 standard questions (Q1 = Universal First Question, followed by 3 shuffled role-specific questions)
  if (
    isVirtualAssistantRole(role) ||
    isTechnicalSupportRole(role) ||
    isCustomerServiceOrSupportRole(role)
  ) {
    return selectQuestionsForInterviewSession(role, skills);
  }

  if (normalizedRole.includes('virtual assistant')) {
    return [
      {
        id: 'q1',
        number: 1,
        category: 'Virtual Assistant Experience & Skills',
        question: `Based on your resume for the Virtual Assistant position, tell me about your remote support experience and how you apply skills such as ${topSkills} to support busy clients or executives.`,
        expectedFocus: `Overview of Virtual Assistant track record and hands-on proficiency with ${topSkills}.`,
      },
      {
        id: 'q2',
        number: 2,
        category: 'Inbox, Calendar & Schedule Management',
        question: `As a Virtual Assistant, managing competing calendar requests, time zones, and high-volume email inboxes is critical. Walk me through your system for keeping a client's schedule and inbox organized.`,
        expectedFocus: `Prioritization rules, time-zone verification, proactive reminders, and inbox-zero habits.`,
      },
      {
        id: 'q3',
        number: 3,
        category: 'Remote Autonomy & Shifting Priorities',
        question: `Tell me about a time when a remote client gave you multiple urgent tasks at once with minimal instructions. How did you clarify expectations and deliver on time?`,
        expectedFocus: `Proactive communication, asking smart clarifying questions, time blocking, and reliable execution.`,
      },
      {
        id: 'q4',
        number: 4,
        category: 'Confidentiality & Client Communication',
        question: `Virtual Assistants often handle sensitive business data, travel bookings, or client communications. How do you ensure accuracy and strict confidentiality while working remotely?`,
        expectedFocus: `Security awareness, attention to detail, double-checking deliverables, and professional communication.`,
      },
      {
        id: 'q5',
        number: 5,
        category: 'First 30-Day Client Onboarding Plan',
        question: `When you start working with a new client through Global Hire 360 as their Virtual Assistant, what steps do you take in the first two weeks to learn their workflow and start saving them time immediately?`,
        expectedFocus: `Structured onboarding checklist, communication cadence, SOP documentation, and proactive support.`,
      },
    ];
  }

  if (normalizedRole.includes('data entry')) {
    return [
      {
        id: 'q1',
        number: 1,
        category: 'Data Entry Experience & Tools',
        question: `Reviewing your resume for the Data Entry position, walk me through your experience handling high-volume data and how you use skills like ${topSkills} in your daily workflow.`,
        expectedFocus: `Clear overview of Data Entry background, typing/spreadsheet proficiency, and use of ${topSkills}.`,
      },
      {
        id: 'q2',
        number: 2,
        category: 'Accuracy vs. Speed Under Deadlines',
        question: `In Data Entry, both speed and 100% accuracy matter. How do you maintain a fast input pace while preventing typos or data discrepancies when working under a tight deadline?`,
        expectedFocus: `Self-auditing techniques, validation formulas, batch verification, and disciplined focus.`,
      },
      {
        id: 'q3',
        number: 3,
        category: 'Identifying & Fixing Data Errors',
        question: `Tell me about a time when you noticed missing, duplicate, or inconsistent records in a spreadsheet or database. How did you investigate and clean up the data?`,
        expectedFocus: `STAR example showing attention to detail, data cleansing steps, and escalating source issues properly.`,
      },
      {
        id: 'q4',
        number: 4,
        category: 'Handling Repetitive High-Volume Tasks',
        question: `Data Entry work can involve thousands of records across long shifts. What strategies do you use to stay focused, organized, and consistent throughout the day?`,
        expectedFocus: `Structured milestones, keyboard shortcuts, quality spot-checks, and strong work ethic.`,
      },
      {
        id: 'q5',
        number: 5,
        category: 'Data Confidentiality & File Organization',
        question: `How do you organize source files and protect sensitive company or customer information when entering data across multiple spreadsheets or CRM systems?`,
        expectedFocus: `Data privacy compliance, clean file naming/versioning, and secure handling of records.`,
      },
    ];
  }

  if (normalizedRole.includes('executive assistant')) {
    return [
      {
        id: 'q1',
        number: 1,
        category: 'Executive Assistant Background & Core Skills',
        question: `Looking at your resume for the Executive Assistant position, tell me about your experience supporting senior leaders and how you leverage skills like ${topSkills}.`,
        expectedFocus: `Track record supporting executives/leadership and strategic use of ${topSkills}.`,
      },
      {
        id: 'q2',
        number: 2,
        category: 'Complex Executive Calendar & Gatekeeping',
        question: `As an Executive Assistant, how do you protect an executive's time when board members, clients, and internal teams are all requesting urgent meetings on the same day?`,
        expectedFocus: `Diplomatic gatekeeping, strategic prioritization, buffer management, and executive alignment.`,
      },
      {
        id: 'q3',
        number: 3,
        category: 'High-Stakes Travel, Meetings & Last-Minute Changes',
        question: `Tell me about a time when an executive's travel itinerary, board presentation, or critical meeting changed at the last minute. How did you step in and resolve it?`,
        expectedFocus: `Calm problem-solving under pressure, contingency planning, and seamless execution.`,
      },
      {
        id: 'q4',
        number: 4,
        category: 'Executive Communication & Discretion',
        question: `Executive Assistants frequently draft correspondence, prepare briefing documents, and handle confidential matters. Describe how you ensure discretion and executive-level quality in your work.`,
        expectedFocus: `High discretion, attention to detail, executive tone, and anticipation of leadership needs.`,
      },
      {
        id: 'q5',
        number: 5,
        category: 'Anticipating Leadership Needs',
        question: `If placed with a senior executive through Global Hire 360, how do you build trust in your first 30 to 60 days so you can anticipate their needs before they even ask?`,
        expectedFocus: `Proactive communication rhythms, learning executive preferences, and ownership of operations.`,
      },
    ];
  }

  if (
    normalizedRole.includes('admin') ||
    normalizedRole.includes('office') ||
    normalizedRole.includes('clerical') ||
    normalizedRole.includes('receptionist') ||
    normalizedRole.includes('secretary')
  ) {
    return [
      {
        id: 'q1',
        number: 1,
        category: 'Admin Support Background & Skills',
        question: `Looking at your resume for the ${role} position, walk me through your administrative experience and how you use skills like ${topSkills} to keep daily operations running smoothly.`,
        expectedFocus: `Clear summary of Admin Support experience and practical mastery of ${topSkills}.`,
      },
      {
        id: 'q2',
        number: 2,
        category: 'Multi-Tasking & Office Organization',
        question: `In an Admin Support role, you often juggle document preparation, scheduling, reports, and team requests at the same time. How do you organize your day so nothing falls through the cracks?`,
        expectedFocus: `Task tracking systems, prioritization, deadline management, and clear status updates.`,
      },
      {
        id: 'q3',
        number: 3,
        category: 'Process Improvement & Administrative Accuracy',
        question: `Tell me about a time when you improved an administrative workflow, filing system, or reporting process for your team. What did you change and what was the result?`,
        expectedFocus: `Initiative, organization, time saved for the team, and attention to detail.`,
      },
      {
        id: 'q4',
        number: 4,
        category: 'Cross-Team & Client Communication',
        question: `As an Admin Support professional, you are often the central point of contact for internal departments and external partners. Describe how you handle competing requests professionally.`,
        expectedFocus: `Clear written and verbal communication, responsiveness, and collaborative attitude.`,
      },
      {
        id: 'q5',
        number: 5,
        category: 'First 90-Day Administrative Impact',
        question: `If selected for this ${role} role with Global Hire 360, how would you approach your first 30 to 90 days to support your team and add measurable value?`,
        expectedFocus: `Quick mastery of tools and SOPs, reliability, and proactive administrative ownership.`,
      },
    ];
  }

  // Tailored questions for any specialized role extracted from the resume (e.g. Software Developer, Project Manager, Graphic Designer, Data Analyst, Accountant, Marketer, etc.)
  return [
    {
      id: 'q1',
      number: 1,
      category: `${role} Experience & Core Competencies`,
      question: `Looking at your resume for the ${role} position, walk me through your professional background and how you apply essential skills like ${topSkills} in your work.`,
      expectedFocus: `Clear overview of ${role} experience and hands-on proficiency with ${topSkills}.`,
    },
    {
      id: 'q2',
      number: 2,
      category: 'Technical Execution & Problem Solving',
      question: `Tell me about a challenging project or complex problem you solved as a ${role}. How did you leverage ${topSkills} to deliver a successful outcome?`,
      expectedFocus: `Structured STAR example demonstrating technical depth, decision-making, and measurable impact.`,
    },
    {
      id: 'q3',
      number: 3,
      category: 'Quality Standards & Deadlines',
      question: `In a demanding ${role} environment with competing priorities and tight deadlines, how do you ensure high quality, accuracy, and timely delivery?`,
      expectedFocus: `Workflow organization, quality assurance habits, prioritization, and accountability.`,
    },
    {
      id: 'q4',
      number: 4,
      category: 'Collaboration & Stakeholder Communication',
      question: `Describe a time when you collaborated with cross-functional team members, clients, or stakeholders on a key deliverable. How did you align expectations and handle feedback?`,
      expectedFocus: `Clear communication, adaptability, teamwork, and stakeholder management.`,
    },
    {
      id: 'q5',
      number: 5,
      category: `First 90-Day Impact as a ${role}`,
      question: `If selected for this ${role} position, what steps would you take in your first 30 to 90 days to integrate with the team and deliver measurable value?`,
      expectedFocus: `Proactive onboarding plan, mastery of tools and workflows, and ownership of results.`,
    },
  ];
}

function splitOutsideParentheses(input: string, splitSlashes = false): string[] {
  const results: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }

    if (depth === 0) {
      if (/[•●▪◦❖➢➤✓✔★☆,;|]/.test(ch)) {
        if (current.trim()) results.push(current.trim());
        current = '';
        continue;
      }
      if (
        splitSlashes &&
        ch === '/' &&
        i > 0 &&
        i + 1 < input.length &&
        input[i - 1] === ' ' &&
        input[i + 1] === ' '
      ) {
        if (current.trim()) results.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }

  if (current.trim()) {
    results.push(current.trim());
  }
  return results;
}

function countTopLevelCommas(str: string): number {
  let count = 0;
  let depth = 0;
  for (const ch of str) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

function cleanSectionHeaderCandidate(line: string): string {
  return collapseSpacedHeading(line)
    .replace(/^[\s•●▪◦❖➢➤★☆✓✔\-*–—|#0-9.()[\]]+/, '')
    .replace(/[\s:\-–—|#]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSkillsSectionHeader(line: string): boolean {
  const h = cleanSectionHeaderCandidate(line);
  if (!h || h.length > 48) return false;
  return (
    /^(?:(?:technical|professional|core|key|relevant|hard|soft|specialized|transferable|computer|it|administrative|support|customer\s+service|customer\s+support|office|personal|additional)\s+)?(?:skills|competencies|proficiencies|expertise|compétences)(?:\s*(?:&|and|\/|\+)\s*(?:competencies|abilities|tools|software|proficiencies|expertise|qualifications|technologies|strengths|systems|platforms|languages|soft\s+skills|hard\s+skills))?$/i.test(
      h
    ) ||
    /^(?:areas\s+of\s+(?:expertise|competence|strength)|tools\s*(?:&|and|\/)\s*(?:software|technologies|systems|platforms)|software\s*(?:&|and|\/)?\s*(?:tools|proficiency|skills)?|skills\s+summary|summary\s+of\s+skills|technical\s+proficiencies|core\s+qualifications|key\s+qualifications)$/i.test(
      h
    )
  );
}

function isStopSectionHeader(line: string): boolean {
  const h = cleanSectionHeaderCandidate(line);
  if (!h || h.length > 48) return false;
  if (isSkillsSectionHeader(line)) return false;
  return /^(?:work\s+experience|professional\s+experience|employment\s+history|work\s+history|career\s+history|relevant\s+experience|experience|employment|expérience\s+professionnelle|parcours\s+professionnel|education(?:al\s+background)?|academic\s+(?:background|qualifications)|education\s*(?:&|and)\s*(?:training|certifications)|formation|éducation|certifications?(?:\s*(?:&|and)\s*licenses?)?|licenses?\s*(?:&|and)\s*certifications?|certificates?|training|projects|key\s+projects|personal\s+projects|languages|language\s+proficiency|langues|references|referees|références|awards(?:\s*(?:&|and)\s*honors)?|honors(?:\s*(?:&|and)\s*awards)?|achievements|key\s+achievements|accomplishments|volunteer(?:ing|\s+experience|\s+work)?|community\s+involvement|interests|hobbies|publications|affiliations|additional\s+information|professional\s+summary|executive\s+summary|career\s+summary|summary|profile|personal\s+profile|profil(?:\s+professionnel)?|résumé|career\s+objective|objective|about\s+me|contact(?:\s+information|\s+details)?)$/i.test(
    h
  );
}

function parseExplicitSkillsSectionFromText(rawText: string): string[] {
  const skillsFromSection: string[] = [];
  const seenLower = new Set<string>();

  const bulletPrefixRegex =
    /^(?:(?:â€¢|Â·|[\s•●▪◦❖➢➤✓✔★☆\-*–—:|"'“”‘’«»·+])+|\d+[.)]\s+)/;

  const addSkill = (rawItem: string) => {
    const cleaned = rawItem
      .replace(bulletPrefixRegex, '')
      .replace(/(?:â€¢|Â·|[\s•●▪◦❖➢➤✓✔★☆\-*–—:|.;,"'“”‘’«»·+])+$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned.length < 2 || cleaned.length > 90) return;
    if (
      /@|https?:\/\/|www\.|\b\d{3}[-.\s]\d{3}|\b(?:19|20)\d{2}\s*[-–—to]+\s*(?:(?:19|20)\d{2}|present|current)\b/i.test(
        cleaned
      )
    ) {
      return;
    }
    if (isSkillsSectionHeader(cleaned) || isStopSectionHeader(cleaned)) return;

    const words = cleaned.split(/\s+/);
    if (words.length > 11) return;

    // Exclude full past-tense job responsibility sentences
    if (
      words.length >= 6 &&
      /^(?:managed|developed|created|assisted|responsible|worked|provided|ensured|performed|handled|volunteered|contributed|wrote|designed|built|supported|resolved|maintained|spearheaded|coordinated|implemented|delivered|achieved|led|organized|processed|communicated|collaborated|served|answered)\b/i.test(
        cleaned
      )
    ) {
      return;
    }

    const key = cleaned.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      skillsFromSection.push(cleaned);
    }
  };

  const lines = rawText
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => collapseSpacedHeading(l.trim()))
    .filter(Boolean);

  let inSkillsSection = false;
  const sectionBlocks: string[][] = [];
  let currentBlock: string[] = [];

  const flushBlock = () => {
    if (currentBlock.length > 0) {
      sectionBlocks.push(currentBlock);
      currentBlock = [];
    }
  };

  for (const line of lines) {
    if (isSkillsSectionHeader(line)) {
      flushBlock();
      inSkillsSection = true;
      continue;
    }

    const inlineMatch = line.match(
      /^(?:(?:technical|professional|core|key|relevant|hard|soft|computer|administrative|support)\s+)?(?:skills|competencies|proficiencies|expertise|compétences|tools\s*(?:&|and)\s*software)\s*[:\-–—|]\s*(.+)$/i
    );
    if (inlineMatch && inlineMatch[1]) {
      if (!inSkillsSection) {
        flushBlock();
        inSkillsSection = true;
      }
      currentBlock.push(inlineMatch[1].trim());
      continue;
    }

    if (inSkillsSection) {
      if (isStopSectionHeader(line)) {
        flushBlock();
        inSkillsSection = false;
        continue;
      }
      if (
        /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:19|20)\d{2}\s*[-–—to]+\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:(?:19|20)\d{2}|present|current|now)\b/i.test(
          line
        )
      ) {
        flushBlock();
        inSkillsSection = false;
        continue;
      }
      if (currentBlock.length >= 30) {
        flushBlock();
        inSkillsSection = false;
        continue;
      }
      currentBlock.push(line);
    }
  }
  flushBlock();

  for (const block of sectionBlocks) {
    if (block.length === 0) continue;

    const bulletStartRegex = /^(?:(?:â€¢|Â·|[•●▪◦❖➢➤✓✔★☆\-*–—"'“”·])|\d+[.)])\s+/;
    const bulletLineCount = block.filter((l) => bulletStartRegex.test(l)).length;
    const mostlyBulleted = bulletLineCount >= 2 && bulletLineCount >= block.length * 0.4;

    const mergedLines: string[] = [];
    for (let i = 0; i < block.length; i++) {
      const curr = block[i].trim();
      if (!curr) continue;

      if (mergedLines.length > 0) {
        const prev = mergedLines[mergedLines.length - 1];
        const prevCommas = countTopLevelCommas(prev);
        const currCommas = countTopLevelCommas(curr);
        const prevEndsWithDelimiter = /[,;.|•●▪◦❖➢➤)\]]$/.test(prev);
        const currStartsWithBulletOrLabel =
          bulletStartRegex.test(curr) || /^[A-Za-z0-9\s&/\-()]{2,32}:\s*/.test(curr);

        const openParens = (prev.match(/\(/g) || []).length;
        const closeParens = (prev.match(/\)/g) || []).length;
        const hasUnclosedParen = openParens > closeParens;

        const prevEndsWithConnector =
          /\b(?:and|&|or|of|for|in|to|with)\s*$/i.test(prev) || /[\/\-–]$/.test(prev);

        const isWrappedCommaParagraph =
          !prevEndsWithDelimiter &&
          !currStartsWithBulletOrLabel &&
          ((prevCommas >= 2 && currCommas >= 1) || (prevCommas >= 1 && currCommas >= 2));

        const isWrappedSidebarBullet =
          mostlyBulleted &&
          bulletStartRegex.test(prev) &&
          !currStartsWithBulletOrLabel &&
          curr.split(/\s+/).length <= 5 &&
          !prevEndsWithDelimiter;

        if (
          hasUnclosedParen ||
          prevEndsWithConnector ||
          isWrappedCommaParagraph ||
          isWrappedSidebarBullet
        ) {
          mergedLines[mergedLines.length - 1] = `${prev} ${curr}`;
          continue;
        }
      }

      mergedLines.push(curr);
    }

    for (const rawLine of mergedLines) {
      let lineToParse = rawLine.replace(bulletStartRegex, '').trim();
      if (!lineToParse) continue;

      const categoryMatch = lineToParse.match(/^([A-Za-z0-9\s&/\-()]{2,35}):\s*(.*)$/);
      if (categoryMatch) {
        const prefixWords = categoryMatch[1].trim().split(/\s+/).length;
        if (prefixWords <= 5) {
          lineToParse = categoryMatch[2].trim();
          if (!lineToParse) continue;
        }
      }

      const spacedSlashes = (lineToParse.match(/\s\/\s/g) || []).length >= 2;
      const parts = splitOutsideParentheses(lineToParse, spacedSlashes);
      for (const part of parts) {
        const subParts = part.split(/\s{3,}|\t+/);
        for (const sp of subParts) {
          addSkill(sp);
        }
      }
    }
  }

  return skillsFromSection;
}

// ============================================================================
// DEEP JOB POSITION RECOGNITION & EXTRACTION ENGINE (Supports Global Hire 360's
// 5 core roles AND any other job position written in the candidate's PDF/DOCX)
// ============================================================================
const JOB_TITLE_HEAD_NOUN_REGEX =
  /\b(?:assistant|specialist|representative|coordinator|manager|director|engineer|developer|analyst|designer|consultant|administrator|officer|associate|advisor|executive|technician|operator|clerk|strategist|architect|accountant|bookkeeper|recruiter|writer|editor|marketer|producer|controller|comptroller|supervisor|trainer|instructor|teacher|professor|tutor|lecturer|researcher|scientist|biologist|chemist|physicist|paralegal|lawyer|attorney|counsel|nurse|physician|doctor|pharmacist|therapist|counselor|caregiver|scribe|coder|planner|buyer|auditor|programmer|videographer|photographer|illustrator|animator|copywriter|journalist|receptionist|secretary|transcriptionist|typist|scheduler|dispatcher|moderator|concierge|lead|chief|head|president|vp|founder|co-founder|partner|intern|trainee|apprentice|fellow|support|service|services|success|data\s+entry|customer\s+care|client\s+care|help\s*desk|service\s*desk|call\s*center|contact\s*center|devops|sre|qa|ui\/ux|ux|ui|seo|sem|pr|hr|bdr|sdr|csr|gva|cpa|rn|lpn|teller|banker|underwriter|actuary|broker|agent|realtor|chef|electrician|mechanic|plumber|carpenter|welder|machinist|inspector|surveyor|estimator|drafter|driver|courier|logistics|procurement|purchasing|merchandiser|stylist|translator|interpreter|développeur|ingénieur|comptable|secrétaire|gestionnaire|conseiller|technicien|analyste)\b/i;

const NON_JOB_TITLE_NOISE_REGEX =
  /(?:@|https?:\/\/|www\.|linkedin\.com|github\.com|\b\d{3}[-.\s()]+\d{3}|\b(?:bachelor|master|b\.?sc|m\.?sc|b\.?a|m\.?b\.?a|ph\.?d|hnd|diploma|high\s+school|university|college|institute|academy|school\s+of|faculty\s+of|degree\s+in|certification|certified\s+in|references\s+available|available\s+upon\s+request|curriculum\s+vitae|resume|date\s+of\s+birth|nationality|marital\s+status|languages?\s*:|street|avenue|road|boulevard|p\.?o\.?\s*box)\b)/i;

function formatJobTitleCase(raw: string): string {
  const upperAcronyms = new Set([
    'UI',
    'UX',
    'UI/UX',
    'IT',
    'HR',
    'PR',
    'QA',
    'SEO',
    'SEM',
    'CRM',
    'ERP',
    'SAP',
    'SQL',
    'AWS',
    'GCP',
    'AI',
    'ML',
    'BI',
    'VP',
    'CEO',
    'CFO',
    'CTO',
    'COO',
    'CIO',
    'CPA',
    'RN',
    'LPN',
    'BDR',
    'SDR',
    'CSR',
    'GVA',
    'SRE',
    'B2B',
    'B2C',
    'API',
  ]);
  const lowerConnectors = new Set(['and', 'or', 'of', 'for', 'in', 'to', 'at', 'by', 'with', 'on']);

  return raw
    .trim()
    .split(/\s+/)
    .map((word, idx) => {
      const upper = word.toUpperCase();
      if (upperAcronyms.has(upper)) return upper;
      if (word.includes('/')) {
        return word
          .split('/')
          .map((p) => (upperAcronyms.has(p.toUpperCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
          .join('/');
      }
      if (word.includes('-')) {
        return word
          .split('-')
          .map((p) => ( p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p ))
          .join('-');
      }
      const lower = word.toLowerCase();
      if (idx > 0 && lowerConnectors.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function cleanAndValidateJobTitleCandidate(
  rawCandidate: string,
  candidateNameLine = ''
): string | null {
  if (!rawCandidate) return null;

  let cleaned = rawCandidate
    .replace(/^(?:(?:â€¢|Â·|[\s•●▪◦❖➢➤✓✔★☆\-*–—:|/"'“”‘’·])+|\d+[.)]\s+)/, '')
    .replace(
      /^(?:job\s+title|target\s+(?:job|role|position)|desired\s+(?:job|role|position)|position\s+applied\s+for|applying\s+for|position|role|title|poste|intitulé\s+du\s+poste)\s*[:\-–—]\s*/i,
      ''
    )
    // Strip trailing date ranges e.g. "(2022 - Present)" or "Nov 2023 - Present"
    .replace(
      /\s*(?:\(|\b)(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:19|20)\d{2}\s*[-–—to]+\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:(?:19|20)\d{2}|present|current|now)\)?.*$/i,
      ''
    )
    .replace(/\b(?:cv|resume|curriculum\s+vitae)\b/gi, '')
    .replace(/(?:â€¢|Â·|[\s•●▪◦❖➢➤✓✔★☆\-*–—:|/.,;()[\]"'“”‘’·])+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 3 || cleaned.length > 58) return null;
  if (NON_JOB_TITLE_NOISE_REGEX.test(cleaned)) return null;
  if (isSkillsSectionHeader(cleaned) || isStopSectionHeader(cleaned)) return null;

  // Reject if it matches the candidate's own name line
  if (
    candidateNameLine &&
    cleaned.toLowerCase() === candidateNameLine.toLowerCase().trim()
  ) {
    return null;
  }

  // Reject if it contains digits (unless 1st/2nd/3rd line support, B2B/B2C, L1/L2/L3, Tier 1/2/3, 3D)
  if (/\d/.test(cleaned) && !/\b(?:b2b|b2c|l[123]|tier\s*[123]|3d|1st|2nd|3rd)\b/i.test(cleaned)) {
    return null;
  }

  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 7) return null;

  // Reject sentences starting with past-tense verbs or pronouns
  if (
    /^(?:i\s+am|my\s+|worked|managed|developed|created|assisted|built|designed|supported|handled|resolved|provided|ensured|performed|volunteered|contributed|wrote|maintained|led|organized|processed|collaborated|served|answered|experienced\s+in|skilled\s+in|proficient\s+in|responsible\s+for)\b/i.test(
      cleaned
    )
  ) {
    return null;
  }

  // Must contain a genuine recognizable job title head-noun / role keyword
  if (!JOB_TITLE_HEAD_NOUN_REGEX.test(cleaned)) {
    return null;
  }

  return formatJobTitleCase(cleaned);
}

function extractJobTitleFromCompositeLine(line: string, candidateNameLine = ''): string | null {
  // First try the whole line
  const direct = cleanAndValidateJobTitleCandidate(line, candidateNameLine);
  if (direct && direct.split(/\s+/).length <= 5) {
    return direct;
  }

  // Try splitting on common composite delimiters: "|", "—", "–", " - ", " at ", ","
  const segments = line.split(/\s*(?:\||—|–|\s-\s|\bat\b|,|•|●)\s*/i);
  for (const seg of segments) {
    const valid = cleanAndValidateJobTitleCandidate(seg, candidateNameLine);
    if (valid) return valid;
  }

  return direct;
}

function mapTitleToGlobalHireRoleOrNull(title: string): string | null {
  const t = title.toLowerCase();

  // Check if title explicitly matches one of the 5 Global Hire 360 positions:
  if (
    /\b(?:virtual\s+assistant|general\s+virtual\s+assistant|remote\s+virtual\s+assistant|virtual\s+administrative\s+assistant|gohighlevel\s+virtual\s+assistant|gva)\b/i.test(
      t
    )
  ) {
    return 'Virtual Assistant';
  }

  if (
    /\b(?:executive\s+assistant|senior\s+executive\s+assistant|c[\s-]?(?:suite|level)\s+assistant|executive\s+(?:personal\s+assistant|support|coordinator|secretary)|personal\s+assistant\s+to\s+(?:the\s+)?(?:ceo|president|director|executive|founder|vp)|assistant\s+to\s+(?:the\s+)?(?:ceo|president|director|executive|founder|vp))\b/i.test(
      t
    )
  ) {
    return 'Executive Assistant';
  }

  if (
    /\b(?:data\s+entry|data\s+(?:processing|management|verification|cleansing)\s+(?:clerk|specialist|operator|associate|assistant|technician)|(?:database|records|information)\s+clerk|transcriptionist|typist)\b/i.test(
      t
    )
  ) {
    return 'Data Entry';
  }

  if (
    /\b(?:customer\s+(?:service|support|success|care|experience|relations)|(?:customer\s+)?success\s*(?:&|and)?\s*support|support\s*(?:&|and)?\s*success|client\s+(?:service|services|support|success|care|relations)|(?:call\s+center|contact\s+center|help\s*desk|service\s+desk|technical\s+support)(?:\s+(?:agent|representative|specialist|associate|advisor|support))?|support\s+(?:specialist|representative|agent|associate|advisor))\b/i.test(
      t
    )
  ) {
    return 'Customer Service';
  }

  if (
    /\b(?:admin(?:istrative)?\s+(?:support|assistant|coordinator|specialist|officer|associate|clerk)|office\s+(?:administrator|assistant|coordinator|manager|support|clerk)|back[\s-]?office\s+(?:support|assistant|specialist|coordinator|associate)|(?:clerical|operations)\s+(?:support|assistant|specialist|coordinator|associate|clerk)|receptionist|front\s+desk|secretary)\b/i.test(
      t
    )
  ) {
    return 'Admin Support';
  }

  return null;
}

/**
 * Deeply searches the candidate's PDF/DOCX resume across Headline, Summary/Objective,
 * Work Experience / Employment History, Filename, and Skills to find the exact job position.
 * - If the candidate's position corresponds to one of Global Hire 360's 5 roles
 *   (Customer Service, Virtual Assistant, Data Entry, Admin Support, Executive Assistant),
 *   returns that canonical role confirmed with skills.
 * - If the candidate's resume is for ANY OTHER role (e.g., Software Developer, Project Manager,
 *   Graphic Designer, Data Analyst, Accountant, Digital Marketing Specialist, HR Manager, etc.),
 *   returns the exact job position extracted from the resume without forcing an unrelated role!
 */
function deepExtractJobPositionFromResume(
  rawText: string,
  fileName: string,
  extractedSkills: string[],
  hasExplicitSkills: boolean
): string {
  const lines = rawText
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => collapseSpacedHeading(l.trim()))
    .filter(Boolean);

  const candidateNameLine = lines[0] || '';

  // Find index of first major section header
  let firstSectionIdx = lines.findIndex(
    (l, idx) => idx > 0 && (isSkillsSectionHeader(l) || isStopSectionHeader(l))
  );
  if (firstSectionIdx === -1) firstSectionIdx = Math.min(lines.length, 8);

  // --------------------------------------------------------------------------
  // 1. EXTRACT HEADLINE JOB POSITION (Top lines right under candidate's name)
  // --------------------------------------------------------------------------
  let headlinePosition: string | null = null;
  // Check if Line 0 has "Name | Job Title" or "Name - Job Title"
  if (/[|—–]|\s-\s/.test(candidateNameLine)) {
    const parts = candidateNameLine.split(/\s*(?:\||—|–|\s-\s)\s*/);
    for (let i = 1; i < parts.length; i++) {
      const candidate = cleanAndValidateJobTitleCandidate(parts[i], candidateNameLine);
      if (candidate) {
        headlinePosition = candidate;
        break;
      }
    }
  }
  if (!headlinePosition) {
    const headerLimit = Math.min(firstSectionIdx, 8);
    for (let i = 1; i < headerLimit; i++) {
      const candidate = extractJobTitleFromCompositeLine(lines[i], candidateNameLine);
      if (candidate) {
        headlinePosition = candidate;
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 2. EXTRACT SUMMARY / PROFILE / OBJECTIVE TARGET POSITION
  // --------------------------------------------------------------------------
  let summaryPosition: string | null = null;
  const summaryHeaderIdx = lines.findIndex((l) =>
    /^(?:professional\s+summary|executive\s+summary|career\s+summary|summary|profile|personal\s+profile|profil(?:\s+professionnel)?|résumé|career\s+objective|objective|about\s+me)$/i.test(
      cleanSectionHeaderCandidate(l)
    )
  );
  const summaryBlock =
    summaryHeaderIdx !== -1
      ? lines.slice(summaryHeaderIdx + 1, summaryHeaderIdx + 7).join(' ')
      : lines.slice(1, 10).join(' ');

  const summaryPatterns: RegExp[] = [
    /\b(?:seeking|applying\s+for|looking\s+for|obtain|pursue)\s+(?:a\s+|an\s+)?(?:position|role|opportunity|job|career)\s+as\s+(?:a\s+|an\s+)?([A-Za-z0-9/&+.\-\s]{3,42}?)(?:\s+(?:at|with|in|where|to|for)\b|[.,;]|$)/i,
    /\b(?:dedicated|detail[\s-]?oriented|experienced|results[\s-]?driven|motivated|passionate|seasoned|certified|skilled|accomplished|creative|dynamic|proactive|bilingual|professional|aspiring|versatile|strategic|analytical|resourceful|dependable|reliable|enthusiastic|highly\s+[\w-]+)(?:(?:\s*,\s*|\s+(?:and|&)\s+|\s+)(?:dedicated|detail[\s-]?oriented|experienced|results[\s-]?driven|motivated|passionate|seasoned|certified|skilled|accomplished|creative|dynamic|proactive|bilingual|professional|aspiring|versatile|strategic|analytical|resourceful|dependable|reliable|enthusiastic))*\s+([A-Za-z0-9/&+.\-\s]{3,40}?)\s+(?:with\s+(?:over\s+)?\d+|with\s+experience|with\s+a\s+(?:strong|proven|solid|track|background)|specializing\s+in|skilled\s+in|experienced\s+in|who\s+|offering|bringing|focused\s+on|adept\s+at|passionate\s+about)/i,
    /^([A-Za-z0-9/&+.\-\s]{3,38}?)\s+(?:with\s+(?:over\s+)?\d+\+?\s+years|with\s+experience\s+supporting|with\s+experience\s+in|specializing\s+in|experienced\s+in)/i,
  ];

  for (const rx of summaryPatterns) {
    const m = summaryBlock.match(rx);
    if (m && m[1]) {
      const validated = cleanAndValidateJobTitleCandidate(m[1], candidateNameLine);
      if (validated) {
        summaryPosition = validated;
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 3. EXTRACT MOST RECENT JOB POSITION IN WORK EXPERIENCE / EMPLOYMENT HISTORY
  // --------------------------------------------------------------------------
  let firstExperiencePosition: string | null = null;
  const allExperiencePositions: string[] = [];
  const expHeaderIdx = lines.findIndex((l) =>
    /^(?:work\s+experience|professional\s+experience|employment\s+history|work\s+history|career\s+history|relevant\s+experience|experience|employment|expérience\s+professionnelle|parcours\s+professionnel)$/i.test(
      cleanSectionHeaderCandidate(l)
    )
  );

  if (expHeaderIdx !== -1) {
    for (let i = expHeaderIdx + 1; i < Math.min(lines.length, expHeaderIdx + 35); i++) {
      const line = lines[i];
      if (isSkillsSectionHeader(line) || (isStopSectionHeader(line) && i > expHeaderIdx + 1)) {
        break;
      }
      // Skip bullet points describing responsibilities
      if (/^[•●▪◦❖➢➤✓✔★☆\-*]\s+/.test(line)) continue;
      // Skip pure date lines
      if (
        /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:19|20)\d{2}\s*[-–—to]+\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:(?:19|20)\d{2}|present|current|now)$/i.test(
          line
        )
      ) {
        continue;
      }

      const candidate = extractJobTitleFromCompositeLine(line, candidateNameLine);
      if (candidate) {
        if (!firstExperiencePosition) {
          firstExperiencePosition = candidate;
        }
        allExperiencePositions.push(candidate);
      }
    }
  }

  // --------------------------------------------------------------------------
  // 4. EXTRACT POSITION FROM FILENAME (IF PRESENT)
  // --------------------------------------------------------------------------
  let fileNamePosition: string | null = null;
  const rawFileBase = (fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(?:cv|resume|curriculum\s+vitae|updated|final|copy|\d+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (rawFileBase) {
    const mappedFileRole = mapTitleToGlobalHireRoleOrNull(rawFileBase);
    if (mappedFileRole) {
      fileNamePosition = mappedFileRole;
    } else {
      // Remove candidate's name words from filename to see if a job title remains
      const nameWords = new Set(
        candidateNameLine
          .toLowerCase()
          .replace(/[^a-z\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 2)
      );
      const remainingWords = rawFileBase
        .split(/\s+/)
        .filter((w) => !nameWords.has(w.toLowerCase()));
      const remainingPhrase = remainingWords.join(' ').trim();
      const validatedFileTitle = cleanAndValidateJobTitleCandidate(remainingPhrase, candidateNameLine);
      if (validatedFileTitle) {
        fileNamePosition = validatedFileTitle;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 5. DECIDE BETWEEN GLOBAL HIRE 360 ROLES VS. SPECIFIC NON-PROPOSED ROLES
  // --------------------------------------------------------------------------
  const primaryStatedTitle =
    headlinePosition ||
    summaryPosition ||
    firstExperiencePosition ||
    fileNamePosition ||
    allExperiencePositions[0] ||
    null;

  // Check if the candidate's Headline, Summary, Most Recent Job, or Filename maps to one of the 5 Global Hire 360 positions
  const headlineGH = headlinePosition ? mapTitleToGlobalHireRoleOrNull(headlinePosition) : null;
  const summaryGH = summaryPosition ? mapTitleToGlobalHireRoleOrNull(summaryPosition) : null;
  const firstExpGH = firstExperiencePosition ? mapTitleToGlobalHireRoleOrNull(firstExperiencePosition) : null;
  const fileGH = fileNamePosition ? mapTitleToGlobalHireRoleOrNull(fileNamePosition) : null;

  // If the candidate's explicit Headline or Summary is a specific role OUTSIDE the 5 Global Hire 360 positions
  // (e.g., "Full-Stack Web Developer", "Project Manager", "Graphic Designer", "Data Analyst", "Accountant", etc.)
  // and neither the Headline, Summary, nor Filename claims a Global Hire 360 role, return their exact position!
  if (headlinePosition && !headlineGH && !fileGH) {
    return headlinePosition;
  }
  if (!headlinePosition && summaryPosition && !summaryGH && !fileGH) {
    return summaryPosition;
  }
  if (!headlinePosition && !summaryPosition && firstExperiencePosition && !firstExpGH && !fileGH) {
    return firstExperiencePosition;
  }
  if (!headlinePosition && !summaryPosition && !firstExperiencePosition && fileNamePosition && !fileGH) {
    return fileNamePosition;
  }

  // Otherwise, score the 5 Global Hire 360 roles and confirm with skills
  const headlineZone = lines.slice(0, 8).join('\n').toLowerCase();
  const summaryZone = lines.slice(1, 18).join('\n').toLowerCase();
  const firstJobZone =
    expHeaderIdx !== -1 ? lines.slice(expHeaderIdx + 1, expHeaderIdx + 8).join('\n').toLowerCase() : '';
  const fullLower = rawText.toLowerCase();
  const skillsLower = extractedSkills.join(' , ').toLowerCase();
  const cleanFileName = (fileName || '').replace(/[_-]+/g, ' ').replace(/\.[^.]+$/, '');

  const positionRules: {
    role: string;
    exactTitlePhrases: RegExp[];
    fileNamePhrases: RegExp[];
    skillConfirmationPatterns: RegExp[];
  }[] = [
    {
      role: 'Customer Service',
      exactTitlePhrases: [
        /\bcustomer\s+service(?:\s+(?:representative|specialist|agent|associate|advisor|executive|officer|lead|coordinator|manager|professional))?\b/i,
        /\bcustomer\s+support(?:\s+(?:representative|specialist|agent|associate|advisor|executive|officer|lead|coordinator|manager|engineer|professional))?\b/i,
        /\bcustomer\s+success(?:\s+(?:representative|specialist|agent|associate|advisor|executive|officer|lead|coordinator|manager|professional))?\b/i,
        /\b(?:customer\s+)?success\s*(?:&|and)?\s*support\b/i,
        /\bsupport\s*(?:&|and)?\s*success\b/i,
        /\bclient\s+(?:service|services|support|success|care|relations)(?:\s+(?:representative|specialist|associate|coordinator|manager|advisor|agent|officer))?\b/i,
        /\bcustomer\s+(?:care|experience|relations)(?:\s+(?:representative|specialist|agent|associate|advisor|coordinator|manager|lead))?\b/i,
        /\b(?:call\s+center|contact\s+center|help\s*desk|service\s+desk|technical\s+support)\s*(?:agent|representative|specialist|associate|advisor|analyst|engineer|support)?\b/i,
        /\bsupport\s+(?:specialist|representative|agent|associate|advisor|lead)\b/i,
      ],
      fileNamePhrases: [
        /\bcustomer\s*service\b/i,
        /\bcustomer\s*support\b/i,
        /\bcustomer\s*success\b/i,
        /\bsuccess\s*(?:&|and)?\s*support\b/i,
        /\bsupport\s*(?:&|and)?\s*success\b/i,
        /\bclient\s*(?:support|service|success)\b/i,
        /\bcustomer\s*care\b/i,
        /\bcall\s*center\b/i,
        /\bhelp\s*desk\b/i,
        /\bcsr\b/i,
      ],
      skillConfirmationPatterns: [
        /\bcustomer\s+service\b/i,
        /\bcustomer\s+support\b/i,
        /\bcustomer\s+success\b/i,
        /\bclient\s+(?:support|success|service|services|care|onboarding|retention)\b/i,
        /\bcustomer\s+(?:care|experience|satisfaction|retention)\b/i,
        /\blive\s+chat\b/i,
        /\b(?:email|chat|phone|omnichannel|multi[\s-]?channel)\s+support\b/i,
        /\binbound\b/i,
        /\boutbound\b/i,
        /\bticket(?:ing|\s+resolution|\s+management)?\b/i,
        /\bzendesk\b/i,
        /\bfreshdesk\b/i,
        /\bintercom\b/i,
        /\bhelp\s*desk\b/i,
        /\bde[\s-]?escalation\b/i,
        /\bconflict\s+resolution\b/i,
        /\bactive\s+listening\b/i,
        /\bempathy\b/i,
        /\bcsat\b/i,
        /\bnps\b/i,
        /\bsla\b/i,
        /\bcall\s+(?:center|handling)\b/i,
        /\btroubleshooting\b/i,
        /\bcrm\b/i,
        /\bhubspot\b/i,
        /\bsalesforce\b/i,
      ],
    },
    {
      role: 'Virtual Assistant',
      exactTitlePhrases: [
        /\bvirtual\s+assistant\b/i,
        /\bgeneral\s+virtual\s+assistant\b/i,
        /\bremote\s+virtual\s+assistant\b/i,
        /\bvirtual\s+administrative\s+assistant\b/i,
        /\bgohighlevel\s+(?:virtual\s+assistant|administrator|specialist)\b/i,
        /\b(?:marketing|real\s+estate|e[\s-]?commerce|medical)\s+virtual\s+assistant\b/i,
      ],
      fileNamePhrases: [
        /\bvirtual\s*assistant\b/i,
        /\bgva\b/i,
        /\bva\s+cv\b/i,
        /\bva\s+resume\b/i,
      ],
      skillConfirmationPatterns: [
        /\bvirtual\s+assistance\b/i,
        /\bgohighlevel\b/i,
        /\bsales\s+funnel\b/i,
        /\blanding\s+page\b/i,
        /\bworkflow\s+automation\b/i,
        /\bapi\s+and\s+third[\s-]?party\s+integrations\b/i,
        /\bzapier\b/i,
        /\bn8n\b/i,
        /\bsysteme\.io\b/i,
        /\bcrm\s+management\b/i,
        /\bemail\s+and\s+chat\s+support\b/i,
        /\binbox\s+management\b/i,
        /\bcalendar\s+management\b/i,
        /\bsocial\s+media\s+management\b/i,
      ],
    },
    {
      role: 'Data Entry',
      exactTitlePhrases: [
        /\bdata\s+entry(?:\s+(?:clerk|specialist|operator|associate|assistant|technician|processor|analyst|professional))?\b/i,
        /\bdata\s+(?:processing|management|verification|cleansing)\s+(?:clerk|specialist|operator|associate|assistant|technician)\b/i,
        /\b(?:database|records|information)\s+clerk\b/i,
        /\btranscriptionist\b/i,
      ],
      fileNamePhrases: [
        /\bdata\s*entry\b/i,
        /\bdata\s*clerk\b/i,
        /\bdata\s*processing\b/i,
        /\bdata\s*specialist\b/i,
      ],
      skillConfirmationPatterns: [
        /\bdata\s+entry\b/i,
        /\btyping\s+speed\b/i,
        /\b\d{2,3}\s*wpm\b/i,
        /\btouch\s+typing\b/i,
        /\b10[\s-]?key\b/i,
        /\bdata\s+(?:verification|cleansing|cleaning|validation|accuracy|processing|capture|migration|mining)\b/i,
        /\bspreadsheet\b/i,
        /\bmicrosoft\s+excel\b/i,
        /\bexcel\b/i,
        /\bvlookup\b/i,
        /\bpivot\s+table\b/i,
        /\bgoogle\s+sheets\b/i,
        /\bdatabase\s+(?:management|updating|administration)\b/i,
      ],
    },
    {
      role: 'Admin Support',
      exactTitlePhrases: [
        /\badmin(?:istrative)?\s+support(?:\s+(?:specialist|associate|coordinator|assistant|officer))?\b/i,
        /\badmin(?:istrative)?\s+(?:assistant|coordinator|specialist|officer|associate|clerk|professional)\b/i,
        /\boffice\s+(?:administrator|assistant|coordinator|manager|support|clerk)\b/i,
        /\bback[\s-]?office\s+(?:support|assistant|specialist|coordinator|associate)\b/i,
        /\b(?:clerical|operations)\s+(?:support|assistant|specialist|coordinator|associate|clerk)\b/i,
        /\b(?:receptionist|front\s+desk\s+(?:coordinator|officer|assistant)|secretary)\b/i,
      ],
      fileNamePhrases: [
        /\badmin(?:istrative)?\s*support\b/i,
        /\badmin(?:istrative)?\s*assistant\b/i,
        /\boffice\s*admin\b/i,
        /\bback\s*office\b/i,
        /\bclerical\b/i,
      ],
      skillConfirmationPatterns: [
        /\badministrative\s+support\b/i,
        /\badmin\s+support\b/i,
        /\boffice\s+(?:administration|management)\b/i,
        /\bdocument\s+(?:preparation|control|management)\b/i,
        /\brecord\s+keeping\b/i,
        /\bfiling\b/i,
        /\bappointment\s+scheduling\b/i,
        /\bmicrosoft\s+office\b/i,
        /\bms\s+office\b/i,
        /\bgoogle\s+workspace\b/i,
        /\bdata\s+organization\b/i,
        /\breport\s+preparation\b/i,
        /\binvoicing\b/i,
      ],
    },
    {
      role: 'Executive Assistant',
      exactTitlePhrases: [
        /\bexecutive\s+assistant\b/i,
        /\bsenior\s+executive\s+assistant\b/i,
        /\bc[\s-]?(?:suite|level)\s+assistant\b/i,
        /\bexecutive\s+(?:personal\s+assistant|support|coordinator|secretary)\b/i,
        /\bpersonal\s+assistant\s+to\s+(?:the\s+)?(?:ceo|president|director|executive|founder|vp|managing\s+director)\b/i,
        /\bassistant\s+to\s+(?:the\s+)?(?:ceo|president|director|executive|founder|vp|managing\s+director)\b/i,
        /\bchief\s+of\s+staff\b/i,
      ],
      fileNamePhrases: [
        /\bexecutive\s*assistant\b/i,
        /\bexec\s*assistant\b/i,
        /\bc[\s-]?suite\b/i,
      ],
      skillConfirmationPatterns: [
        /\bexecutive\s+(?:support|assistance|calendar)\b/i,
        /\bc[\s-]?(?:suite|level)\b/i,
        /\bboard\s+(?:meeting|pack|presentation)\b/i,
        /\bcomplex\s+calendar\b/i,
        /\bdiary\s+management\b/i,
        /\bconfidential\s+correspondence\b/i,
        /\btravel\s+(?:coordination|arrangements|itinerar|management|booking)\b/i,
        /\bgatekeep(?:er|ing)\b/i,
        /\bexpense\s+report(?:s|ing)\b/i,
        /\bstakeholder\s+management\b/i,
      ],
    },
  ];

  let bestRole = '';
  let bestTitleScore = 0;
  let bestTotalScore = 0;

  for (const rule of positionRules) {
    let titleScore = 0;
    let skillScore = 0;

    for (const fnRx of rule.fileNamePhrases) {
      if (fnRx.test(cleanFileName)) {
        titleScore += 55;
      }
    }

    for (const titleRx of rule.exactTitlePhrases) {
      if (titleRx.test(headlineZone)) {
        titleScore += 70;
      }
      if (titleRx.test(summaryZone)) {
        titleScore += 45;
      }
      if (firstJobZone && titleRx.test(firstJobZone)) {
        titleScore += 35;
      }
      const allMatches = fullLower.match(new RegExp(titleRx.source, 'gi'));
      if (allMatches) {
        titleScore += Math.min(30, allMatches.length * 10);
      }
    }

    const skillWeight = hasExplicitSkills ? 8 : 3;
    for (const skillRx of rule.skillConfirmationPatterns) {
      if (skillRx.test(skillsLower)) {
        skillScore += skillWeight;
      } else if (skillRx.test(fullLower)) {
        skillScore += 2;
      }
    }

    const total = titleScore + skillScore;
    if (total > bestTotalScore) {
      bestTotalScore = total;
      bestTitleScore = titleScore;
      bestRole = rule.role;
    }
  }

  // Only attribute a Global Hire 360 position if the resume actually mentions that title (bestTitleScore >= 20)
  // or has strong explicit skill confirmation (>= 24) when no other stated title exists
  if (bestRole && (bestTitleScore >= 20 || (!primaryStatedTitle && bestTotalScore >= 24))) {
    return bestRole;
  }

  // If the resume has any stated job title anywhere in Headline, Summary, Experience, or Filename, return it!
  if (primaryStatedTitle) {
    return primaryStatedTitle;
  }

  // Last-resort deep scan across all lines of the resume for any recognizable job position line
  for (const line of lines) {
    if (line.split(/\s+/).length <= 5) {
      const candidate = cleanAndValidateJobTitleCandidate(line, candidateNameLine);
      if (candidate) return candidate;
    }
  }

  return bestRole || 'Customer Service';
}

// ============================================================================
// ESSENTIAL EMPLOYER SKILLS SELECTOR (1 to 5 Max Most Relevant Hard/Core Skills)
// ============================================================================
const GENERIC_SOFT_SKILL_FILLER_REGEX =
  /^(?:(?:strong|excellent|good|effective|advanced|proven|solid|great|exceptional|outstanding|interpersonal|verbal|written|oral|professional|business|clear)\s+)*(?:time\s+management|communication(?:\s+skills)?|problem[\s-]?solving(?:\s+skills)?|attention\s+to\s+detail|detail[\s-]?oriented|teamwork|team\s+player|collaboration|team\s+collaboration|adaptability|flexibility|quick\s+learner|fast\s+learner|work\s+ethic|self[\s-]?motivated|self[\s-]?starter|punctuality|reliability|dependability|interpersonal(?:\s+skills)?|people\s+skills|positive\s+attitude|multitasking|multi[\s-]?tasking|working\s+under\s+pressure|ability\s+to\s+work\s+under\s+pressure|stress\s+management|critical\s+thinking|analytical\s+thinking|creativity|creative\s+thinking|empathy|patience|active\s+listening|listening\s+skills|organizational\s+skills|organization|leadership(?:\s+skills)?|decision[\s-]?making|emotional\s+intelligence|computer\s+literacy|basic\s+computer(?:\s+skills)?|internet(?:\s+research|\s+browsing)?|web\s+browsing|windows(?:\s+os|\s+10|\s+11)?|mac\s*os)(?:\s+(?:and|&|\/)\s+(?:(?:strong|excellent|good|effective|verbal|written)\s+)*(?:time\s+management|communication(?:\s+skills)?|problem[\s-]?solving|attention\s+to\s+detail|teamwork|collaboration|adaptability|critical\s+thinking|empathy|active\s+listening|leadership|multitasking|organization))*$/i;

function getRoleRelevancePatterns(role: string): RegExp[] {
  const r = role.toLowerCase();

  if (r.includes('virtual assistant')) {
    return [
      /\bvirtual\s+assistance\b/i,
      /\bgohighlevel\b/i,
      /\bcrm\b/i,
      /\bworkflow\s+automation\b/i,
      /\bsales\s+funnel\b/i,
      /\blanding\s+page\b/i,
      /\b(?:email|inbox|calendar|schedule|travel)\s+management\b/i,
      /\bapi\b|\bintegrations?\b|\bzapier\b|\bn8n\b|\bsysteme\.io\b|\bmake\.com\b/i,
      /\bemail\s+and\s+chat\s+support\b/i,
      /\bappointment\s+(?:setting|scheduling)\b/i,
      /\bsocial\s+media\s+management\b/i,
      /\bdata\s+organization\b/i,
    ];
  }

  if (r.includes('customer service') || r.includes('customer support') || r.includes('customer success') || r.includes('support')) {
    return [
      /\bcustomer\s+(?:service|support|success|care|experience|retention|satisfaction)\b/i,
      /\bclient\s+(?:support|success|service|onboarding|retention|relations)\b/i,
      /\bcrm\b|\bzendesk\b|\bfreshdesk\b|\bhubspot\b|\bsalesforce\b|\bintercom\b/i,
      /\b(?:live\s+chat|email|phone|multi[\s-]?channel|omnichannel)\s+support\b|\blive\s+chat\b/i,
      /\bticket(?:ing|\s+resolution|\s+management)\b|\bescalation\b/i,
      /\bde[\s-]?escalation\b|\bconflict\s+resolution\b/i,
      /\btroubleshooting\b|\btechnical\s+support\b|\bhelp\s*desk\b/i,
      /\binbound\b|\boutbound\b|\bcall\s+(?:center|handling)\b|\bcsat\b|\bsla\b/i,
    ];
  }

  if (r.includes('data entry') || r.includes('data clerk') || r.includes('transcription')) {
    return [
      /\bdata\s+(?:entry|verification|cleansing|cleaning|validation|processing|migration|mining|capture|accuracy)\b/i,
      /\btyping\b|\b\d{2,3}\s*wpm\b|\b10[\s-]?key\b/i,
      /\bexcel\b|\bvlookup\b|\bpivot\s+table|\bspreadsheet/i,
      /\bgoogle\s+sheets\b/i,
      /\bdatabase\b|\bcrm\b|\berp\b|\bsap\b/i,
      /\brecord\s+(?:keeping|updating|auditing)\b/i,
    ];
  }

  if (r.includes('executive assistant')) {
    return [
      /\bexecutive\s+(?:support|assistance|calendar)\b|\bc[\s-]?(?:suite|level)\b/i,
      /\bcalendar\s+management\b|\bdiary\s+management\b|\bscheduling\b/i,
      /\btravel\s+(?:coordination|arrangements|itinerar|management|booking)\b/i,
      /\bboard\s+(?:meeting|pack|presentation)\b/i,
      /\bconfidential\s+correspondence\b|\bgatekeep/i,
      /\bstakeholder\s+management\b|\bexpense\s+report/i,
      /\bevent\s+planning\b|\bproject\s+coordination\b/i,
    ];
  }

  if (r.includes('admin') || r.includes('office') || r.includes('receptionist') || r.includes('secretary') || r.includes('clerical')) {
    return [
      /\b(?:administrative|admin|office)\s+(?:support|administration|management|coordination)\b/i,
      /\bdocument\s+(?:preparation|control|management)\b|\breport\s+preparation\b/i,
      /\brecord\s+keeping\b|\bfiling\b|\bdata\s+organization\b/i,
      /\b(?:appointment|calendar|meeting)\s+(?:scheduling|coordination|management)\b/i,
      /\bmicrosoft\s+(?:office|excel|word|outlook|powerpoint)\b|\bms\s+office\b/i,
      /\bgoogle\s+workspace\b|\binvoicing\b|\bbookkeeping\b|\bvendor\b/i,
    ];
  }

  if (r.includes('developer') || r.includes('engineer') || r.includes('programmer') || r.includes('software') || r.includes('web') || r.includes('frontend') || r.includes('backend') || r.includes('full-stack') || r.includes('full stack') || r.includes('devops')) {
    return [
      /\b(?:javascript|typescript|python|java|c#|c\+\+|go|rust|php|ruby|swift|kotlin|sql)\b/i,
      /\b(?:react|next\.?js|vue|angular|svelte|node\.?js|express|nestjs|django|flask|spring|laravel|html5?|css3?|tailwind)\b/i,
      /\b(?:postgresql|mysql|mongodb|redis|supabase|firebase|prisma|graphql|rest\s*api)\b/i,
      /\b(?:aws|gcp|azure|docker|kubernetes|ci\/cd|git|linux|terraform)\b/i,
    ];
  }

  if (r.includes('design') || r.includes('ui') || r.includes('ux') || r.includes('graphic') || r.includes('creative') || r.includes('video') || r.includes('animator')) {
    return [
      /\b(?:figma|sketch|adobe\s+xd|photoshop|illustrator|indesign|after\s+effects|premiere\s+pro|canva|blender|cinema\s+4d)\b/i,
      /\b(?:ui\/ux|user\s+interface|user\s+experience|wireframing|prototyping|design\s+systems|user\s+research|usability)\b/i,
      /\b(?:brand\s+identity|typography|visual\s+design|responsive\s+design|motion\s+graphics|video\s+editing)\b/i,
    ];
  }

  if (r.includes('market') || r.includes('seo') || r.includes('social media') || r.includes('growth') || r.includes('content') || r.includes('copywrit')) {
    return [
      /\b(?:seo|sem|google\s+analytics|google\s+ads|meta\s+ads|facebook\s+ads|ppc|paid\s+media)\b/i,
      /\b(?:content\s+marketing|content\s+strategy|copywriting|email\s+marketing|social\s+media\s+management)\b/i,
      /\b(?:conversion\s+rate|sales\s+funnel|funnel\s+tracking|retargeting|lead\s+generation|hubspot|mailchimp|klaviyo)\b/i,
    ];
  }

  if (r.includes('accountant') || r.includes('bookkeeper') || r.includes('finance') || r.includes('financial') || r.includes('auditor') || r.includes('tax') || r.includes('payroll')) {
    return [
      /\b(?:financial\s+reporting|financial\s+modeling|financial\s+analysis|gaap|ifrs|general\s+ledger|accounts\s+payable|accounts\s+receivable|reconciliation)\b/i,
      /\b(?:quickbooks|xero|sap|oracle|netsuite|sage|excel|tax\s+preparation|payroll|auditing|budgeting|forecasting)\b/i,
    ];
  }

  if (r.includes('data analyst') || r.includes('business analyst') || r.includes('data scientist') || r.includes('bi ')) {
    return [
      /\b(?:sql|python|r\b|tableau|power\s+bi|looker|excel|vlookup|pivot\s+tables|pandas|numpy)\b/i,
      /\b(?:data\s+analysis|data\s+visualization|statistical\s+analysis|business\s+intelligence|etl|data\s+modeling|a\/b\s+testing|requirements\s+gathering)\b/i,
    ];
  }

  if (r.includes('project manager') || r.includes('program manager') || r.includes('product manager') || r.includes('scrum') || r.includes('operations')) {
    return [
      /\b(?:project\s+management|program\s+management|product\s+management|agile|scrum|kanban|waterfall|pmp|prince2)\b/i,
      /\b(?:jira|confluence|asana|trello|monday\.com|ms\s+project|clickup|notion)\b/i,
      /\b(?:roadmapping|stakeholder\s+management|risk\s+management|resource\s+allocation|kpi|process\s+improvement|change\s+management)\b/i,
    ];
  }

  if (r.includes('sales') || r.includes('account executive') || r.includes('business development') || r.includes('bdr') || r.includes('sdr')) {
    return [
      /\b(?:b2b\s+sales|b2c\s+sales|lead\s+generation|cold\s+calling|outbound\s+prospecting|pipeline\s+management|closing|contract\s+negotiation|account\s+management)\b/i,
      /\b(?:salesforce|hubspot|crm|zoho|pipedrive|linkedin\s+sales\s+navigator|revenue\s+growth)\b/i,
    ];
  }

  if (r.includes('hr') || r.includes('human resources') || r.includes('recruit') || r.includes('talent')) {
    return [
      /\b(?:full[\s-]?cycle\s+recruiting|talent\s+acquisition|sourcing|interviewing|onboarding|employee\s+relations|performance\s+management|hris|workday|bamboohr|ats|payroll|benefits\s+administration|labor\s+law)\b/i,
    ];
  }

  // Extract keywords from the role name itself
  const roleTokens = r
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^(?:senior|junior|lead|chief|head|entry|level|specialist|associate|assistant|manager|officer|coordinator)$/.test(w));
  return roleTokens.map((tok) => new RegExp(`\\b${tok}`, 'i'));
}

function extractVerbatimDomainSkillsFromResumeBody(rawText: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (val: string) => {
    const clean = val.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      found.push(clean);
    }
  };

  const verbatimPatterns: RegExp[] = [
    /\b\d{2,3}\s*WPM(?:\s+Typing(?:\s+Speed)?)?\b/gi,
    /\bCustomer\s+Service\b/gi,
    /\bCustomer\s+Support\b/gi,
    /\bCustomer\s+Success\b/gi,
    /\bClient\s+(?:Support|Success|Onboarding|Retention|Relations)\b/gi,
    /\bLive\s+Chat(?:\s+Support)?\b/gi,
    /\bEmail\s+(?:and\s+Chat\s+)?Support\b/gi,
    /\bPhone\s+Support\b/gi,
    /\bTicket(?:ing\s+Systems?|\s+Management|\s+Resolution)\b/gi,
    /\bConflict\s+Resolution\b/gi,
    /\bDe[\s-]?escalation\b/gi,
    /\bVirtual\s+Assistance\b/gi,
    /\bGoHighLevel(?:\s+Administration)?\b/gi,
    /\bCRM\s+Management\b/gi,
    /\bWorkflow\s+Automation\b/gi,
    /\bSales\s+Funnel\s+Setup\b/gi,
    /\bLanding\s+Page\s+Creation\b/gi,
    /\bAPI\s+and\s+Third[\s-]?Party\s+Integrations\b/gi,
    /\bCalendar\s+Management\b/gi,
    /\bInbox\s+Management\b/gi,
    /\bEmail\s+Management\b/gi,
    /\bTravel\s+(?:Coordination|Arrangements|Management|Booking)\b/gi,
    /\bExecutive\s+Support\b/gi,
    /\bAdministrative\s+Support\b/gi,
    /\bOffice\s+(?:Administration|Management)\b/gi,
    /\bDocument\s+Preparation\b/gi,
    /\bRecord\s+Keeping\b/gi,
    /\bAppointment\s+Scheduling\b/gi,
    /\bData\s+Entry\b/gi,
    /\bData\s+(?:Verification|Cleansing|Validation|Organization|Analysis|Visualization|Processing)\b/gi,
    /\bDatabase\s+Management\b/gi,
    /\bMicrosoft\s+Office(?:\s+Suite)?\b/gi,
    /\bMicrosoft\s+(?:Excel|Word|Outlook|PowerPoint)\b/gi,
    /\bGoogle\s+(?:Workspace|Sheets|Docs|Calendar|Analytics|Ads)\b/gi,
    /\b(?:JavaScript|TypeScript|Python|React|Next\.js|Node\.js|Express|HTML5|CSS3|SQL|MySQL|PostgreSQL|MongoDB|Firebase|Supabase|Docker|AWS|Git|Figma)\b/gi,
    /\b(?:Zendesk|Freshdesk|Intercom|Salesforce|HubSpot|Zapier|n8n|Systeme\.io|Slack|Trello|Asana|ClickUp|Notion|QuickBooks|Xero|SAP|Tableau|Power\s+BI|Jira|Canva|Adobe\s+Photoshop|Adobe\s+Illustrator)\b/gi,
    /\b(?:SEO|SEM|Copywriting|Social\s+Media\s+Management|Project\s+Management|Agile|Scrum|Financial\s+Reporting|Bookkeeping|Troubleshooting)\b/gi,
  ];

  for (const rx of verbatimPatterns) {
    const matches = rawText.match(rx);
    if (matches && matches[0]) {
      add(matches[0]);
    }
  }

  return found;
}

/**
 * Selects ONLY the 1 to 5 (max 5) best, essential skills that an employer wants to see
 * for the candidate's detected job position.
 * - Filters out generic soft-skill filler ("Time Management", "Communication Skills", etc.)
 * - Ranks hard/domain skills by relevance to the candidate's job position and experience
 * - Never pads with fake skills: if the resume has 1, 2, or 3 essential skills, returns 1, 2, or 3;
 *   caps strictly at 5 maximum.
 */
function selectEssentialEmployerSkills(
  rawSkills: string[],
  detectedRole: string,
  rawText: string
): string[] {
  const candidates =
    rawSkills.length > 0 ? rawSkills : extractVerbatimDomainSkillsFromResumeBody(rawText);

  if (candidates.length === 0) {
    return [];
  }

  const rolePatterns = getRoleRelevancePatterns(detectedRole);

  // Separate core hard/domain skills from generic soft-skill filler
  const hardAndDomainSkills = candidates.filter(
    (s) => !GENERIC_SOFT_SKILL_FILLER_REGEX.test(s.trim())
  );

  const pool = hardAndDomainSkills.length > 0 ? hardAndDomainSkills : candidates.slice(0, 3);

  // Check experience/summary body (excluding the SKILLS line itself) to reward skills backed by work history
  const lowerBody = rawText.toLowerCase();

  const scored = pool.map((skill, originalIndex) => {
    let score = 0;
    const sLower = skill.toLowerCase();

    // 1. Direct match to the target job position's essential employer competencies (+60)
    for (const rx of rolePatterns) {
      if (rx.test(sLower)) {
        score += 60;
        break;
      }
    }

    // 2. Specific technical/domain tool, platform, certification, or measurable skill (+25)
    if (
      /\b(?:crm|gohighlevel|zendesk|freshdesk|hubspot|salesforce|intercom|zapier|n8n|systeme\.io|excel|vlookup|pivot|sheets|workspace|office|quickbooks|sap|erp|sql|python|javascript|typescript|react|next\.?js|node\.?js|aws|docker|figma|photoshop|illustrator|seo|analytics|jira|agile|scrum|wpm|automation|funnel|api|integration|ticketing|de-escalation|calendar|inbox|travel|board|executive|c-suite|onboarding|bookkeeping|gaap|recruiting|ats)\b/i.test(
        sLower
      )
    ) {
      score += 25;
    }

    // 3. Skill is also proven multiple times in the resume body (+15)
    const cleanToken = sLower.replace(/[^a-z0-9\s]/g, '').trim();
    if (cleanToken.length >= 3) {
      const occurrences = lowerBody.split(cleanToken).length - 1;
      if (occurrences >= 2) {
        score += 15;
      }
    }

    return { skill, score, originalIndex };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  // Strictly return 1, 2, 3, 4, or at most 5 essential skills
  return scored.slice(0, 5).map((item) => item.skill);
}

export class ResumeValidationError extends Error {
  public readonly isRejectedDocument = true;
  constructor(message: string) {
    super(message);
    this.name = 'ResumeValidationError';
  }
}

/**
 * Validates that the uploaded .pdf or .docx document actually relates to a Resume, CV,
 * Cover Letter, or professional job-search profile, and rejects unrelated documents
 * (such as invoices, receipts, menus/recipes, academic exams/assignments, legal contracts,
 * manuals, stories/articles, or empty/unreadable files) with an appropriate rejection message.
 */
function validateResumeDocumentAuthenticity(
  candidateTexts: string[],
  fileName: string
): { isValid: boolean; rejectionReason?: string } {
  const combinedBestText =
    candidateTexts
      .slice()
      .sort((a, b) => (b?.length || 0) - (a?.length || 0))[0] || '';

  const cleanText = combinedBestText.replace(/\s+/g, ' ').trim();
  const alphaWords = cleanText.match(/[A-Za-z\u00C0-\u024F]{2,}/g) || [];

  // 1. Reject empty, scanned-image-only, or unreadable files
  if (cleanText.length < 20 || alphaWords.length < 4) {
    return {
      isValid: false,
      rejectionReason:
        'Document Rejected: The uploaded file appears to be empty or contains no readable text. Please upload a valid Resume or CV (.pdf or .docx) showing your job position, skills, and professional background.',
    };
  }

  const lines = combinedBestText
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => collapseSpacedHeading(l.trim()))
    .filter(Boolean);

  // Count distinct genuine Resume / CV section headers across all candidate text representations
  const matchedSectionCategories = new Set<string>();
  for (const textVariant of candidateTexts) {
    const variantLines = (textVariant || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((l) => collapseSpacedHeading(l.trim()))
      .filter(Boolean);

    for (const line of variantLines) {
      const h = cleanSectionHeaderCandidate(line);
      if (!h || h.length > 48) continue;

      if (isSkillsSectionHeader(line)) {
        matchedSectionCategories.add('skills');
      } else if (
        /^(?:work\s+experience|professional\s+experience|employment\s+history|work\s+history|career\s+history|relevant\s+experience|experience|employment|expérience\s+professionnelle|parcours\s+professionnel)$/i.test(
          h
        )
      ) {
        matchedSectionCategories.add('experience');
      } else if (
        /^(?:education(?:al\s+background)?|academic\s+(?:background|qualifications)|education\s*(?:&|and)\s*(?:training|certifications)|formation|éducation)$/i.test(
          h
        )
      ) {
        matchedSectionCategories.add('education');
      } else if (
        /^(?:professional\s+summary|executive\s+summary|career\s+summary|summary|profile|personal\s+profile|profil(?:\s+professionnel)?|résumé|career\s+objective|objective|about\s+me)$/i.test(
          h
        )
      ) {
        matchedSectionCategories.add('summary');
      } else if (
        /^(?:certifications?(?:\s*(?:&|and)\s*licenses?)?|licenses?\s*(?:&|and)\s*certifications?|certificates?|projects|key\s+projects|volunteer(?:ing|\s+experience|\s+work)?|achievements|key\s+achievements|references|références)$/i.test(
          h
        )
      ) {
        matchedSectionCategories.add('credentials');
      }
    }
  }

  const resumeSectionCount = matchedSectionCategories.size;

  // Check for placeholder / Lorem Ipsum documents
  if (/\blorem\s+ipsum\s+dolor\s+sit\s+amet\b/i.test(cleanText) && resumeSectionCount < 2) {
    return {
      isValid: false,
      rejectionReason:
        'Document Rejected: This file contains placeholder text (Lorem Ipsum) rather than a genuine Resume or CV. Please upload your actual Resume or CV.',
    };
  }

  // Check for cover letter / job application letter signals
  const hasCoverLetterSignals =
    /\b(?:dear\s+(?:hiring\s+manager|recruit(?:er|ing|ment)\s*(?:team)?|selection\s+committee|human\s+resources|sir\s+or\s+madam)|application\s+for\s+(?:the\s+)?(?:position|role|post)\s+of|i\s+am\s+writing\s+to\s+(?:apply|express\s+my\s+(?:strong\s+)?interest)|enclosed\s+(?:please\s+find|is)\s+my\s+(?:resume|cv|curriculum\s+vitae)|attached\s+(?:please\s+find|is)\s+my\s+(?:resume|cv))\b/i.test(
      cleanText
    );

  // 2. Detect specific non-resume document types (when the document lacks standard resume structure)
  if (resumeSectionCount < 2 && !hasCoverLetterSignals) {
    // 2a. Invoices, Receipts, Bills, Purchase Orders, Bank Statements, Tickets
    const billingPatterns = [
      /\binvoice\s*(?:#|no\.?|number|date|total)\b/i,
      /\b(?:bill\s+to|ship\s+to|sold\s+to|remit\s+to)\b/i,
      /\b(?:subtotal|amount\s+due|balance\s+due|total\s+due|grand\s+total|payment\s+due|amount\s+paid)\b/i,
      /\b(?:payment\s+receipt|official\s+receipt|sales\s+receipt|tax\s+invoice|proforma\s+invoice|purchase\s+order)\b/i,
      /\b(?:bank\s+statement|account\s+statement|transaction\s+history|opening\s+balance|closing\s+balance)\b/i,
      /\b(?:boarding\s+pass|flight\s+itinerary|booking\s+confirmation|order\s+confirmation|e-ticket|passenger\s+name)\b/i,
    ];
    const billingHits = billingPatterns.filter((rx) => rx.test(cleanText)).length;
    if (
      billingHits >= 2 ||
      /\b(?:tax\s+invoice|payment\s+receipt|official\s+receipt|bank\s+statement|boarding\s+pass)\b/i.test(
        cleanText
      )
    ) {
      return {
        isValid: false,
        rejectionReason:
          'Document Rejected: This file appears to be an invoice, receipt, bank statement, or booking document rather than a Resume or CV. Please upload a valid Resume or CV for your job interview.',
      };
    }

    // 2b. Recipes, Restaurant Menus, Cooking Guides
    const recipePatterns = [
      /\b(?:preheat\s+oven|prep\s+time|cook\s+time|baking\s+sheet|simmer\s+for|bake\s+for\s+\d+\s+minutes)\b/i,
      /\b(?:tablespoons?|teaspoons?|tbsp|tsp|cups?\s+of\s+(?:flour|sugar|water|milk|oil|butter))\b/i,
      /\b(?:appetizers?|main\s+courses?|entrees?|side\s+dishes|dessert\s+menu|beverage\s+menu)\b/i,
      /\bingredients\s*:/i,
    ];
    const recipeHits = recipePatterns.filter((rx) => rx.test(cleanText)).length;
    if (recipeHits >= 2) {
      return {
        isValid: false,
        rejectionReason:
          'Document Rejected: This file appears to be a recipe or food menu rather than a professional Resume or CV. Please upload a valid Resume or CV related to your job search.',
      };
    }

    // 2c. Academic Exams, Assignments, Course Syllabi, Research Papers, Textbooks
    const academicPatterns = [
      /\b(?:final\s+exam(?:ination)?|midterm\s+exam(?:ination)?|exam\s+duration|answer\s+all\s+questions|total\s+marks|multiple\s+choice\s+questions)\b/i,
      /\b(?:course\s+syllabus|course\s+outline|grading\s+policy|required\s+textbook|lecture\s+schedule)\b/i,
      /\b(?:homework\s+assignment|assignment\s+#?\d+|lab\s+report|submission\s+deadline)\b/i,
      /\b(?:literature\s+review|table\s+of\s+contents|chapter\s+\d+|et\s+al\.|abstract\s+this\s+(?:paper|study))\b/i,
    ];
    const academicHits = academicPatterns.filter((rx) => rx.test(cleanText)).length;
    if (academicHits >= 2) {
      return {
        isValid: false,
        rejectionReason:
          'Document Rejected: This file appears to be an academic assignment, exam paper, course syllabus, or research article rather than a Resume or CV. Please upload a professional Resume or CV.',
      };
    }

    // 2d. Legal Contracts, Agreements, Terms of Service, Privacy Policies
    const legalPatterns = [
      /\b(?:terms\s+and\s+conditions|terms\s+of\s+service|privacy\s+policy)\b/i,
      /\b(?:hereinafter\s+referred\s+to|in\s+witness\s+whereof|know\s+all\s+men\s+by\s+these\s+presents)\b/i,
      /\b(?:governing\s+law|indemnification|limitation\s+of\s+liability|force\s+majeure|severability)\b/i,
      /\b(?:lease\s+agreement|tenancy\s+agreement|non[\s-]?disclosure\s+agreement|memorandum\s+of\s+understanding)\b/i,
    ];
    const legalHits = legalPatterns.filter((rx) => rx.test(cleanText)).length;
    if (legalHits >= 2) {
      return {
        isValid: false,
        rejectionReason:
          'Document Rejected: This file appears to be a legal contract, agreement, or policy document rather than a Resume or CV. Please upload your personal Resume or CV.',
      };
    }

    // 2e. User Manuals / Technical Guides
    const manualPatterns = [
      /\b(?:user\s+manual|owner'?s\s+manual|installation\s+guide|quick\s+start\s+guide|safety\s+precautions|warranty\s+information|fcc\s+compliance)\b/i,
    ];
    if (manualPatterns.filter((rx) => rx.test(cleanText)).length >= 2) {
      return {
        isValid: false,
        rejectionReason:
          'Document Rejected: This file appears to be a product manual or instructional guide rather than a Resume or CV. Please upload your personal Resume or CV.',
      };
    }
  }

  // 3. Evaluate overall Resume / CV / Professional Job Search authenticity
  let explicitSkillsCount = 0;
  for (const t of candidateTexts) {
    explicitSkillsCount = Math.max(
      explicitSkillsCount,
      parseExplicitSkillsSectionFromText(t).length
    );
  }
  const hasExplicitSkills = explicitSkillsCount >= 1;
  const domainSkillsFound = extractVerbatimDomainSkillsFromResumeBody(combinedBestText).length;

  const candidateNameLine = lines[0] || '';
  let hasJobTitleLine = false;
  for (const line of lines.slice(0, 35)) {
    if (line.split(/\s+/).length <= 7) {
      if (extractJobTitleFromCompositeLine(line, candidateNameLine)) {
        hasJobTitleLine = true;
        break;
      }
    }
  }

  const hasDateRange =
    /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:19|20)\d{2}\s*[-–—to]+\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:(?:19|20)\d{2}|present|current|now|aujourd'hui)\b/i.test(
      cleanText
    );

  const hasEducationOrCertSignal =
    /\b(?:bachelor|master|b\.?sc|m\.?sc|b\.?a|m\.?b\.?a|ph\.?d|hnd|associate\s+degree|high\s+school\s+diploma|university|college|certified|certification|certificat|licence|diplôme)\b/i.test(
      cleanText
    );

  const careerVerbMatches =
    cleanText.match(
      /\b(?:managed|developed|created|designed|built|implemented|administered|coordinated|spearheaded|collaborated|supported|resolved|maintained|streamlined|troubleshot|optimized|supervised|trained|mentored|analyzed|executed|delivered|engineered|automated)\b/gi
    ) || [];

  const hasContactInfo =
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\blinkedin\.com\/in\/|\bgithub\.com\//i.test(
      cleanText
    );

  let authenticityScore = 0;
  authenticityScore += Math.min(3, resumeSectionCount) * 25;
  if (hasExplicitSkills) authenticityScore += 20;
  else if (domainSkillsFound >= 2) authenticityScore += 15;
  else if (domainSkillsFound === 1) authenticityScore += 8;

  if (hasJobTitleLine) authenticityScore += 20;
  if (hasDateRange) authenticityScore += 15;
  if (hasEducationOrCertSignal) authenticityScore += 12;
  if (careerVerbMatches.length >= 2) authenticityScore += 12;
  else if (careerVerbMatches.length === 1) authenticityScore += 6;
  if (hasContactInfo) authenticityScore += 10;
  if (hasCoverLetterSignals) authenticityScore += 45;
  if (
    /\b(?:curriculum\s+vitae|references\s+available\s+upon\s+request|available\s+upon\s+request)\b/i.test(
      cleanText
    )
  ) {
    authenticityScore += 15;
  }

  const hasCoreCareerStructure =
    resumeSectionCount >= 1 ||
    hasCoverLetterSignals ||
    (hasJobTitleLine &&
      (hasExplicitSkills ||
        domainSkillsFound >= 1 ||
        hasDateRange ||
        hasEducationOrCertSignal ||
        careerVerbMatches.length >= 1));

  if (authenticityScore < 35 || !hasCoreCareerStructure) {
    return {
      isValid: false,
      rejectionReason:
        'Document Rejected: The uploaded document does not relate to a Resume, CV, or professional job search profile. Please upload a valid Resume or CV (.pdf or .docx) containing your job position, skills, and work experience or education.',
    };
  }

  return { isValid: true };
}

function extractRoleAndSkillsHeuristically(
  candidateTexts: string[],
  fileName: string
): ResumeExaminationResult & { fromExplicitSkillsSection: boolean; bestText: string } {
  let rawExplicitSkills: string[] = [];
  let bestText = candidateTexts[0] || '';
  let bestScore = -1;

  for (const text of candidateTexts) {
    if (!text) continue;
    const skills = parseExplicitSkillsSectionFromText(text);
    const totalChars = skills.reduce((sum, s) => sum + s.length, 0);
    const score = skills.length * 100 + totalChars;
    if (score > bestScore) {
      bestScore = score;
      rawExplicitSkills = skills;
      bestText = text;
    }
  }

  const hasExplicitSkills = rawExplicitSkills.length >= 1;

  // 1. Deeply search the PDF/DOCX for the exact Job Position (supporting Global Hire 360 roles AND any other role)
  const detectedRole = deepExtractJobPositionFromResume(
    bestText,
    fileName,
    rawExplicitSkills,
    hasExplicitSkills
  );

  // 2. Select ONLY the 1 to 5 (max 5) best, essential skills an employer wants to see for this role
  const essentialSkills = selectEssentialEmployerSkills(
    rawExplicitSkills,
    detectedRole,
    bestText
  );

  const candidateExperienceSummary = `Resume examined for the ${detectedRole} position with ${essentialSkills.length} essential skill${
    essentialSkills.length === 1 ? '' : 's'
  } selected.`;

  return {
    detectedRole,
    candidateExperienceSummary,
    keySkills: essentialSkills,
    questions: buildTailoredQuestionsForRole(detectedRole, essentialSkills),
    fromExplicitSkillsSection: hasExplicitSkills,
    bestText,
  };
}

export async function examineResumeForJobPosition(params: {
  resumeFileName: string;
  resumeMimeType: string;
  resumeBase64: string;
}): Promise<ResumeExaminationResult> {
  const { resumeFileName, resumeMimeType, resumeBase64 } = params;
  const cleanBase64 = resumeBase64.includes(',') ? resumeBase64.split(',')[1] : resumeBase64;
  const fileBuffer = Buffer.from(cleanBase64, 'base64');

  const candidateTexts = await extractRawTextFromResumeBuffer(
    fileBuffer,
    resumeFileName || 'resume.pdf',
    resumeMimeType || 'application/pdf'
  );

  // Validate that the uploaded document actually relates to a Resume, CV, or professional job search profile
  const validation = validateResumeDocumentAuthenticity(candidateTexts, resumeFileName || '');
  if (!validation.isValid) {
    throw new ResumeValidationError(
      validation.rejectionReason ||
        'Document Rejected: The uploaded file is not a valid Resume, CV, or professional job application document.'
    );
  }

  // Deterministic deep extraction of exact Job Position and 1–5 essential employer skills
  const localExtraction = extractRoleAndSkillsHeuristically(
    candidateTexts,
    resumeFileName || ''
  );
  const primaryText = localExtraction.bestText;

  const ai = getGenAIClientOrNull();
  if (ai) {
    try {
      const parts: any[] = [];
      const isPdf =
        resumeFileName?.toLowerCase().endsWith('.pdf') || resumeMimeType === 'application/pdf';

      if (isPdf && cleanBase64.length > 0 && cleanBase64.length < 18_000_000) {
        parts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: cleanBase64,
          },
        });
      }

      parts.push({
        text: `You are the Senior Talent Examiner for Global Hire 360 (https://www.globalhire360.com/).
Carefully examine this uploaded document (File name: "${resumeFileName}").
Extracted Document Text:
"""
${primaryText.slice(0, 14000)}
"""

CRITICAL INSTRUCTIONS:
0. First verify whether this document is a Resume, CV, Cover Letter, or professional job-search profile. If it is an unrelated document (such as an invoice, receipt, recipe, academic assignment, legal contract, story, or random text), set "isResumeDocument" to false and provide a clear "rejectionReason".
1. Deeply check the resume (headline under the candidate's name, professional summary, most recent work experience job title, and skills) to find the exact job position the candidate is applying for:
   - If the resume corresponds to one of Global Hire 360's 5 proposed positions ("Customer Service", "Virtual Assistant", "Data Entry", "Admin Support", "Executive Assistant"), use that exact position name.
   - If the resume is for a DIFFERENT job position not in that list (for example: "Software Developer", "Full-Stack Web Developer", "Graphic Designer", "Project Manager", "Data Analyst", "Accountant", "Digital Marketing Specialist", "HR Manager", etc.), set "detectedRole" to the exact job position written in the resume. Never assign a position that does not correspond to the resume.
2. Under "keySkills", select ONLY the best, essential hard/domain skills from the resume that an employer will want to see for "detectedRole":
   - Exclude generic soft-skill filler like "Time Management", "Communication Skills", "Attention to Detail", "Problem-Solving", or "Teamwork".
   - If the resume only has 1, 2, or 3 essential skills, return only those 1, 2, or 3 skills.
   - Return at most 5 skills maximum (1 to 5 max).
3. Write a concise 2-sentence summary of their experience in "candidateExperienceSummary".
4. Generate 5 tailored interview questions specifically for their "detectedRole" and referencing their essential skills.`,
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isResumeDocument: {
                type: Type.BOOLEAN,
                description:
                  'True if the document is a Resume, CV, Cover Letter, or professional job-search document; false if unrelated.',
              },
              rejectionReason: {
                type: Type.STRING,
                description:
                  'If isResumeDocument is false, a clear message explaining why the document was rejected.',
              },
              detectedRole: {
                type: Type.STRING,
                description:
                  'The exact job position from the resume (one of Customer Service, Virtual Assistant, Data Entry, Admin Support, Executive Assistant if applicable, or the exact role stated in the resume).',
              },
              candidateExperienceSummary: {
                type: Type.STRING,
                description: '2-sentence factual summary of the candidate background from the resume.',
              },
              keySkills: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Between 1 and 5 max of the best, essential employer-relevant skills from the resume.',
              },
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: { type: Type.STRING },
                    question: { type: Type.STRING },
                    expectedFocus: { type: Type.STRING },
                  },
                  required: ['category', 'question', 'expectedFocus'],
                },
              },
            },
            required: ['isResumeDocument', 'detectedRole', 'candidateExperienceSummary', 'keySkills', 'questions'],
          },
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (parsed.isResumeDocument === false) {
        throw new ResumeValidationError(
          parsed.rejectionReason ||
            'Document Rejected: The uploaded document does not relate to a Resume, CV, or professional job search profile.'
        );
      }
      if (parsed.detectedRole) {
        const aiSkills = Array.isArray(parsed.keySkills)
          ? parsed.keySkills.map((s: any) => String(s).trim()).filter(Boolean)
          : [];

        const rawPool =
          localExtraction.fromExplicitSkillsSection && localExtraction.keySkills.length >= 1
            ? localExtraction.keySkills
            : aiSkills.length >= 1
            ? aiSkills
            : localExtraction.keySkills;

        const finalRole =
          localExtraction.detectedRole || String(parsed.detectedRole).trim();

        const finalSkills = selectEssentialEmployerSkills(
          rawPool,
          finalRole,
          primaryText
        ).slice(0, 5);

        const finalQuestions = selectQuestionsForInterviewSession(finalRole, finalSkills);

        return {
          detectedRole: finalRole,
          candidateExperienceSummary:
            parsed.candidateExperienceSummary || localExtraction.candidateExperienceSummary,
          keySkills: finalSkills,
          questions: finalQuestions,
        };
      }
    } catch (aiErr) {
      if (aiErr instanceof ResumeValidationError) {
        throw aiErr;
      }
      console.warn('Gemini resume examination fallback to structural parser:', aiErr);
    }
  }

  return {
    detectedRole: localExtraction.detectedRole,
    candidateExperienceSummary: localExtraction.candidateExperienceSummary,
    keySkills: localExtraction.keySkills.slice(0, 5),
    questions: localExtraction.questions,
  };
}

// ============================================================================
// 5. EXPRESS API ROUTES
// ============================================================================

// 5.0 Question banks & marking guides (the answer key) — admin only
app.get('/api/customer-service-questions', requireAdmin, async (_req, res) => {
  await seedCustomerServiceQuestionsToSupabase();
  const mapRow = (q: CustomerServiceQuestionRow) => ({
    id: q.id,
    roleCategory: q.roleCategory,
    category: q.category,
    question: q.question,
    proposedAnswer: q.proposedAnswer,
    expectedFocus: q.expectedFocus,
    isBehavioralStar: q.isBehavioralStar,
  });
  return res.json({
    maxSessionDurationMinutes: 10,
    questionsPerSession: { default: DEFAULT_QUESTION_COUNT, returningCandidates: EXTENDED_QUESTION_COUNT },
    maxScore: INTERVIEW_MAX_SCORE,
    passingScore: INTERVIEW_PASSING_SCORE,
    universalFirstQuestion: {
      ...mapRow(UNIVERSAL_FIRST_QUESTION_ROW),
      alternativeWordingsForReturningCandidates: UNIVERSAL_FIRST_QUESTION_VARIANTS,
    },
    banks: {
      customerService: CUSTOMER_SERVICE_QUESTION_TABLE.map(mapRow),
      virtualAssistant: VIRTUAL_ASSISTANT_QUESTION_TABLE.map(mapRow),
      technicalSupport: TECHNICAL_SUPPORT_QUESTION_TABLE.map(mapRow),
    },
  });
});

// 5a. Examine Resume endpoint (called immediately when candidate selects resume on Homepage)
app.post('/api/examine-resume', async (req, res) => {
  try {
    const { resumeFileName, resumeMimeType, resumeBase64 } = req.body || {};
    if (!resumeBase64 || typeof resumeBase64 !== 'string') {
      return res.status(400).json({ error: 'Resume file data is required.' });
    }
    const result = await examineResumeForJobPosition({
      resumeFileName: clampText(resumeFileName || 'resume.pdf', 200),
      resumeMimeType: clampText(resumeMimeType || 'application/pdf', 120),
      resumeBase64,
    });
    // Never ship suggested answers to the browser before the interview.
    return res.json({
      ...result,
      questions: (result.questions || []).map((q) => ({
        id: q.id,
        number: q.number,
        category: q.category,
        question: q.question,
      })),
    });
  } catch (err: any) {
    if (err instanceof ResumeValidationError || err?.isRejectedDocument) {
      return res.status(422).json({
        error: err.message,
        isRejectedDocument: true,
      });
    }
    console.error('Error in /api/examine-resume:', err);
    return res.status(500).json({ error: 'Failed to examine resume.' });
  }
});

// 5b. Check candidate suspension status by email before starting a session
app.get('/api/candidate-status', (req, res) => {
  const email = normalizeEmail(clampText(req.query.email, 254));
  if (!email) {
    return res.json({ isSuspended: false });
  }
  const status = getCandidateSuspensionStatus(email);
  return res.json({
    ...status,
    googleAvatarUrl: buildGoogleProfileAvatarUrl(email, clampText(req.query.name, 120)),
  });
});

function findResumableSession(candidateId: string | undefined, email: string): InterviewSessionRecord | null {
  const now = Date.now();
  let best: InterviewSessionRecord | null = null;
  for (const s of activeSessions.values()) {
    if (s.candidateId !== candidateId && s.candidateEmail !== email) continue;
    if (s.status !== 'in_progress' || s.currentPhase === 'finished') continue;
    const expiresAt = new Date(s.createdAt).getTime() + (s.maxDurationSeconds || 600) * 1000;
    if (expiresAt <= now) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}

function remainingSessionSeconds(session: InterviewSessionRecord): number {
  const expiresAt = new Date(session.createdAt).getTime() + (session.maxDurationSeconds || 600) * 1000;
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

/** Builds the "welcome back, let's continue" response for a resumed, unfinished session. */
function buildResumeResponse(session: InterviewSessionRecord) {
  session.resumedCount = (session.resumedCount || 0) + 1;
  const name = session.candidateName;
  let continueLine: string;
  if (session.currentPhase === 'questioning' && session.questions[session.currentQuestionIndex]) {
    const q = session.questions[session.currentQuestionIndex];
    session.currentQuestionAttempts = 0;
    continueLine = `Welcome back, ${name}! Let's pick up right where we left off. Question ${q.number}: ${q.question}`;
  } else if (session.currentPhase === 'candidate_questions') {
    continueLine = `Welcome back, ${name}! We had finished the core questions. Before we wrap up, do you have any questions for me about the ${session.detectedRole} role or Global Hire 360?`;
  } else if (session.currentPhase === 'process_walkthrough') {
    const lastInterviewerLine = [...session.transcript].reverse().find((t) => t.speaker === 'interviewer');
    continueLine = `Welcome back, ${name}! ${lastInterviewerLine?.text || 'Shall we get started?'}`;
  } else {
    continueLine = `Welcome back, ${name}! Thanks for rejoining the ${session.detectedRole} interview. How are you doing today?`;
  }
  session.transcript.push({
    id: `tr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}_resume`,
    speaker: 'interviewer',
    speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
    text: continueLine,
    timestamp: new Date().toISOString(),
    questionIndex: session.currentPhase === 'questioning' ? session.currentQuestionIndex : undefined,
    eventTag: session.currentPhase === 'questioning' ? 'question' : 'greeting',
  });
  activeSessions.set(session.id, session);
  flushCandidatesAndSessionsToDisk();
  return {
    resumed: true,
    session,
    accessToken: session.accessToken,
    interviewerMessage: continueLine,
    remainingSeconds: remainingSessionSeconds(session),
    liveWsAvailable: Boolean(getGenAIClientOrNull()),
  };
}

// Returning-candidate recognition. Deliberately minimal: it never returns transcripts,
// scores or other personal data, because anyone can type any email into the form.
app.get('/api/candidate-history', async (req, res) => {
  const email = normalizeEmail(clampText(req.query.email, 254));
  const name = clampText(req.query.name, 120);
  if (!isValidEmail(email) && normalizePersonName(name).length < 3) {
    return res.json({ exists: false });
  }

  const { candidate, nameMatchesExistingCandidate } = await findExistingCandidate({
    email: isValidEmail(email) ? email : '',
    name,
  });

  if (!candidate) {
    return res.json({ exists: false, nameMatchesExistingCandidate });
  }

  return res.json({
    exists: true,
    firstName: (candidate.fullName || '').split(/\s+/)[0] || 'there',
    sessionsCount: candidate.sessionsCount || 0,
    completedSessionsCount: candidate.completedSessionsCount || 0,
    savedJobPosition: candidate.confirmedJobPosition || candidate.extractedJobPosition || '',
    hasSavedProfile: Boolean(candidate.confirmedJobPosition || candidate.extractedJobPosition),
    hasResumableSession: Boolean(findResumableSession(candidate.id, candidate.email)),
  });
});

// Continue an unfinished session directly (the browser keeps the session id + token).
app.post('/api/resume-session', (req, res) => {
  const sessionId = clampText(req.body?.sessionId, 100);
  const session = activeSessions.get(sessionId);
  if (!session || !sessionTokenMatches(session, readSessionToken(req))) {
    return res.status(404).json({ error: 'Interview session not found.' });
  }
  if (session.currentPhase === 'finished' || session.status !== 'in_progress') {
    return res.json({ resumed: false, finished: true, session });
  }
  if (remainingSessionSeconds(session) <= 0) {
    return res.json({ resumed: false, expired: true });
  }
  return res.json(buildResumeResponse(session));
});

app.post('/api/start-interview-session', async (req, res) => {
  try {
    const body = req.body || {};
    const candidateName = clampText(body.candidateName, 120).trim();
    const candidateEmail = normalizeEmail(clampText(body.candidateEmail, 254));
    const resumeBase64 = typeof body.resumeBase64 === 'string' ? body.resumeBase64 : '';
    const resumeFileName = clampText(body.resumeFileName || 'resume.pdf', 200);
    const resumeMimeType = clampText(body.resumeMimeType || 'application/pdf', 120);
    const confirmedJobPosition = clampText(body.confirmedJobPosition, 120).trim();
    const agreedToInstructions = body.agreedToInstructions !== false;
    const preExaminedData = body.preExaminedData;
    const existingSessionToken = String(body.existingSessionToken || '');

    if (!candidateName || !isValidEmail(candidateEmail)) {
      return res.status(400).json({
        error: 'A valid full name and email address are required.',
      });
    }

    // Check 24-Hour Misconduct Suspension Status first!
    const suspension = getCandidateSuspensionStatus(candidateEmail);
    if (suspension.isSuspended) {
      const unlockDateStr = suspension.suspendedUntil
        ? new Date(suspension.suspendedUntil).toLocaleString()
        : '24 hours from your last session';
      return res.status(403).json({
        error: `Account Suspended for 24 Hours: Your interview access was suspended due to inappropriate language or misconduct during your previous interview session. You may attempt a new interview after ${unlockDateStr} (${suspension.remainingText} remaining).`,
        isSuspended: true,
        suspendedUntil: suspension.suspendedUntil,
        remainingText: suspension.remainingText,
      });
    }

    const result = await withCandidateLock(candidateEmail, async () => {
      // 1. Recognize the candidate by email (memory, then Supabase) — never create a duplicate row.
      const { candidate: existing } = await findExistingCandidate({ email: candidateEmail, name: candidateName });

      // 2. Continue directly into an unfinished, unexpired session instead of opening a second one.
      const openSession = findResumableSession(existing?.id, candidateEmail);
      if (openSession) {
        const tokenOk = sessionTokenMatches(openSession, existingSessionToken);
        const ageMs = Date.now() - new Date(openSession.createdAt).getTime();
        const untouched =
          ageMs < 2 * 60_000 && !openSession.transcript.some((t) => t.speaker === 'candidate');
        if (tokenOk || untouched) {
          return { status: 200, payload: buildResumeResponse(openSession) };
        }
        // Different device/browser without the token: close the stale session (no email) and start fresh.
        openSession.status = 'abandoned';
        openSession.currentPhase = 'finished';
        openSession.completedAt = new Date().toISOString();
        await saveSessionToSupabase(openSession);
      }

      // 3. Build the profile: from a new resume, or from the saved profile of a returning candidate.
      let examined: ResumeExaminationResult;
      if (resumeBase64) {
        if (
          preExaminedData &&
          typeof preExaminedData.detectedRole === 'string' &&
          Array.isArray(preExaminedData.questions) &&
          preExaminedData.questions.length >= 1
        ) {
          examined = {
            detectedRole: clampText(preExaminedData.detectedRole, 120),
            candidateExperienceSummary: clampText(preExaminedData.candidateExperienceSummary, 2000),
            keySkills: Array.isArray(preExaminedData.keySkills)
              ? preExaminedData.keySkills.slice(0, 20).map((s: unknown) => clampText(s, 80))
              : [],
            questions: [],
          } as ResumeExaminationResult;
        } else {
          examined = await examineResumeForJobPosition({ resumeFileName, resumeMimeType, resumeBase64 });
        }
      } else if (existing && (existing.confirmedJobPosition || existing.extractedJobPosition)) {
        examined = {
          detectedRole: existing.confirmedJobPosition || existing.extractedJobPosition,
          candidateExperienceSummary: existing.experienceSummary || '',
          keySkills: existing.extractedSkills || [],
          questions: [],
        } as ResumeExaminationResult;
      } else {
        return {
          status: 400,
          payload: { error: 'Please upload your Resume or CV (.pdf or .docx) to start your first interview.' },
        };
      }

      const extractedRoleFromResume = examined.detectedRole;
      const finalRole = (confirmedJobPosition || examined.detectedRole).trim();
      examined.detectedRole = finalRole;

      // 4. Questions: universal opener (exact wording for first-timers, a variant for returning
      //    candidates) + role-bank questions; 4 questions by default, 5 for returning candidates.
      const completedSessionsCount = existing?.completedSessionsCount || 0;
      const isFirstTimeCandidate = completedSessionsCount === 0;
      examined.questions = selectQuestionsForInterviewSession(finalRole, examined.keySkills, {
        isFirstTimeCandidate,
        questionCount: decideQuestionCount({ completedSessionsCount }),
      });

      const sessionId = generateSessionId();

      const candidateRecord = await upsertCandidateOnCheckIn({
        existing,
        fullName: candidateName,
        email: candidateEmail,
        resumeFileName: resumeBase64 ? resumeFileName : existing?.resumeFileName || '',
        extractedJobPosition: extractedRoleFromResume,
        confirmedJobPosition: finalRole,
        experienceSummary: examined.candidateExperienceSummary,
        extractedSkills: examined.keySkills,
        agreedToInstructions,
        sessionId,
      });

      const greetingText = isFirstTimeCandidate
        ? `Hi, good morning ${candidateName}! I'm Sarah, the Operations and Talent Manager here at Global Hire 360. Thanks for joining me today for the ${examined.detectedRole} interview. How are you doing today?`
        : `Hi ${candidateName}, welcome back! It's Sarah from Global Hire 360 again. Great to see you practicing for the ${examined.detectedRole} role once more. How are you doing today?`;

      const newSession: InterviewSessionRecord = {
        id: sessionId,
        accessToken: generateSessionAccessToken(),
        candidateId: candidateRecord.id,
        createdAt: new Date().toISOString(),
        maxDurationSeconds: 600, // 10 minutes max session duration
        candidateName,
        candidateEmail,
        candidateGoogleAvatarUrl:
          candidateRecord.googleAvatarUrl || buildGoogleProfileAvatarUrl(candidateEmail, candidateName),
        resumeFileName: candidateRecord.resumeFileName || resumeFileName,
        detectedRole: examined.detectedRole,
        candidateExperienceSummary: examined.candidateExperienceSummary,
        keySkills: examined.keySkills,
        questions: examined.questions,
        isFirstTimeCandidate,
        status: 'in_progress',
        currentPhase: 'greeting_how_are_you',
        currentQuestionIndex: 0,
        currentQuestionAttempts: 0,
        questionEvaluations: [],
        transcript: [
          {
            id: `tr_${Date.now()}_init`,
            speaker: 'interviewer',
            speakerName: 'Global Hire 360 AI Interviewer',
            text: greetingText,
            timestamp: new Date().toISOString(),
            eventTag: 'greeting',
          },
        ],
        totalScoreOutOf20: 0,
        totalScoreOutOf25: 0,
        maxScore: INTERVIEW_MAX_SCORE,
        percentageScore: 0,
        successful: false,
        interviewerFinalImpression: '',
        misconductCount: 0,
        misconductPenaltyPoints: 0,
        misconductNotes: [],
        suspendedUntil: null,
        emailSent: false,
        emailStatus: 'not_sent',
      };

      activeSessions.set(sessionId, newSession);
      const supRes = await saveSessionToSupabase(newSession);
      newSession.supabaseSaved = supRes.saved;

      return {
        status: 200,
        payload: {
          resumed: false,
          returningCandidate: Boolean(existing),
          session: newSession,
          accessToken: newSession.accessToken,
          interviewerMessage: greetingText,
          remainingSeconds: newSession.maxDurationSeconds,
          liveWsAvailable: Boolean(getGenAIClientOrNull()),
        },
      };
    });

    return res.status(result.status).json(result.payload);
  } catch (err: any) {
    if (err instanceof ResumeValidationError || err?.isRejectedDocument) {
      return res.status(422).json({
        error: err.message,
        isRejectedDocument: true,
      });
    }
    console.error('Error in /api/start-interview-session:', err);
    return res.status(500).json({ error: 'Failed to start interview session.' });
  }
});

// 5c. Interactive Turn Handler (Supports conversational turns, 90s question timeout, 10m session timeout, rephrase, 2-attempt rule, and Marking Guide grading)
app.post('/api/interview-turn', async (req, res) => {
  try {
    const { sessionId, candidateText, timedOut, sessionTimedOut, requestedRephrase } = req.body || {};
    const session = activeSessions.get(clampText(sessionId, 100));
    if (!session || !sessionTokenMatches(session, readSessionToken(req))) {
      return res.status(404).json({ error: 'Interview session not found.' });
    }

    // A finished session is immutable: late timer ticks or duplicate submissions must not
    // re-grade it, re-append the closing message or trigger another results email.
    if (session.currentPhase === 'finished') {
      return res.json({
        session,
        interviewerMessage: session.interviewerFinalImpression || 'The interview is complete.',
        resetQuestionTimer: false,
        interviewEnded: true,
      });
    }

    const nowIso = new Date().toISOString();
    const cleanText = clampText(candidateText, 6000).trim();

    // Record candidate utterance into transcript
    if (cleanText || timedOut || sessionTimedOut || requestedRephrase) {
      session.transcript.push({
        id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_c`,
        speaker: 'candidate',
        speakerName: session.candidateName,
        text: sessionTimedOut
          ? cleanText
            ? `${cleanText} [10-Minute Max Session Limit Reached]`
            : '[10-Minute Max Session Limit Reached]'
          : timedOut
          ? cleanText
            ? `${cleanText} [90-Second Timer Expired]`
            : '[90-Second Timer Expired — No response completed within 90s]'
          : requestedRephrase
          ? cleanText || 'Could you please rephrase the question for me?'
          : cleanText,
        timestamp: nowIso,
        questionIndex: session.currentPhase === 'questioning' ? session.currentQuestionIndex : undefined,
        eventTag: timedOut || sessionTimedOut ? 'timeout' : requestedRephrase ? 'rephrase' : 'answer',
      });
    }

    // PROFESSIONAL CONDUCT & MISCONDUCT CHECK (Point Reduction or Immediate Call Termination + 24h Suspension)
    if (cleanText && !timedOut && !sessionTimedOut) {
      const misconductCheck = detectCandidateMisconduct(cleanText);
      if (misconductCheck.isMisconduct) {
        session.misconductCount = (session.misconductCount || 0) + 1;
        session.misconductNotes = session.misconductNotes || [];

        // Severe misconduct OR 2nd misconduct offense -> Immediately terminate call & suspend candidate for 24 hours!
        if (misconductCheck.severity === 'severe' || session.misconductCount >= 2) {
          session.misconductPenaltyPoints = (session.misconductPenaltyPoints || 0) + 5;
          const reasonNote = `Session terminated for misconduct (${misconductCheck.reason}). Candidate suspended for 24 hours.`;
          session.misconductNotes.push(reasonNote);
          session.status = 'terminated_misconduct';

          const suspendedUntilIso = await suspendCandidateFor24Hours({
            email: session.candidateEmail,
            candidateId: session.candidateId,
            reason: misconductCheck.reason,
          });
          session.suspendedUntil = suspendedUntilIso;

          return await concludeAndFinalizeSession(session, res, false, true);
        } else {
          // 1st mild misconduct offense -> Deduct 3.0 points and issue a firm professional warning
          session.misconductPenaltyPoints = (session.misconductPenaltyPoints || 0) + 3;
          const warningNote = `Warning #1: -3.0 points deducted for unprofessional language (${misconductCheck.reason}).`;
          session.misconductNotes.push(warningNote);

          const activePromptToRepeat =
            session.currentPhase === 'questioning' && session.questions[session.currentQuestionIndex]
              ? `Now, let's reset your timer and try Question ${
                  session.questions[session.currentQuestionIndex].number
                } again in a strictly professional manner: ${
                  session.questions[session.currentQuestionIndex].question
                }`
              : `Now, let's keep things strictly professional—how are you doing today, and are you ready for Question 1?`;

          const warningReply = `Hold on right there, ${session.candidateName}. While I enjoy keeping our interview warm and engaging, this is an official Global Hire 360 assessment and inappropriate language is strictly not acceptable. I have deducted 3 points from your overall score for misconduct. Please note that if any further inappropriate language is used, I will immediately end this call and your profile will be suspended from attempting another interview for the next 24 hours. ${activePromptToRepeat}`;

          session.transcript.push({
            id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_warn`,
            speaker: 'interviewer',
            speakerName: 'Global Hire 360 AI Interviewer',
            text: warningReply,
            timestamp: new Date().toISOString(),
            questionIndex:
              session.currentPhase === 'questioning' ? session.currentQuestionIndex : undefined,
            eventTag: 'misconduct_warning',
          });

          await saveSessionToSupabase(session);
          return res.json({
            session,
            interviewerMessage: warningReply,
            resetQuestionTimer: true,
            interviewEnded: false,
            misconductWarning: {
              pointsDeducted: 3,
              totalPenaltyPoints: session.misconductPenaltyPoints,
              message: warningNote,
            },
          });
        }
      }
    }

    // If the 10-minute overall session timer expired, evaluate any partial response on the active question and conclude the session
    if (sessionTimedOut) {
      if (session.currentPhase === 'questioning') {
        const activeQ = session.questions[session.currentQuestionIndex];
        if (activeQ && cleanText.length > 0) {
          const mgEval = gradeAnswerAgainstSuggestedAnswer({
            questionId: activeQ.id,
            questionText: activeQ.question,
            category: activeQ.category,
            expectedFocus: activeQ.expectedFocus,
            proposedAnswer: activeQ.proposedAnswer,
            candidateText: cleanText,
            role: session.detectedRole,
          });
          session.questionEvaluations = session.questionEvaluations.filter(
            (ev) => ev.questionNumber !== activeQ.number
          );
          session.questionEvaluations.push({
            questionId: activeQ.id,
            questionNumber: activeQ.number,
            category: activeQ.category,
            questionText: activeQ.question,
            proposedAnswer: activeQ.proposedAnswer,
            candidateAnswer: cleanText,
            attemptsUsed: session.currentQuestionAttempts + 1,
            timedOut: true,
            scoreOutOf5: mgEval.isOnTopic ? mgEval.scoreOutOf5 : Math.min(1, mgEval.scoreOutOf5),
            feedback: mgEval.feedback,
            strengths: mgEval.strengths,
            improvementTip: mgEval.improvementTip,
            alignmentPercent: mgEval.alignmentPercent,
            matchedPoints: mgEval.matchedPoints,
            missedPoints: mgEval.missedPoints,
            gradingMethod: mgEval.gradingMethod,
          });
        }
      }
      return await concludeAndFinalizeSession(session, res, false);
    }

    // PHASE 1: STAGE 1 Greeting & Small Talk -> Transition smoothly to STAGE 2 Process Walkthrough
    if (session.currentPhase === 'greeting_how_are_you') {
      session.currentPhase = 'process_walkthrough';

      const isNervous =
        /\b(nervous|scared|stressed|anxious|worried|tense|jittery|afraid|intimidated|first\s+time)\b/i.test(
          cleanText
        );
      const askedHowInterviewerIs =
        /\b(how\s+are\s+you|how\s+about\s+you|and\s+you|how'?s\s+your\s+day|doing\s+well\s+too)\b/i.test(
          cleanText
        );

      let stage1Ack = `Glad to hear that, ${session.candidateName}.`;
      if (isNervous) {
        stage1Ack = `That's completely normal, ${session.candidateName}, don't worry at all. This is a safe, stress-free space to practice, and we're just having a comfortable conversation.`;
      } else if (askedHowInterviewerIs) {
        stage1Ack = `I'm doing really well, thank you for asking, ${session.candidateName}!`;
      }

      const walkthroughReply = `${stage1Ack} Before we dive in, let me quickly walk you through how our interview will go. We have about ten minutes together: I'll ask you ${session.questions.length === 5 ? 'five' : 'four'} questions about your background and realistic scenarios for the ${session.detectedRole} role, with up to 90 seconds per question, and at the end you'll have time to ask me any questions of your own. Does that sound good, or do you have any questions before we start?`;

      session.transcript.push({
        id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
        speaker: 'interviewer',
        speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
        text: walkthroughReply,
        timestamp: new Date().toISOString(),
        eventTag: 'greeting',
      });

      await saveSessionToSupabase(session);

      return res.json({
        session,
        interviewerMessage: walkthroughReply,
        resetQuestionTimer: false,
        interviewEnded: false,
      });
    }

    // PHASE 2: STAGE 2 Process Walkthrough -> Answer any pre-interview question, then launch Question 1
    if (session.currentPhase === 'process_walkthrough') {
      session.currentPhase = 'questioning';
      session.currentQuestionIndex = 0;
      session.currentQuestionAttempts = 0;
      const firstQ = session.questions[0];

      const hasPreQuestion =
        /\?|\b(how\s+long|how\s+many|what\s+if|can\s+i|tell\s+me\s+about|what\s+does|who\s+is)\b/i.test(
          cleanText
        ) && !/\b(no\s+questions|nothing|ready|let'?s\s+go|sounds\s+good|all\s+good|okay|yes|sure)\b/i.test(cleanText);

      let preAnswerBridge = `Wonderful, let's get started.`;
      if (hasPreQuestion) {
        preAnswerBridge = `Good question—this session is designed to feel just like a real conversation with a hiring manager. Take your time with each answer, and if you ever want me to rephrase a question or help guide you through a tricky spot, just let me know.`;
      }

      const startQ1Reply = `${preAnswerBridge} Let's start with Question 1: ${firstQ.question}`;

      session.transcript.push({
        id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
        speaker: 'interviewer',
        speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
        text: startQ1Reply,
        timestamp: new Date().toISOString(),
        questionIndex: 0,
        eventTag: 'question',
      });

      await saveSessionToSupabase(session);

      return res.json({
        session,
        interviewerMessage: startQ1Reply,
        resetQuestionTimer: true,
        interviewEnded: false,
      });
    }

    // PHASE 4: STAGE 5 Candidate's Questions -> Answer candidate's question like a hiring manager, then close & score
    if (session.currentPhase === 'candidate_questions') {
      const noQuestions =
        timedOut ||
        !cleanText ||
        /\b(no\s+questions|not\s+right\s+now|none|nothing|that'?s\s+all|i'?m\s+good|all\s+clear|no\s+thank\s+you|nope)\b/i.test(
          cleanText
        );

      if (!noQuestions) {
        let managerAnswer = `That's a really thoughtful question, ${session.candidateName}. At Global Hire 360, we work closely with global teams where clear communication, reliability, and a collaborative mindset are valued from day one, and new team members receive structured onboarding support.`;
        if (/\b(salary|pay|compensation|rate|benefits)\b/i.test(cleanText)) {
          managerAnswer = `That's a fair question, ${session.candidateName}. Compensation for the ${session.detectedRole} role is competitive and aligned with your experience level and region; our HR placement team shares the exact figures during the final offer stage.`;
        } else if (/\b(remote|schedule|hours|time\s+zone|work\s+from\s+home|flexib)\b/i.test(cleanText)) {
          managerAnswer = `Great question. The ${session.detectedRole} role at Global Hire 360 is remote, with a steady, predictable schedule coordinated with your assigned client team.`;
        } else if (/\b(next\s+step|when\s+will\s+i\s+hear|timeline|decision|feedback)\b/i.test(cleanText)) {
          managerAnswer = `Good question. In a live hiring round, we typically review all candidate interviews within a few business days, and since this is a practice session, I've prepared your full scorecard and suggested answers right away.`;
        }

        session.transcript.push({
          id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
          speaker: 'interviewer',
          speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
          text: managerAnswer,
          timestamp: new Date().toISOString(),
          eventTag: 'closing',
        });
      }

      return await concludeAndFinalizeSession(session, res, false, false, !noQuestions);
    }

    const currentQ = session.questions[session.currentQuestionIndex];
    if (!currentQ) {
      return res.json({ session, interviewerMessage: 'The interview is complete.', interviewEnded: true });
    }

    // CASE A0: The candidate is talking TO the interviewer (asks something, checks the line)
    // instead of answering — answer them like a real interviewer and repeat the question.
    // This is not graded and does not use one of their attempts.
    if (!timedOut && !requestedRephrase && isCandidateTalkingToInterviewer(cleanText)) {
      let replyText = /\b(there|hear\s+me|repeating)\b/i.test(cleanText)
        ? `Yes, I'm here and I can hear you clearly, ${session.candidateName}. Here's the question again: ${currentQ.question}`
        : `Good question, ${session.candidateName}. I'll make sure we cover it at the end of the interview. For now, here's the question again: ${currentQ.question}`;
      const ai = getGenAIClientOrNull();
      if (ai) {
        try {
          const resp = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `You are Sarah, Operations and Talent Manager at Global Hire 360, interviewing ${session.candidateName} for the ${session.detectedRole} position in a live spoken interview.
You just asked Question ${currentQ.number}: "${currentQ.question}"
Instead of answering, the candidate said: "${clampText(cleanText, 600)}"
Reply as a real, intelligent hiring manager in at most 2 short spoken sentences: answer their question correctly and briefly (or reassure them that you are here and can hear them). Then ask the question again using exactly this wording: "${currentQ.question}". No lists, no markdown, never reveal how answers are scored.`,
          });
          const aiText = (resp.text || '').trim();
          if (aiText) {
            replyText = interviewerTextAsksQuestion(aiText, currentQ.question)
              ? aiText
              : `${aiText} ${currentQ.question}`;
          }
        } catch {
          // keep the scripted reply
        }
      }
      session.transcript.push({
        id: `tr_${Date.now()}_i`,
        speaker: 'interviewer',
        speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
        text: replyText,
        timestamp: new Date().toISOString(),
        questionIndex: session.currentQuestionIndex,
        eventTag: 'rephrase',
      });
      return res.json({ session, interviewerMessage: replyText, resetQuestionTimer: false, interviewEnded: false });
    }

    // CASE A: Candidate asks to repeat, clarify, or rephrase the question
    if (
      requestedRephrase ||
      /\b(rephrase|repeat(?:ing)?|say\s+that\s+again|come\s+again|pardon|didn'?t\s+understand|didn'?t\s+catch|clarify|what\s+do\s+you\s+mean)\b/i.test(
        cleanText
      )
    ) {
      // Without AI the question is repeated exactly as written (never the hidden marking notes).
      let rephrasedText = `Of course, ${session.candidateName}. Here's Question ${currentQ.number} again: ${currentQ.question} Take your time.`;

      const ai = getGenAIClientOrNull();
      if (ai) {
        try {
          const resp = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `You are Sarah, Operations and Talent Manager at Global Hire 360.
The candidate (${session.candidateName}, applying for ${session.detectedRole}) asked you to repeat or clarify Question ${currentQ.number}: "${currentQ.question}".
Rephrase this question calmly and warmly in simpler words, keeping exactly the same meaning, in at most 2 short spoken sentences. Do not hint at the answer, do not list what to include, no markdown.`,
          });
          if (resp.text) rephrasedText = resp.text.trim();
        } catch {
          // use default rephrasedText
        }
      }

      session.transcript.push({
        id: `tr_${Date.now()}_i`,
        speaker: 'interviewer',
        speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
        text: rephrasedText,
        timestamp: new Date().toISOString(),
        questionIndex: session.currentQuestionIndex,
        eventTag: 'rephrase',
      });

      return res.json({
        session,
        interviewerMessage: rephrasedText,
        resetQuestionTimer: true,
        interviewEnded: false,
      });
    }

    // CASE B: 90-Second Timer Expired on the current question
    if (timedOut) {
      const partialEval =
        cleanText.length > 0
          ? gradeAnswerAgainstSuggestedAnswer({
              questionId: currentQ.id,
              questionText: currentQ.question,
              category: currentQ.category,
              expectedFocus: currentQ.expectedFocus,
              proposedAnswer: currentQ.proposedAnswer,
              candidateText: cleanText,
              role: session.detectedRole,
            })
          : null;

      const partialScore = partialEval ? Math.min(3.5, partialEval.scoreOutOf5) : 0;

      const timeoutEval: QuestionEvaluation = {
        questionId: currentQ.id || `q${currentQ.number}`,
        questionNumber: currentQ.number,
        category: currentQ.category,
        questionText: currentQ.question,
        proposedAnswer: currentQ.proposedAnswer,
        candidateAnswer: cleanText || '[90s timer expired before answer was completed]',
        attemptsUsed: session.currentQuestionAttempts + 1,
        timedOut: true,
        scoreOutOf5: partialScore,
        feedback:
          partialScore > 0
            ? `${partialEval?.feedback || ''} (Note: The 90-second timer expired before you finished wrapping up your answer.)`.trim()
            : 'No response was completed within the 90-second limit.',
        strengths: partialEval?.strengths || [],
        improvementTip:
          partialEval?.improvementTip ||
          'Aim to cover the core points concisely within 60–75 seconds.',
        alignmentPercent: partialEval?.alignmentPercent ?? 0,
        matchedPoints: partialEval?.matchedPoints || [],
        missedPoints: partialEval?.missedPoints || [],
        gradingMethod: partialEval?.gradingMethod || 'marking_guide',
      };
      session.questionEvaluations = [
        ...session.questionEvaluations.filter(
          (ev) => ev.questionNumber !== currentQ.number && ev.questionId !== currentQ.id
        ),
        timeoutEval,
      ];

      // Advance to next question or move to Stage 5 candidate questions
      if (session.currentQuestionIndex < session.questions.length - 1) {
        session.currentQuestionIndex += 1;
        session.currentQuestionAttempts = 0;
        const nextQ = session.questions[session.currentQuestionIndex];
        const timeoutMsg = `Thank you, ${session.candidateName}—our 90 seconds for Question ${currentQ.number} are up, so let's move smoothly to Question ${nextQ.number}: ${nextQ.question}`;

        session.transcript.push({
          id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
          speaker: 'interviewer',
          speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
          text: timeoutMsg,
          timestamp: new Date().toISOString(),
          questionIndex: session.currentQuestionIndex,
          eventTag: 'timeout',
        });

        await saveSessionToSupabase(session);

        return res.json({
          session,
          interviewerMessage: timeoutMsg,
          resetQuestionTimer: true,
          interviewEnded: false,
        });
      } else {
        session.currentPhase = 'candidate_questions';
        const stage5Msg = `Thank you, ${session.candidateName}—our 90 seconds on that final question are up. That's everything from my side. Before we wrap up, do you have any questions for me about the ${session.detectedRole} role or Global Hire 360?`;
        session.transcript.push({
          id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
          speaker: 'interviewer',
          speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
          text: stage5Msg,
          timestamp: new Date().toISOString(),
          eventTag: 'question',
        });
        await saveSessionToSupabase(session);
        return res.json({
          session,
          interviewerMessage: stage5Msg,
          resetQuestionTimer: true,
          interviewEnded: false,
        });
      }
    }

    // CASE C: Evaluate Candidate's Spoken Answer & Detect when Candidate Seems Not to Know
    session.currentQuestionAttempts += 1;

    const seemsNotToKnow =
      /\b(i\s+don'?t\s+know|do\s+not\s+know|no\s+idea|not\s+sure|i'?m\s+not\s+sure|i\s+am\s+not\s+sure|i'?m\s+stuck|i\s+have\s+no\s+clue|can'?t\s+think|cannot\s+think|pass\s+on\s+this|skip\s+this|help\s+me|not\s+familiar)\b/i.test(
        cleanText
      );

    const markingGuideEval = evaluateCandidateResponseWithMarkingGuide({
      questionId: currentQ.id,
      questionText: currentQ.question,
      category: currentQ.category,
      expectedFocus: currentQ.expectedFocus,
      proposedAnswer: currentQ.proposedAnswer,
      candidateText: cleanText,
      role: session.detectedRole,
    });

    let isOnTopic = seemsNotToKnow ? false : markingGuideEval.isOnTopic;
    let scoreOutOf5 = seemsNotToKnow ? 1.0 : markingGuideEval.scoreOutOf5;
    let feedback = markingGuideEval.feedback;
    let strengths = markingGuideEval.strengths;
    let improvementTip = markingGuideEval.improvementTip;
    let coachingRephraseMessage = '';
    let aiScoreOutOf5: number | null = null;

    const ai = getGenAIClientOrNull();
    if (ai && !seemsNotToKnow) {
      try {
        const evalResp = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `You are Sarah, Operations and Talent Manager at Global Hire 360.
Candidate: ${session.candidateName}
Target Job Position: ${session.detectedRole}
Question ${currentQ.number} (${currentQ.category}): "${currentQ.question}"
Proposed Marking Guide Answer: "${currentQ.proposedAnswer || currentQ.expectedFocus}"
Expected Key Focus: "${currentQ.expectedFocus}"
Attempt Number on this question: ${session.currentQuestionAttempts} of 2
Candidate's Spoken Response: "${cleanText}"

MARKING GUIDE SCORING PROTOCOL:
- Evaluate whether the candidate's response makes sense and aligns in meaning and reasoning with the Proposed Marking Guide Answer.
- Score on a 0 to 5 scale (increments of 0.5 allowed).
- If isOnTopic is false and this is Attempt 1, write a calm, supportive hiring manager response (coachingRephraseMessage) in 2 short sentences that reassures them and rephrases Question ${currentQ.number} with a concrete angle to think about.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                isOnTopic: { type: Type.BOOLEAN },
                scoreOutOf5: { type: Type.NUMBER },
                feedback: { type: Type.STRING },
                strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
                improvementTip: { type: Type.STRING },
                coachingRephraseMessage: { type: Type.STRING },
              },
              required: ['isOnTopic', 'scoreOutOf5', 'feedback', 'strengths', 'improvementTip'],
            },
          },
        });

        const parsedEval = JSON.parse(evalResp.text || '{}');
        if (typeof parsedEval.isOnTopic === 'boolean') isOnTopic = parsedEval.isOnTopic;
        if (typeof parsedEval.scoreOutOf5 === 'number') {
          aiScoreOutOf5 = parsedEval.scoreOutOf5;
        }
        if (parsedEval.feedback) feedback = parsedEval.feedback;
        if (Array.isArray(parsedEval.strengths) && parsedEval.strengths.length > 0) {
          strengths = parsedEval.strengths.slice(0, 3);
        }
        if (parsedEval.improvementTip) improvementTip = parsedEval.improvementTip;
        if (parsedEval.coachingRephraseMessage) {
          coachingRephraseMessage = parsedEval.coachingRephraseMessage;
        }
      } catch (err) {
        console.warn('Turn evaluation fallback to deterministic marking guide:', err);
      }
    }

    // Final mark: how closely the answer follows the suggested answer for this position
    // (marking-guide pillars, blended with the AI judgement when available).
    const alignment = gradeAnswerAgainstSuggestedAnswer({
      questionId: currentQ.id,
      questionText: currentQ.question,
      category: currentQ.category,
      expectedFocus: currentQ.expectedFocus,
      proposedAnswer: currentQ.proposedAnswer,
      candidateText: cleanText,
      role: session.detectedRole,
      aiScoreOutOf5,
    });
    if (!seemsNotToKnow) scoreOutOf5 = alignment.scoreOutOf5;

    // WHEN CANDIDATE SEEMS NOT TO KNOW OR IS OFF-TOPIC:
    // Attempt 1: Empathetically reassure & guide them with a simpler angle.
    // Attempt 2: Smooth AI Coach Takeover — briefly share the key hiring manager insight and advance to the next question so they complete the practice interview!
    if (!isOnTopic || seemsNotToKnow) {
      if (session.currentQuestionAttempts === 1) {
        const rephraseMsg = seemsNotToKnow
          ? `That's completely okay, ${session.candidateName}—it's normal to pause on a question like this. Think of it simply from a day-to-day perspective: ${currentQ.expectedFocus.toLowerCase()}. Even a brief example from past work or how you'd approach it is great—give it a try!`
          : coachingRephraseMessage ||
            `I see what you mean, ${session.candidateName}. Let me reframe Question ${currentQ.number} slightly so we connect it directly to the role: think about ${currentQ.expectedFocus.toLowerCase()}. How would you handle that situation?`;

        session.transcript.push({
          id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
          speaker: 'interviewer',
          speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
          text: rephraseMsg,
          timestamp: new Date().toISOString(),
          questionIndex: session.currentQuestionIndex,
          eventTag: 'rephrase',
        });

        await saveSessionToSupabase(session);

        return res.json({
          session,
          interviewerMessage: rephraseMsg,
          resetQuestionTimer: true,
          interviewEnded: false,
        });
      } else {
        // Attempt 2: AI Hiring Manager smoothly takes over, offers a quick helpful pointer, records 1/5, and moves to the next question!
        const coachedEval: QuestionEvaluation = {
          questionId: currentQ.id || `q${currentQ.number}`,
          questionNumber: currentQ.number,
          category: currentQ.category,
          questionText: currentQ.question,
          proposedAnswer: currentQ.proposedAnswer,
          candidateAnswer: cleanText || 'Candidate needed coaching guidance on this question.',
          attemptsUsed: 2,
          timedOut: false,
          scoreOutOf5: 1,
          feedback:
            'You seemed unsure on this question during the live call, so the interviewer stepped in to guide you and keep the conversation moving.',
          strengths: ['Stayed composed and engaged during the practice conversation'],
          improvementTip:
            currentQ.expectedFocus ||
            'Review the Suggested Answer for this question on your results page.',
          alignmentPercent: alignment.alignmentPercent,
          matchedPoints: alignment.matchedPoints,
          missedPoints: alignment.missedPoints,
          gradingMethod: alignment.gradingMethod,
        };
        session.questionEvaluations = [
          ...session.questionEvaluations.filter(
            (ev) => ev.questionNumber !== currentQ.number && ev.questionId !== currentQ.id
          ),
          coachedEval,
        ];

        recomputeSessionScore(session);

        if (session.currentQuestionIndex < session.questions.length - 1) {
          session.currentQuestionIndex += 1;
          session.currentQuestionAttempts = 0;
          const nextQ = session.questions[session.currentQuestionIndex];
          const takeoverMsg = `No problem at all, ${session.candidateName}—let me help you out here. In a real interview for ${session.detectedRole}, employers mainly look for how you focus on ${currentQ.expectedFocus.toLowerCase()}, and I've included a full suggested answer for you on your score page. Let's keep going with Question ${nextQ.number}: ${nextQ.question}`;

          session.transcript.push({
            id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
            speaker: 'interviewer',
            speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
            text: takeoverMsg,
            timestamp: new Date().toISOString(),
            questionIndex: session.currentQuestionIndex,
            eventTag: 'question',
          });

          await saveSessionToSupabase(session);

          return res.json({
            session,
            interviewerMessage: takeoverMsg,
            resetQuestionTimer: true,
            interviewEnded: false,
          });
        } else {
          session.currentPhase = 'candidate_questions';
          const takeoverFinalQMsg = `No problem at all, ${session.candidateName}. On that question, employers mainly look for ${currentQ.expectedFocus.toLowerCase()}, and I've included a full suggested answer on your score page. That wraps up my ${session.questions.length} questions—do you have any questions for me about the ${session.detectedRole} role or Global Hire 360?`;

          session.transcript.push({
            id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
            speaker: 'interviewer',
            speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
            text: takeoverFinalQMsg,
            timestamp: new Date().toISOString(),
            eventTag: 'question',
          });

          await saveSessionToSupabase(session);

          return res.json({
            session,
            interviewerMessage: takeoverFinalQMsg,
            resetQuestionTimer: true,
            interviewEnded: false,
          });
        }
      }
    }

    // Candidate's answer is ON-TOPIC -> Record score out of 5 and engage in natural employer-to-candidate dialogue
    const passedEval: QuestionEvaluation = {
      questionId: currentQ.id || `q${currentQ.number}`,
      questionNumber: currentQ.number,
      category: currentQ.category,
      questionText: currentQ.question,
      proposedAnswer: currentQ.proposedAnswer,
      candidateAnswer: cleanText,
      attemptsUsed: session.currentQuestionAttempts,
      timedOut: false,
      scoreOutOf5,
      feedback,
      strengths,
      improvementTip,
      alignmentPercent: alignment.alignmentPercent,
      matchedPoints: alignment.matchedPoints,
      missedPoints: alignment.missedPoints,
      gradingMethod: alignment.gradingMethod,
    };
    session.questionEvaluations = [
      ...session.questionEvaluations.filter(
        (ev) => ev.questionNumber !== currentQ.number && ev.questionId !== currentQ.id
      ),
      passedEval,
    ];

    recomputeSessionScore(session);

    const neutralAcknowledgments = [
      `Okay, I see. That makes sense.`,
      `Got it, thank you for sharing how you approach that.`,
      `I see. That gives me a clear sense of your workflow.`,
      `Alright, thank you for walking me through that.`,
    ];
    const strongAcknowledgments = [
      `Great, thank you. That's a very practical example.`,
      `That makes sense, and I like how clearly you structured that.`,
      `Got it, thank you. That aligns really well with how our ${session.detectedRole} team operates.`,
      `Okay, great. I appreciate the concrete detail you shared there.`,
    ];
    const ackPool = scoreOutOf5 >= 4.0 ? strongAcknowledgments : neutralAcknowledgments;
    // Random pick so candidates don't hear the same line at the same point of every interview.
    const bridgeText = ackPool[crypto.randomInt(ackPool.length)];

    if (session.currentQuestionIndex < session.questions.length - 1) {
      session.currentQuestionIndex += 1;
      session.currentQuestionAttempts = 0;
      const nextQ = session.questions[session.currentQuestionIndex];

      const nextMsg = `${bridgeText} Let's move on to Question ${nextQ.number}: ${nextQ.question}`;

      session.transcript.push({
        id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
        speaker: 'interviewer',
        speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
        text: nextMsg,
        timestamp: new Date().toISOString(),
        questionIndex: session.currentQuestionIndex,
        eventTag: 'question',
      });

      await saveSessionToSupabase(session);

      return res.json({
        session,
        interviewerMessage: nextMsg,
        resetQuestionTimer: true,
        interviewEnded: false,
      });
    } else {
      // Completed all 5 questions -> Transition smoothly to Stage 5 (Candidate's Questions)
      session.currentPhase = 'candidate_questions';
      const stage5Invite = `${bridgeText} That's everything from my side on the core questions. Before we wrap up our interview, do you have any questions for me about the ${session.detectedRole} role or Global Hire 360?`;

      session.transcript.push({
        id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_i`,
        speaker: 'interviewer',
        speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
        text: stage5Invite,
        timestamp: new Date().toISOString(),
        eventTag: 'question',
      });

      await saveSessionToSupabase(session);

      return res.json({
        session,
        interviewerMessage: stage5Invite,
        resetQuestionTimer: true,
        interviewEnded: false,
      });
    }
  } catch (err: any) {
    console.error('Error in /api/interview-turn:', err);
    return res.status(500).json({ error: err?.message || 'Error processing interview turn.' });
  }
});

// 5d. Finalize Session (Called either at the end of Stage 5/6, after 2-attempt termination, misconduct termination, or when Live WebSocket call ends)
const sessionFinalizeLocks = new Map<string, Promise<string>>();

/**
 * Finalizes a session exactly once. Several paths can end an interview (last answer,
 * 10-minute timer, Gemini end_call — which may fire more than once —, the End Call button,
 * misconduct termination). Concurrent callers share the same in-flight finalization and
 * later callers get the stored result, so scoring, DB writes and the results email happen once.
 */
async function concludeAndFinalizeSession(
  session: InterviewSessionRecord,
  res: express.Response,
  terminatedEarlyForAttempts = false,
  terminatedForMisconduct = false,
  alreadyAppendedManagerAnswer = false
) {
  const finishedPayload = (spoken?: string) => ({
    session,
    interviewerMessage: spoken || session.interviewerFinalImpression || 'The interview is complete.',
    resetQuestionTimer: false,
    interviewEnded: true,
  });

  if (session.currentPhase === 'finished' && session.completedAt) {
    return res.json(finishedPayload());
  }

  let inflight = sessionFinalizeLocks.get(session.id);
  if (!inflight) {
    inflight = runSessionFinalization(
      session,
      terminatedEarlyForAttempts,
      terminatedForMisconduct,
      alreadyAppendedManagerAnswer
    ).finally(() => sessionFinalizeLocks.delete(session.id));
    sessionFinalizeLocks.set(session.id, inflight);
    return res.json(finishedPayload(await inflight));
  }
  await inflight.catch(() => undefined);
  return res.json(finishedPayload());
}

async function runSessionFinalization(
  session: InterviewSessionRecord,
  terminatedEarlyForAttempts = false,
  terminatedForMisconduct = false,
  alreadyAppendedManagerAnswer = false
): Promise<string> {
  // Deduplicate any existing evaluations by questionNumber, keeping the real question id
  const dedupedByNumber = new Map<number, QuestionEvaluation>();
  for (const ev of session.questionEvaluations) {
    const q = session.questions.find((qq) => qq.number === ev.questionNumber);
    dedupedByNumber.set(ev.questionNumber, {
      ...ev,
      questionId: q?.id || ev.questionId || `q${ev.questionNumber}`,
    });
  }

  // Fill any unreached questions with 0/5 so every asked question appears on the /scoring page
  for (let i = 0; i < session.questions.length; i++) {
    const q = session.questions[i];
    const qNum = q.number || i + 1;
    if (!dedupedByNumber.has(qNum)) {
      dedupedByNumber.set(qNum, {
        questionId: q.id || `q${qNum}`,
        questionNumber: qNum,
        category: q.category,
        questionText: q.question,
        proposedAnswer: q.proposedAnswer,
        candidateAnswer: terminatedForMisconduct
          ? '[Session terminated due to professional misconduct — 24-hour suspension applied]'
          : terminatedEarlyForAttempts
          ? '[Not reached — Session concluded early for additional workshop practice]'
          : '[Not answered]',
        attemptsUsed: 0,
        timedOut: false,
        scoreOutOf5: 0,
        feedback: terminatedForMisconduct
          ? 'This question was not completed because the interview was immediately terminated for inappropriate language / professional misconduct.'
          : terminatedEarlyForAttempts
          ? 'This question was not reached because the interview concluded after two unsuccessful attempts on an earlier question.'
          : 'No response was recorded for this question.',
        strengths: [],
        improvementTip: `Key marking guide focus: ${q.expectedFocus}`,
      });
    }
  }

  session.questionEvaluations = Array.from(dedupedByNumber.values()).sort(
    (a, b) => a.questionNumber - b.questionNumber
  );

  // Every interview is marked on 20, whether 4 or 5 questions were asked.
  const { totalOutOf20: totalScore } = recomputeSessionScore(session, {
    forceZero: terminatedForMisconduct,
  });
  const penaltyPoints = Number(session.misconductPenaltyPoints || 0);
  const qCount = session.questions.length || DEFAULT_QUESTION_COUNT;
  const passingScore = INTERVIEW_PASSING_SCORE;

  session.successful =
    !terminatedEarlyForAttempts && !terminatedForMisconduct && totalScore >= passingScore;
  session.currentPhase = 'finished';
  session.completedAt = new Date().toISOString();

  const answeredCount = session.questionEvaluations.filter(
    (ev) => ev.candidateAnswer && !/^\[(not answered|no response|not reached)/i.test(ev.candidateAnswer)
  ).length;
  const firstName = session.candidateName.split(/\s+/)[0] || session.candidateName;
  const pct = session.percentageScore;
  const penaltyNote =
    !terminatedForMisconduct && penaltyPoints > 0 ? ` ${penaltyPoints} points were deducted for a conduct warning.` : '';

  if (terminatedForMisconduct) {
    session.status = 'terminated_misconduct';
    if (!session.suspendedUntil) {
      session.suspendedUntil = await suspendCandidateFor24Hours({
        email: session.candidateEmail,
        candidateId: session.candidateId,
        reason: 'Inappropriate language or professional misconduct during live interview.',
      });
    }
    session.interviewerFinalImpression = `This interview was ended for unprofessional language, so it scores 0. You can try again after ${new Date(
      session.suspendedUntil
    ).toLocaleString()}.`;
  } else if (session.liveEndReason === 'terminated_rules_violation') {
    session.successful = false;
    session.status = 'terminated_rules_violation';
    session.interviewerFinalImpression = `This interview was ended because the one-to-one rules weren't respected. Try again on your own, in a quiet place.`;
  } else if (terminatedEarlyForAttempts) {
    session.status = 'terminated_attempts';
    session.interviewerFinalImpression = `The interview ended early because two answers didn't address the question.${penaltyNote} Read each question carefully, compare with the suggested answers, and try again, ${firstName}.`;
  } else {
    session.status = session.successful ? 'completed_success' : 'completed_unsuccessful';
    // Short appreciation that matches the effort: how much was answered and how well.
    const answeredAll = answeredCount >= qCount;
    session.interviewerFinalImpression =
      pct >= 85
        ? `Excellent work, ${firstName} — clear, relevant answers that match what employers look for.`
        : session.successful
        ? `Well done, ${firstName}, you passed. A few more concrete examples will make your answers even stronger.`
        : pct >= 45
        ? `Good effort, ${firstName} — you're close. Compare your answers with the suggested ones and try again.`
        : answeredAll
        ? `Thanks for answering every question, ${firstName}. Study the suggested answers and practice — you'll improve quickly.`
        : `You made a start, ${firstName}. Next time, try to answer every question fully.`;
    session.interviewerFinalImpression += penaltyNote;
  }

  session.transcript.push({
    id: `tr_${Date.now()}_final`,
    speaker: 'interviewer',
    speakerName: 'Sarah (Global Hire 360 Hiring Manager)',
    text: session.interviewerFinalImpression,
    timestamp: new Date().toISOString(),
    eventTag: terminatedForMisconduct
      ? 'misconduct_termination'
      : terminatedEarlyForAttempts
      ? 'termination'
      : 'closing',
  });

  // If we just appended a manager answer to the candidate's Stage 5 question, combine it with the final closing so Sarah speaks both smoothly
  let spokenClosingMessage = session.interviewerFinalImpression;
  if (alreadyAppendedManagerAnswer && session.transcript.length >= 2) {
    const prevEntry = session.transcript[session.transcript.length - 2];
    if (prevEntry && prevEntry.speaker === 'interviewer') {
      spokenClosingMessage = `${prevEntry.text} ${session.interviewerFinalImpression}`;
    }
  }

  // Persist the finished session (and its per-answer rows) first, then send the single
  // results email; sendResendAssessmentEmail is itself idempotent per session.
  const supabaseRes = await saveSessionToSupabase(session);
  session.supabaseSaved = supabaseRes.saved;
  const resendRes = await sendResendAssessmentEmail(session);
  if (!resendRes.inProgress) {
    session.emailDeliveryNote = resendRes.note;
  }
  // Record final email state in the database row too.
  await saveSessionToSupabase(session);
  if (!resendRes.sent && !resendRes.inProgress && session.emailStatus === 'failed') {
    // One more automatic try a few minutes later (same idempotency key: never a duplicate).
    setTimeout(() => void retryResultEmail(session), 3 * 60_000).unref();
  }

  return spokenClosingMessage;
}

/** The candidate is speaking to the interviewer (question / line check) rather than answering. */
export function isCandidateTalkingToInterviewer(text: string): boolean {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (/\b(are\s+you\s+(still\s+)?there|can\s+you\s+hear\s+me|do\s+you\s+hear\s+me|is\s+(anyone|somebody)\s+there|you('re|\s+are)\s+repeating)\b/.test(t)) {
    return words <= 30;
  }
  return (
    words <= 30 &&
    /^(?:(?:hi|hello|okay|ok|sorry|um+|uh+|so|yes|yeah)[\s,.]+)*(?:i\s+have\s+a\s+question|can\s+i\s+ask|may\s+i\s+ask|quick\s+question|before\s+i\s+answer)\b/.test(t)
  );
}

const liveGradingLocks = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Live voice grading helpers
// ---------------------------------------------------------------------------
/**
 * Splits the interview transcript into the candidate's own words for each question.
 * Uses the per-question tags written by the live bridge; otherwise detects when the
 * interviewer asked each prepared question (in order) and assigns what follows to it.
 */
export function collectCandidateAnswersPerQuestion(session: InterviewSessionRecord): Map<number, string> {
  const answers = new Map<number, string>();
  const hasTags = session.transcript.some(
    (t) => t.speaker === 'candidate' && Number.isInteger(t.questionIndex)
  );
  let currentNumber = 0;
  for (const entry of session.transcript) {
    if (entry.speaker === 'interviewer') {
      if (!hasTags) {
        const next = session.questions[currentNumber];
        if (next && interviewerTextAsksQuestion(entry.text, next.question)) currentNumber += 1;
      }
      continue;
    }
    const qNumber = hasTags
      ? Number.isInteger(entry.questionIndex)
        ? (entry.questionIndex as number) + 1
        : 0
      : currentNumber;
    if (qNumber < 1 || qNumber > session.questions.length) continue;
    const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    answers.set(qNumber, `${answers.get(qNumber) || ''} ${text}`.trim());
  }
  return answers;
}

/**
 * Replaces the live captions of the candidate's turns with an accurate English transcript of
 * the recorded microphone audio (see candidate-audio.ts). Turns that cannot be transcribed
 * keep their live caption. The audio is discarded afterwards.
 */
async function applyAccurateCandidateTranscript(session: InterviewSessionRecord): Promise<void> {
  const recorder = candidateRecorders.get(session.id);
  const ai = getGenAIClientOrNull();
  try {
    if (!recorder || !ai || !recorder.hasAudio) return;
    const byEntry = await transcribeCandidateAudio(ai, recorder, {
      vocabulary: buildTranscriptionVocabulary(session),
      questions: session.questions,
    });
    let replaced = 0;
    for (const entry of session.transcript) {
      const accurate = entry.speaker === 'candidate' ? byEntry.get(entry.id) : undefined;
      if (accurate) {
        entry.text = clampText(accurate, 6000);
        replaced += 1;
      }
    }
    console.log(`[Transcript] ${session.id}: ${replaced} candidate turn(s) re-transcribed from audio.`);
  } catch (err: any) {
    console.warn('Accurate candidate transcript unavailable, keeping live captions:', err?.message || err);
  } finally {
    candidateRecorders.delete(session.id);
  }
}

/**
 * Grades a live voice interview question by question: each answer (the candidate's own words,
 * from the accurate transcript) is marked out of 5 against the suggested answer with a fixed
 * rubric (answer-grading.ts). The keyword marking guide is used only when AI grading fails.
 */
async function gradeLiveInterviewAnswers(session: InterviewSessionRecord): Promise<QuestionEvaluation[]> {
  const answers = collectCandidateAnswersPerQuestion(session);
  const ai = getGenAIClientOrNull();
  const rubric = ai
    ? await gradeAnswersWithRubric(
        ai,
        session.detectedRole,
        session.questions.map((q) => ({
          question: {
            number: q.number,
            question: q.question,
            suggestedAnswer: q.proposedAnswer || q.expectedFocus,
            expectedFocus: q.expectedFocus,
          },
          answer: answers.get(q.number) || '',
        }))
      )
    : new Map();

  return session.questions.map((q) => {
    const text = (answers.get(q.number) || '').trim();
    const base = {
      questionId: q.id,
      questionNumber: q.number,
      category: q.category,
      questionText: q.question,
      proposedAnswer: q.proposedAnswer,
    };
    if (wordCount(text) < 2) {
      return {
        ...base,
        candidateAnswer: '[No response recorded for this question]',
        attemptsUsed: 0,
        timedOut: false,
        scoreOutOf5: 0,
        feedback: 'No response was recorded for this question.',
        strengths: [],
        improvementTip: `Key marking guide focus: ${q.expectedFocus}`,
      } as QuestionEvaluation;
    }
    const guide = gradeAnswerAgainstSuggestedAnswer({
      questionId: q.id,
      questionText: q.question,
      category: q.category,
      expectedFocus: q.expectedFocus,
      proposedAnswer: q.proposedAnswer,
      candidateText: text,
      role: session.detectedRole,
      aiScoreOutOf5: null,
    });
    const r = rubric.get(q.number);
    return {
      ...base,
      candidateAnswer: text,
      attemptsUsed: 1,
      timedOut: false,
      scoreOutOf5: r ? r.scoreOutOf5 : guide.scoreOutOf5,
      feedback: r?.feedback || guide.feedback,
      strengths: r ? r.strengths : guide.strengths,
      improvementTip: r?.improvementTip || guide.improvementTip,
      alignmentPercent: r ? Math.round((r.alignment / 2) * 100) : guide.alignmentPercent,
      matchedPoints: guide.matchedPoints,
      missedPoints: guide.missedPoints,
      gradingMethod: r ? 'marking_guide+ai' : 'marking_guide',
    } as QuestionEvaluation;
  });
}

// 5e. Finalize Live WebSocket Call Transcript endpoint (Grades a full LUNA-style Gemini Live WebSocket transcript against the Marking Guide)
app.post('/api/finalize-live-ws-session', async (req, res) => {
  try {
    const {
      sessionId,
      liveTranscript,
      terminatedByAttemptRule,
      terminatedByMisconduct,
    } = req.body || {};
    const session = activeSessions.get(clampText(sessionId, 100));
    if (!session || !sessionTokenMatches(session, readSessionToken(req))) {
      return res.status(404).json({ error: 'Interview session not found.' });
    }

    // Already finalized (e.g. end_call fired twice, or End Call clicked after auto-finish):
    // return the stored result without re-grading or re-sending the email.
    if (session.currentPhase === 'finished' || sessionFinalizeLocks.has(session.id)) {
      return await concludeAndFinalizeSession(session, res);
    }
    const pendingGrading = liveGradingLocks.get(session.id);
    if (pendingGrading) {
      await pendingGrading.catch(() => undefined);
      return await concludeAndFinalizeSession(session, res);
    }
    let releaseGrading!: () => void;
    liveGradingLocks.set(session.id, new Promise<void>((r) => (releaseGrading = r)));
    try {

    // Live voice interviews: the server records the transcript itself from the Gemini stream
    // (tagged per question), so the browser copy is only used when the server has none.
    const serverHasLiveTranscript =
      Boolean(session.liveMode) && session.transcript.some((t) => t.speaker === 'candidate');
    if (!serverHasLiveTranscript && Array.isArray(liveTranscript) && liveTranscript.length > 0) {
      // Accept only well-formed, size-bounded transcript entries from the browser.
      session.transcript = liveTranscript
        .slice(0, 400)
        .filter((t: any) => t && (t.speaker === 'interviewer' || t.speaker === 'candidate'))
        .map((t: any, idx: number) => ({
          id: clampText(t.id || `tr_live_${idx}`, 80),
          speaker: t.speaker,
          speakerName: clampText(t.speakerName, 120),
          text: clampText(t.text, 6000),
          timestamp: clampText(t.timestamp || new Date().toISOString(), 40),
          questionIndex: Number.isInteger(t.questionIndex) ? t.questionIndex : undefined,
          eventTag: typeof t.eventTag === 'string' ? clampText(t.eventTag, 40) : undefined,
        })) as TranscriptEntry[];
    }
    if (session.liveMode && !session.liveEndReason) {
      session.liveEndReason = 'ended_by_candidate';
    }

    // Also scan candidate transcript turns for any unflagged misconduct
    let detectedMisconductTermination =
      Boolean(terminatedByMisconduct) ||
      session.status === 'terminated_misconduct' ||
      session.liveEndReason === 'terminated_misconduct';
    for (const entry of session.transcript) {
      if (entry.speaker === 'candidate') {
        const mc = detectCandidateMisconduct(entry.text);
        if (mc.isMisconduct) {
          session.misconductCount = (session.misconductCount || 0) + 1;
          session.misconductNotes = session.misconductNotes || [];
          session.misconductNotes.push(`Transcript misconduct detected: ${mc.reason}`);
          if (mc.severity === 'severe' || (session.misconductCount || 0) >= 2) {
            detectedMisconductTermination = true;
          } else {
            session.misconductPenaltyPoints = Math.max(session.misconductPenaltyPoints || 0, 3);
          }
        }
      }
    }

    // Text/fallback-voice interviews are already graded answer by answer in /api/interview-turn.
    const alreadyGradedTurnByTurn = !session.liveMode && session.questionEvaluations.length > 0;
    if (!alreadyGradedTurnByTurn) {
      // Answers are marked on what the candidate said: first get that text exactly right.
      if (session.liveMode) await applyAccurateCandidateTranscript(session);
      session.questionEvaluations = await gradeLiveInterviewAnswers(session);
    }

    return await concludeAndFinalizeSession(
      session,
      res,
      Boolean(terminatedByAttemptRule) || session.liveEndReason === 'terminated_after_two_attempts',
      detectedMisconductTermination
    );
    } finally {
      liveGradingLocks.delete(session.id);
      releaseGrading();
    }
  } catch (err: any) {
    console.error('Error in /api/finalize-live-ws-session:', err);
    return res.status(500).json({ error: err?.message || 'Failed to finalize live session.' });
  }
});

// 5f. Get session by ID & On-Demand Resend Email Delivery (session token required)
app.get('/api/session/:id', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session || !sessionTokenMatches(session, readSessionToken(req))) {
    return res.status(404).json({ error: 'Session not found' });
  }
  return res.json({ session });
});

// No manual (re)send endpoint: the results email is sent exactly once, automatically, when the
// interview is finalized (see sendResendAssessmentEmail and retryUnsentResultEmails).

function stripSessionSecrets(s: InterviewSessionRecord) {
  const { accessToken: _t, ...rest } = s;
  return rest;
}

// 5g. Candidates & Relational Interview Sessions Endpoints (ADMIN ONLY — contains personal data)
app.get('/api/candidates', requireAdmin, async (_req, res) => {
  const supabaseRelationalData = await postgrestSelect(
    'candidates?select=*,interview_sessions(*),candidate_answers(*)&order=updated_at.desc'
  );

  const allSessions = Array.from(activeSessions.values());
  const candidatesWithSessions = Array.from(activeCandidates.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((candidate) => ({
      ...candidate,
      interviewSessions: allSessions
        .filter((s) => s.candidateId === candidate.id || s.candidateEmail === candidate.email)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(stripSessionSecrets),
    }));

  return res.json({
    totalCandidates: candidatesWithSessions.length,
    totalInterviewSessions: allSessions.length,
    relation:
      'public.candidates (1) ---> (Many) public.interview_sessions (1) ---> (Many) public.candidate_answers',
    supabaseLiveJoinRows: supabaseRelationalData,
    candidates: candidatesWithSessions,
  });
});

app.get('/api/candidates/:id', requireAdmin, (req, res) => {
  const candidateIdOrEmail = req.params.id.trim().toLowerCase();
  let candidate = activeCandidates.get(req.params.id);
  if (!candidate) {
    for (const c of activeCandidates.values()) {
      if (c.id.toLowerCase() === candidateIdOrEmail || c.email.toLowerCase() === candidateIdOrEmail) {
        candidate = c;
        break;
      }
    }
  }

  if (!candidate) {
    return res.status(404).json({ error: 'Candidate not found.' });
  }

  const linkedSessions = Array.from(activeSessions.values())
    .filter((s) => s.candidateId === candidate!.id || s.candidateEmail === candidate!.email)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(stripSessionSecrets);

  return res.json({
    candidate,
    interviewSessions: linkedSessions,
  });
});

// 5h. Supabase Schema SQL & Live Sync Endpoints (ADMIN ONLY)
app.get('/api/supabase/schema-sql', requireAdmin, (_req, res) => {
  try {
    const schemaPath = path.join(process.cwd(), 'supabase-schema.sql');
    const sqlContent = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf-8') : '';
    res.type('text/plain').send(sqlContent);
  } catch {
    res.status(500).json({ error: 'Failed to read supabase-schema.sql' });
  }
});

app.post('/api/supabase/sync', requireAdmin, async (_req, res) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(400).json({
      connected: false,
      error:
        'Supabase credentials not found in environment variables. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) in AI Studio Settings -> Secrets.',
    });
  }

  const ddlResult = await provisionSupabaseTablesViaManagementApi();
  const seedResult = await seedCustomerServiceQuestionsToSupabase();

  let syncedCandidates = 0;
  for (const candidate of activeCandidates.values()) {
    const r = await saveCandidateToSupabase(candidate);
    if (r.saved) syncedCandidates++;
  }

  let syncedSessions = 0;
  for (const session of activeSessions.values()) {
    const r = await saveSessionToSupabase(session);
    if (r.saved) syncedSessions++;
  }

  return res.json({
    connected: true,
    supabaseUrl: config.url,
    ddlProvisioning: ddlResult,
    customerServiceQuestionsSeeded: seedResult,
    syncedCandidatesCount: syncedCandidates,
    syncedSessionsCount: syncedSessions,
  });
});

// 5i. Single NotebookLM Female Interviewer Voice (Aoede — Sarah) & Studio Neural TTS Endpoint
export const SINGLE_INTERVIEWER_VOICE = {
  id: 'Aoede',
  edgeNeuralVoice: 'en-US-AvaMultilingualNeural',
  name: 'Sarah — Global Hire 360 Operations & Talent Manager (NotebookLM Aoede Voice)',
  tone: 'Warm, natural, composed NotebookLM female host & hiring manager cadence',
  pitch: 1.0,
  rate: 0.99,
} as const;

const ttsAudioMemoryCache = new Map<string, { mimeType: string; audioBase64: string }>();

async function synthesizeNotebookLmFemaleVoiceMp3(text: string): Promise<Buffer | null> {
  try {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      SINGLE_INTERVIEWER_VOICE.edgeNeuralVoice,
      OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3
    );
    const { audioStream } = tts.toStream(clean);
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          tts.close();
        } catch {
          // ignore
        }
        resolve();
      }, 9500);

      audioStream.on('data', (d: Buffer | Uint8Array) => {
        chunks.push(Buffer.from(d));
      });
      audioStream.on('end', () => {
        clearTimeout(timeout);
        resolve();
      });
      audioStream.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      audioStream.on('error', (err: any) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    try {
      tts.close();
    } catch {
      // ignore
    }

    if (chunks.length === 0) return null;
    return Buffer.concat(chunks);
  } catch (err) {
    console.warn('MsEdgeTTS NotebookLM voice synthesis warning:', err);
    return null;
  }
}

function splitTextIntoTtsChunks(text: string, maxLen = 175): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks: string[] = [];
  let current = '';

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;

    if ((current + ' ' + sentence).trim().length <= maxLen) {
      current = (current + ' ' + sentence).trim();
    } else {
      if (current) chunks.push(current);
      if (sentence.length <= maxLen) {
        current = sentence;
      } else {
        const words = sentence.split(' ');
        let piece = '';
        for (const w of words) {
          if ((piece + ' ' + w).trim().length <= maxLen) {
            piece = (piece + ' ' + w).trim();
          } else {
            if (piece) chunks.push(piece);
            piece = w;
          }
        }
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function fetchGoogleNeuralFemaleTtsMp3(text: string): Promise<Buffer | null> {
  // Primary: Studio-grade Microsoft Edge Neural Multilingual Female Voice (AvaMultilingualNeural — NotebookLM cadence)
  const studioNeuralMp3 = await synthesizeNotebookLmFemaleVoiceMp3(text);
  if (studioNeuralMp3 && studioNeuralMp3.length > 512) {
    return studioNeuralMp3;
  }

  // Secondary fallback: Google en-US TTS stream
  try {
    const chunks = splitTextIntoTtsChunks(text, 175);
    if (chunks.length === 0) return null;

    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-US&q=${encodeURIComponent(
        chunk
      )}`;
      const resp = await fetch(ttsUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      });
      if (!resp.ok) {
        return null;
      }
      const arrBuf = await resp.arrayBuffer();
      const buf = Buffer.from(arrBuf);
      if (buf.length > 0) {
        buffers.push(buf);
      }
    }

    if (buffers.length === 0) return null;
    return Buffer.concat(buffers);
  } catch (err) {
    console.warn('Google neural TTS stream warning:', err);
    return null;
  }
}

function pcm24kToWavBuffer(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Buffer {
  // If buffer already starts with RIFF header (e.g. Gemini 3.8 TTS unary output), return as-is
  if (pcmBuffer.length >= 44 && pcmBuffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    return pcmBuffer;
  }
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

app.get('/api/google-avatar.svg', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const rawName = String(req.query.name || email || 'Candidate').trim();
  const bgColor = getGoogleAccountColorForEmail(email || rawName);

  const parts = rawName
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials =
    parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : (rawName.slice(0, 2) || 'C').toUpperCase();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
    <defs>
      <radialGradient id="gGlow" cx="30%" cy="25%" r="75%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.12"/>
      </radialGradient>
    </defs>
    <circle cx="128" cy="128" r="128" fill="${bgColor}"/>
    <circle cx="128" cy="128" r="128" fill="url(#gGlow)"/>
    <text x="128" y="136" text-anchor="middle" dominant-baseline="middle" fill="#FFFFFF" font-family="'Plus Jakarta Sans', 'Google Sans', Inter, Arial, sans-serif" font-size="96" font-weight="700" letter-spacing="1">${initials}</text>
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
});

app.get('/api/candidate-profile-picture', async (req, res) => {
  const email = String(req.query.email || '');
  const fullName = String(req.query.name || req.query.fullName || 'Candidate');
  const resolved = await resolveGoogleAccountProfilePicture(email, fullName);
  res.json(resolved);
});

app.post('/api/candidate-profile-picture', (req, res) => {
  const { fullName, avatarDataUrl, sessionId } = req.body || {};
  const cleanAvatar = String(avatarDataUrl || '').trim();
  // Only the owner of a live session may set the avatar, and only to a small inline image.
  const sess = activeSessions.get(clampText(sessionId, 100));
  if (!sess || !sessionTokenMatches(sess, readSessionToken(req))) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  if (
    cleanAvatar.length > 400_000 ||
    !/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(cleanAvatar)
  ) {
    return res.status(400).json({ error: 'avatarDataUrl must be a PNG, JPEG or WebP data URL under 300KB.' });
  }
  const cleanEmail = sess.candidateEmail;

  verifiedGoogleAvatarCache.set(cleanEmail, cleanAvatar);

  const existingCandidate = activeCandidates.get(sess.candidateId);
  if (existingCandidate) {
    existingCandidate.googleAvatarUrl = cleanAvatar;
    activeCandidates.set(existingCandidate.id, existingCandidate);
  }

  sess.candidateGoogleAvatarUrl = cleanAvatar;
  activeSessions.set(sess.id, sess);

  flushCandidatesAndSessionsToDisk();
  return res.json({
    saved: true,
    primaryUrl: cleanAvatar,
    candidateName: fullName || existingCandidate?.fullName || 'Candidate',
  });
});

app.get('/api/live-agent-config', (_req, res) => {
  res.json({
    apiVersion: 'v1alpha',
    models: LIVE_MODELS,
    voiceName: SINGLE_INTERVIEWER_VOICE.id,
    neuralFallbackVoice: SINGLE_INTERVIEWER_VOICE.edgeNeuralVoice,
    interviewerName: 'Sarah',
    interviewerTitle: 'Operations and Talent Manager',
    companyName: 'Global Hire 360',
    turnEndSilenceMs: TURN_END_SILENCE_MS,
  });
});

app.get('/api/interviewer-voices', (_req, res) => {
  res.json({
    defaultVoice: SINGLE_INTERVIEWER_VOICE.id,
    singleVoiceLocked: true,
    voices: [SINGLE_INTERVIEWER_VOICE],
  });
});

app.post('/api/interviewer-tts', async (req, res) => {
  const { text } = req.body || {};
  const cleanText = clampText(text, 2500).trim();
  if (!cleanText) {
    return res.status(400).json({ error: 'Text is required for TTS.' });
  }

  // Always lock to the single NotebookLM voice: Aoede
  const selectedVoice = SINGLE_INTERVIEWER_VOICE.id;
  const cacheKey = `${selectedVoice}::${cleanText}`;
  const cachedAudio = ttsAudioMemoryCache.get(cacheKey);
  if (cachedAudio) {
    return res.json({
      fallback: false,
      voiceName: selectedVoice,
      mimeType: cachedAudio.mimeType,
      audioBase64: cachedAudio.audioBase64,
    });
  }

  const ai = getGenAIClientOrNull();
  if (ai) {
    for (const ttsModel of [
      'gemini-3.8-flash-lite-tts',
      'gemini-3.8-flash-tts',
      'gemini-2.5-flash-preview-tts',
    ]) {
      try {
        const response = await ai.models.generateContent({
          model: ttsModel,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: cleanText,
                  ...(ttsModel.startsWith('gemini-3.8')
                    ? {
                        speechMetadata: {
                          style:
                            'Warm, natural, composed hiring manager and NotebookLM podcast host',
                        },
                      }
                    : {}),
                } as any,
              ],
            },
          ],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice },
              },
            },
          } as any,
        });

        const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const base64Audio = inlineData?.data;
        const rawMime = inlineData?.mimeType || 'audio/wav';
        if (base64Audio) {
          const rawBuf = Buffer.from(base64Audio, 'base64');
          const wavBuffer = pcm24kToWavBuffer(rawBuf, 24000, 1, 16);
          const wavB64 = wavBuffer.toString('base64');
          ttsAudioMemoryCache.set(cacheKey, { mimeType: 'audio/wav', audioBase64: wavB64 });
          return res.json({
            fallback: false,
            voiceName: selectedVoice,
            mimeType: 'audio/wav',
            audioBase64: wavB64,
          });
        }
      } catch (err: any) {
        console.warn(`Gemini TTS (${ttsModel}) fallback check:`, err?.message || err);
      }
    }
  }

  // Server-side Studio Neural Female TTS (en-US-AvaMultilingualNeural — NotebookLM cadence)
  const neuralMp3Buffer = await fetchGoogleNeuralFemaleTtsMp3(cleanText);
  if (neuralMp3Buffer && neuralMp3Buffer.length > 0) {
    const mp3B64 = neuralMp3Buffer.toString('base64');
    ttsAudioMemoryCache.set(cacheKey, { mimeType: 'audio/mpeg', audioBase64: mp3B64 });
    return res.json({
      fallback: false,
      voiceName: selectedVoice,
      mimeType: 'audio/mpeg',
      audioBase64: mp3B64,
    });
  }

  return res.json({ fallback: true, voiceName: selectedVoice });
});

// ============================================================================
// 6. LUNA v2 REAL-TIME VOICE WEBSOCKET BRIDGE (/api/live-ws) — GEMINI-3.8-LIVE
// ============================================================================
const endCallFunctionDeclaration: FunctionDeclaration = {
  name: 'end_call',
  description:
    'Ends the live interview call. Call it only AFTER you have spoken your closing words. After calling it you must stay completely silent.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description:
          'completed_all_questions (normal end after the closing), time_up (the 10 minutes are over), terminated_rules_violation (the interview rules were broken again after a warning), terminated_after_two_attempts (the platform said to end after a second off-topic answer), or terminated_misconduct (abusive / repeated inappropriate language).',
      },
    },
    required: ['reason'],
  },
};

const advanceQuestionFunctionDeclaration: FunctionDeclaration = {
  name: 'advance_question',
  description:
    'Call this in the same turn, right before you ask a new main interview question, with that question number. Do NOT call it when you only repeat or rephrase the current question.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      questionNumber: {
        type: Type.NUMBER,
        description: 'The number of the main question you are about to ask.',
      },
    },
    required: ['questionNumber'],
  },
};

const reportMisconductFunctionDeclaration: FunctionDeclaration = {
  name: 'report_candidate_misconduct',
  description:
    'Call this IMMEDIATELY if the candidate uses profanity, inappropriate language, insults, or disrespectful conduct during the interview.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        description:
          'deduct_points_warning (for 1st mild offense: deducts 3 points and warns candidate) or terminate_and_suspend_24h (for severe profanity/insults or a 2nd offense: ends call and suspends candidate for 24 hours).',
      },
      pointsDeducted: {
        type: Type.NUMBER,
        description: 'Points deducted for misconduct (default 3 for warning, 25 for termination).',
      },
      reason: {
        type: Type.STRING,
        description: 'Brief explanation of the inappropriate language or misconduct.',
      },
    },
    required: ['action', 'reason'],
  },
};

// Recorded candidate audio is only needed until the interview is graded.
setInterval(() => {
  pruneRecorders((id) => {
    const s = activeSessions.get(id);
    return Boolean(s && s.currentPhase !== 'finished');
  });
}, 5 * 60_000).unref();

/** One live voice bridge per interview session: a new connection always replaces the old one. */
const liveVoiceConnections = new Map<string, { clientWs: WebSocket; shutdown: () => void }>();

/** Startup check: tells the operator clearly whether Supabase is ready (tables + key). */
async function checkSupabaseTables(): Promise<boolean> {
  const config = getSupabaseConfig();
  if (!config) {
    console.warn('[Supabase] Not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — saving to local data/ only.');
    return false;
  }
  const tables = [
    'candidates',
    'interview_sessions',
    'candidate_answers',
    'interview_questions',
    'customer_service_questions',
    'virtual_assistant_questions',
    'technical_support_questions',
  ];
  const missing: string[] = [];
  let authProblem = '';
  for (const table of tables) {
    try {
      const resp = await fetch(`${config.url}/rest/v1/${table}?select=id&limit=1`, {
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
      });
      if (resp.status === 401 || resp.status === 403) {
        authProblem = `HTTP ${resp.status} — check that SUPABASE_SERVICE_ROLE_KEY is the secret (service role) key`;
        break;
      }
      if (!resp.ok) missing.push(table);
    } catch (err: any) {
      authProblem = `cannot reach ${config.url}: ${err?.message || err}`;
      break;
    }
  }
  if (authProblem) {
    console.warn(`[Supabase] ${authProblem}`);
    return false;
  }
  if (missing.length) {
    console.warn(
      `[Supabase] Missing tables: ${missing.join(', ')}. Run supabase-schema.sql once in Supabase Dashboard -> SQL Editor, then restart the server.`
    );
    return false;
  }
  console.log('[Supabase] Connected — all interview tables are ready.');
  return true;
}

async function startServer() {
  // Audio frames are ~6 KB; anything much larger is not a legitimate client frame.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === '/api/live-ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (clientWs: WebSocket, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const wsToken = url.searchParams.get('token') || '';
    const isReconnect = url.searchParams.get('reconnect') === '1';
    const liveVoiceName = SINGLE_INTERVIEWER_VOICE.id; // Single NotebookLM female voice ("Aoede")
    const candidateSession = activeSessions.get(sessionId);
    // The live voice socket is only opened for the owner of an unfinished session.
    const session =
      candidateSession &&
      sessionTokenMatches(candidateSession, wsToken) &&
      candidateSession.currentPhase !== 'finished'
        ? candidateSession
        : undefined;

    const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || !session) {
      clientWs.send(
        JSON.stringify({
          type: 'fallback_required',
          reason: !apiKey ? 'GEMINI_API_KEY not configured' : 'Session not found',
        })
      );
      clientWs.close();
      return;
    }

    // Only ONE interviewer voice per interview: close any previous bridge for this session
    // (second tab, page reload, reconnect) so two Sarahs can never talk at the same time.
    liveVoiceConnections.get(session.id)?.shutdown();

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: 'v1alpha', // needed for affective dialog & proactive audio
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });

    const totalQuestions = session.questions.length || DEFAULT_QUESTION_COUNT;
    let geminiSession: any = null;
    let geminiGeneration = 0;
    let resumptionHandle: string | null = null;
    let geminiReconnects = 0;
    let stopped = false; // bridge closed (client left / replaced)
    let callEnded = false; // interview over: nothing is forwarded any more
    let endingReason: InterviewSessionRecord['liveEndReason'] | null = null;
    let rejectedEarlyEnd = false;
    let lastExpiredQuestion = 0;
    let lastAutoMisconductAt = 0;
    let interviewerTurnText = '';
    let currentQuestionNumber =
      session.currentPhase === 'questioning'
        ? Math.min(totalQuestions, (session.currentQuestionIndex || 0) + 1)
        : 0;
    const timers: NodeJS.Timeout[] = [];

    session.liveMode = true;
    if (!isReconnect && session.transcript.every((t) => t.speaker === 'interviewer')) {
      // Fresh live call: drop the text-mode greeting that was never spoken.
      session.transcript = [];
    }

    const sendToClient = (payload: unknown) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(payload));
    };

    const shutdown = () => {
      if (stopped) return;
      stopped = true;
      timers.forEach((t) => clearTimeout(t));
      try {
        geminiSession?.close();
      } catch {
        // ignore
      }
      geminiSession = null;
      try {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
      } catch {
        // ignore
      }
      if (liveVoiceConnections.get(session.id)?.clientWs === clientWs) {
        liveVoiceConnections.delete(session.id);
      }
      flushCandidatesAndSessionsToDisk();
    };
    liveVoiceConnections.set(session.id, { clientWs, shutdown });

    const secondsLeft = () => {
      const maxSeconds = session.maxDurationSeconds || 600;
      const deadline = new Date(session.createdAt).getTime() + maxSeconds * 1000;
      return Math.round((deadline - Date.now()) / 1000);
    };

    /** Server-side transcript, tagged with the question being answered. */
    const appendTranscript = (speaker: 'interviewer' | 'candidate', chunk: string) => {
      if (!chunk) return;
      const questionIndex = currentQuestionNumber > 0 ? currentQuestionNumber - 1 : undefined;
      const last = session.transcript[session.transcript.length - 1];
      if (last && last.speaker === speaker && last.questionIndex === questionIndex) {
        last.text = clampText(`${last.text}${chunk}`.replace(/\s+/g, ' '), 6000);
        if (speaker === 'candidate') recorder.linkEntry(last.id);
      } else {
        const text = chunk.replace(/\s+/g, ' ').trim();
        if (!text) return;
        const id = `tr_${Date.now()}_${speaker === 'interviewer' ? 'i' : 'c'}_${session.transcript.length}`;
        if (speaker === 'candidate') recorder.linkEntry(id);
        session.transcript.push({
          id,
          speaker,
          speakerName:
            speaker === 'interviewer' ? 'Sarah (Global Hire 360 Hiring Manager)' : session.candidateName,
          text,
          timestamp: new Date().toISOString(),
          questionIndex,
        });
        if (session.transcript.length > 600) session.transcript.splice(0, session.transcript.length - 600);
      }
    };

    // Candidate words spoken since the current question started (decides whether a re-ask
    // of the same question restarts its 90-second timer).
    let candidateWordsThisQuestion = 0;
    // The candidate's microphone audio, per turn, for the accurate post-call transcript.
    const recorder = recorderFor(session.id);
    // Off-topic answers flagged by Sarah, per question number (2 on one question ends the call).
    const offTopicCounts = new Map<number, number>();
    // Only one question detection per interviewer turn.
    let questionDetectedThisTurn = false;

    const setCurrentQuestion = (n: number) => {
      const qn = Math.max(1, Math.min(totalQuestions, Math.round(n)));
      if (qn < currentQuestionNumber) return;
      if (qn === currentQuestionNumber) {
        // Same question asked again before the candidate really started answering — e.g. it
        // was first "heard" in the introduction ("let me walk you through..."), or Sarah
        // repeated it on request. Give the candidate a full 90 seconds from now.
        if (candidateWordsThisQuestion >= ANSWER_STARTED_WORDS || lastExpiredQuestion === qn) return;
        sendToClient({ type: 'question_advanced', questionNumber: qn, totalQuestions });
        return;
      }
      currentQuestionNumber = qn;
      candidateWordsThisQuestion = 0;
      session.currentPhase = 'questioning';
      session.currentQuestionIndex = qn - 1;
      session.currentQuestionAttempts = 0;
      sendToClient({ type: 'question_advanced', questionNumber: qn, totalQuestions });
      flushCandidatesAndSessionsToDisk();
    };

    const sendSystemNote = async (text: string, respondNow: boolean) => {
      if (!geminiSession || stopped || callEnded) return;
      try {
        await geminiSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `[SYSTEM NOTE] ${text}` }] }],
          turnComplete: respondNow,
        });
      } catch (e: any) {
        console.warn('Live system note failed:', e?.message || e);
      }
    };

    let drainUntil = 0;
    const closeGeminiAfterEnd = () => {
      drainUntil = 0;
      try {
        geminiSession?.close();
      } catch {
        // ignore
      }
      geminiSession = null;
      sendToClient({ type: 'interviewer_audio_done' });
    };

    /** The interview is over: stop forwarding everything, tell the browser, close Gemini. */
    const finishCall = (reason: NonNullable<InterviewSessionRecord['liveEndReason']>) => {
      if (callEnded || stopped) return;
      callEnded = true;
      session.liveEndReason = reason;
      if (reason === 'terminated_misconduct') session.status = 'terminated_misconduct';
      timers.forEach((t) => clearTimeout(t));
      sendToClient({ type: 'end_call_triggered', reason, suspendedUntil: session.suspendedUntil });
      flushCandidatesAndSessionsToDisk();
      // Let the closing sentence that is already being spoken finish (current turn only),
      // then close Gemini so it cannot produce another word.
      drainUntil = Date.now() + 8000;
      timers.push(setTimeout(closeGeminiAfterEnd, 8000));
    };

    /** Ask Sarah to say a short closing line, and end the call ourselves if she doesn't. */
    const requestGracefulEnd = (
      reason: NonNullable<InterviewSessionRecord['liveEndReason']>,
      instruction: string,
      graceMs: number
    ) => {
      if (callEnded || endingReason) return;
      endingReason = reason;
      void sendSystemNote(instruction, true);
      timers.push(setTimeout(() => finishCall(reason), graceMs));
    };

    const terminateForMisconduct = async (reason: string) => {
      session.status = 'terminated_misconduct';
      session.misconductPenaltyPoints = (session.misconductPenaltyPoints || 0) + 5;
      session.misconductNotes = session.misconductNotes || [];
      session.misconductNotes.push(`Live voice misconduct termination: ${reason}`);
      if (!session.suspendedUntil) {
        session.suspendedUntil = await suspendCandidateFor24Hours({
          email: session.candidateEmail,
          candidateId: session.candidateId,
          reason,
        });
      }
      requestGracefulEnd(
        'terminated_misconduct',
        `The candidate used unacceptable language again. In one calm sentence, tell ${session.candidateName} that the interview is ending now because of unprofessional language and that a 24-hour suspension applies. Then call end_call with reason "terminated_misconduct". Say nothing else.`,
        9000
      );
    };

    const handleToolCalls = async (calls: any[]) => {
      for (const call of calls) {
        const respond = async (result: string) => {
          try {
            await geminiSession?.sendToolResponse({
              functionResponses: [{ id: call.id, name: call.name, response: { result } }],
            });
          } catch {
            // ignore
          }
        };

        if (call.name === 'advance_question') {
          const qNum = Number(call.args?.questionNumber) || currentQuestionNumber + 1;
          setCurrentQuestion(qNum);
          await respond(
            `Question ${Math.min(totalQuestions, qNum)} of ${totalQuestions} started. Ask it exactly as written, then wait for the answer.`
          );
        } else if (call.name === 'report_candidate_misconduct') {
          const action = String(call.args?.action || 'deduct_points_warning');
          const reason = clampText(call.args?.reason || 'Unprofessional language during live interview', 300);
          // The server's own detector may already have counted this same sentence.
          const alreadyCounted = Date.now() - lastAutoMisconductAt < 10000;
          if (!alreadyCounted) session.misconductCount = (session.misconductCount || 0) + 1;
          session.misconductNotes = session.misconductNotes || [];

          if (action === 'terminate_and_suspend_24h' || (session.misconductCount || 0) >= 2) {
            await respond('Recorded. Say one sentence that the interview is ending now, then call end_call with reason "terminated_misconduct".');
            await terminateForMisconduct(reason);
          } else {
            if (!alreadyCounted) {
              const pts = Math.max(1, Math.min(5, Number(call.args?.pointsDeducted) || 3));
              session.misconductPenaltyPoints = (session.misconductPenaltyPoints || 0) + pts;
              session.misconductNotes.push(`Warning (-${pts} pts): ${reason}`);
              sendToClient({
                type: 'misconduct_warning',
                pointsDeducted: pts,
                totalPenaltyPoints: session.misconductPenaltyPoints,
                reason,
              });
            }
            await respond(`Warning recorded. Total penalty points: ${session.misconductPenaltyPoints}. Calmly warn the candidate once, then continue the interview.`);
          }
        } else if (call.name === 'flag_off_topic_answer') {
          const qNum = Math.round(Number(call.args?.questionNumber)) || currentQuestionNumber;
          if (endingReason || qNum < 1 || qNum !== currentQuestionNumber) {
            await respond('Not recorded: that is not the question being answered now. Continue the interview normally.');
            continue;
          }
          const count = (offTopicCounts.get(qNum) || 0) + 1;
          offTopicCounts.set(qNum, count);
          const reason = clampText(call.args?.reason || 'Answer did not address the question', 200);
          session.currentQuestionAttempts = count;
          session.misconductNotes = session.misconductNotes || [];
          session.misconductNotes.push(`Off-topic answer ${count}/2 on question ${qNum}: ${reason}`);
          if (count >= 2) {
            session.liveEndReason = 'terminated_after_two_attempts';
            await respond(LIVE_NOTES.offTopicSecond(qNum));
            // Sarah says her closing words and calls end_call; end it ourselves if she doesn't.
            endingReason = 'terminated_after_two_attempts';
            timers.push(setTimeout(() => finishCall('terminated_after_two_attempts'), 25000));
          } else {
            // Second try: the rephrased question gets a fresh 90 seconds.
            candidateWordsThisQuestion = 0;
            sendToClient({ type: 'question_advanced', questionNumber: qNum, totalQuestions });
            await respond(LIVE_NOTES.offTopicFirst(qNum));
          }
        } else if (call.name === 'look_up_fact') {
          const question = clampText(call.args?.question, 300);
          // Questions are kept for the end: during the questions Sarah parks them.
          if (currentQuestionNumber < totalQuestions) {
            await respond('Not now: the interview questions are not finished. Tell the candidate kindly you will come back to it at the end, and continue the current question.');
            continue;
          }
          // Capped so the candidate is never left waiting in silence for long.
          const answer = await Promise.race([
            lookUpFact(getGenAIClientOrNull(), question),
            new Promise<string>((resolve) => setTimeout(() => resolve('UNKNOWN'), 14000)),
          ]);
          await respond(
            answer === 'UNKNOWN'
              ? 'UNKNOWN — no reliable up-to-date answer found. Say honestly that you are not sure about that one.'
              : `Answer (up to date): ${answer} Tell the candidate in one natural sentence.`
          );
        } else if (call.name === 'end_call') {
          const allowed = [
            'completed_all_questions',
            'time_up',
            'terminated_rules_violation',
            'terminated_misconduct',
          ] as const;
          const asked = String(call.args?.reason || 'completed_all_questions') as (typeof allowed)[number];
          let reason: NonNullable<InterviewSessionRecord['liveEndReason']> =
            endingReason || (allowed.includes(asked) ? asked : 'completed_all_questions');

          // Keep the interview going until all questions were asked (or time is up):
          // the model is not allowed to cut the call short by mistake.
          if (
            !endingReason &&
            reason === 'completed_all_questions' &&
            currentQuestionNumber < totalQuestions &&
            secondsLeft() > 60 &&
            !rejectedEarlyEnd
          ) {
            rejectedEarlyEnd = true;
            await respond(
              `The call cannot end yet: only ${currentQuestionNumber} of ${totalQuestions} questions have been asked. Continue the interview now with Question ${currentQuestionNumber + 1} exactly as written.`
            );
            continue;
          }
          if (reason === 'time_up' && secondsLeft() > 30) reason = 'completed_all_questions';
          // Ending for off-topic answers is only allowed once the platform counted two on a question.
          if (reason === 'terminated_after_two_attempts' && !Array.from(offTopicCounts.values()).some((c) => c >= 2)) {
            if (!rejectedEarlyEnd && currentQuestionNumber < totalQuestions) {
              rejectedEarlyEnd = true;
              await respond('The call cannot end for that reason. Continue the interview with the current question.');
              continue;
            }
            reason = 'completed_all_questions';
          }
          if (reason === 'terminated_misconduct' && !session.suspendedUntil) {
            session.suspendedUntil = await suspendCandidateFor24Hours({
              email: session.candidateEmail,
              candidateId: session.candidateId,
              reason: 'Terminated by interviewer for professional misconduct.',
            });
          }
          finishCall(reason);
          return; // nothing after end_call is processed
        }
      }
    };

    const onGeminiMessage = async (message: any) => {
      if (stopped) return;
      if (callEnded) {
        // After end_call only the rest of the closing turn (audio + caption) is passed on.
        const sc = message?.serverContent;
        if (!sc || Date.now() > drainUntil) return;
        if (sc.modelTurn || sc.outputTranscription) {
          sendToClient({ serverContent: { modelTurn: sc.modelTurn, outputTranscription: sc.outputTranscription } });
        }
        if (sc.outputTranscription?.text) appendTranscript('interviewer', sc.outputTranscription.text);
        if (sc.turnComplete || sc.interrupted) closeGeminiAfterEnd();
        return;
      }

      if (message?.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
        resumptionHandle = message.sessionResumptionUpdate.newHandle;
        return;
      }
      if (message?.goAway || message?.setupComplete) return;

      // Forward audio, interruption and transcriptions to the browser
      if (message?.serverContent || message?.toolCall) sendToClient(message);

      const serverContent = message?.serverContent;
      if (serverContent?.modelTurn || serverContent?.outputTranscription) recorder.closeTurn();
      const interviewerChunk = serverContent?.outputTranscription?.text;
      if (interviewerChunk) {
        appendTranscript('interviewer', interviewerChunk);
        interviewerTurnText += interviewerChunk;
        // The server follows the interview by itself: as soon as Sarah says the next prepared
        // question, the 90-second timer starts and the answer that follows is filed under it.
        // Look at the next question first, then one further (in case one was missed), and at
        // the current one (a re-ask before it was answered restarts its timer).
        if (!questionDetectedThisTurn) {
          for (const ahead of [0, 1, -1]) {
            const qn = currentQuestionNumber + 1 + ahead;
            const candidateQ = qn >= 1 ? session.questions[qn - 1] : undefined;
            if (candidateQ && recentSpeechAsksQuestion(interviewerTurnText, candidateQ.question)) {
              questionDetectedThisTurn = true;
              setCurrentQuestion(qn);
              break;
            }
          }
        }
      }
      if (serverContent?.turnComplete || serverContent?.interrupted) {
        interviewerTurnText = '';
        questionDetectedThisTurn = false;
      }

      const candidateChunk = serverContent?.inputTranscription?.text;
      if (candidateChunk && !endingReason) {
        appendTranscript('candidate', candidateChunk);
        candidateWordsThisQuestion += candidateChunk.split(/\s+/).filter(Boolean).length;
        const liveCheck = detectCandidateMisconduct(candidateChunk);
        if (liveCheck.isMisconduct) {
          lastAutoMisconductAt = Date.now();
          session.misconductCount = (session.misconductCount || 0) + 1;
          session.misconductNotes = session.misconductNotes || [];
          if (liveCheck.severity === 'severe' || session.misconductCount >= 2) {
            await terminateForMisconduct(liveCheck.reason);
          } else {
            session.misconductPenaltyPoints = (session.misconductPenaltyPoints || 0) + 3;
            session.misconductNotes.push(`Live voice misconduct warning (-3 pts): ${liveCheck.reason}`);
            sendToClient({
              type: 'misconduct_warning',
              pointsDeducted: 3,
              totalPenaltyPoints: session.misconductPenaltyPoints,
              reason: liveCheck.reason,
            });
            void sendSystemNote(
              'The platform detected unprofessional language and deducted 3 points. When the candidate finishes, calmly remind them in one sentence to keep the language professional, otherwise the interview will end with a 24-hour suspension. Then continue.',
              false
            );
          }
        }
      }

      const toolCalls = message?.toolCall?.functionCalls;
      if (Array.isArray(toolCalls)) await handleToolCalls(toolCalls);
    };

    // Prompt and Live settings live in interviewer-agent.ts.
    const buildLiveConfig = (): any =>
      buildLiveVoiceConfig({
        systemInstruction: buildInterviewerPrompt(session, DEFAULT_QUESTION_COUNT),
        voiceName: liveVoiceName, // NotebookLM female voice ("Aoede")
        resumptionHandle,
        functionDeclarations: [
          endCallFunctionDeclaration,
          reportMisconductFunctionDeclaration,
          flagOffTopicAnswerDeclaration,
          lookUpFactDeclaration,
        ],
        vocabulary: buildTranscriptionVocabulary(session),
      });

    // Index in LIVE_MODELS of the model in use (a resumed conversation must stay on it).
    let activeModelIndex = 0;
    // First platform note of this connection, re-sent if we have to switch model at startup.
    let openingNote = '';

    const connectGemini = async (startAt = 0): Promise<void> => {
      const generation = ++geminiGeneration;
      let gotMessage = false;
      let modelIndex = startAt;
      const callbacks = {
        onopen: () => {
          if (generation === geminiGeneration) sendToClient({ type: 'connected' });
        },
        onmessage: (message: any) => {
          if (generation !== geminiGeneration) return;
          gotMessage = true;
          onGeminiMessage(message).catch((e) => console.warn('Live message handling error:', e));
        },
        onerror: (err: any) => {
          if (generation !== geminiGeneration) return;
          console.warn('Gemini Live WebSocket error:', err?.message || err);
        },
        onclose: (event: any) => {
          if (generation !== geminiGeneration || stopped || callEnded) return;
          geminiSession = null;
          // Closed before saying anything (quota, unsupported setting...): try the next model.
          if (!gotMessage && !resumptionHandle && modelIndex + 1 < LIVE_MODELS.length) {
            console.warn(`Gemini Live model ${LIVE_MODELS[modelIndex]} closed at startup (${event?.reason || 'no reason'}); trying ${LIVE_MODELS[modelIndex + 1]}.`);
            connectGemini(modelIndex + 1)
              .then(() => (openingNote ? sendSystemNote(openingNote, true) : undefined))
              .catch(() => {
                sendToClient({ type: 'live_dropped' });
                shutdown();
              });
            return;
          }
          // Transparent resume of the same conversation when Google recycles the connection.
          if (resumptionHandle && geminiReconnects < 3) {
            geminiReconnects += 1;
            connectGemini(activeModelIndex).catch(() => {
              sendToClient({ type: 'live_dropped' });
              shutdown();
            });
            return;
          }
          sendToClient({ type: 'live_dropped' });
          shutdown();
        },
      };
      const config = buildLiveConfig();
      let connected: any;
      // Fastest model first, then the backups (see LIVE_MODELS in interviewer-agent.ts).
      let lastErr: any;
      for (; modelIndex < LIVE_MODELS.length; modelIndex++) {
        if (stopped) return;
        try {
          connected = await ai.live.connect({ model: LIVE_MODELS[modelIndex], config, callbacks });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!connected) throw lastErr || new Error('Gemini Live unavailable');
      if (stopped) {
        try {
          connected.close();
        } catch {
          // ignore
        }
        return;
      }
      activeModelIndex = modelIndex;
      geminiSession = connected;
    };

    try {
      await connectGemini();
      if (stopped) return;

      // Kick off the conversation
      const firstName = session.candidateName.split(/\s+/)[0] || session.candidateName;
      const recentContext = session.transcript
        .slice(-6)
        .map((t) => `${t.speaker === 'interviewer' ? 'You' : 'Candidate'}: ${t.text}`)
        .join('\n');
      openingNote = isReconnect
        ? `The candidate's connection dropped for a moment and they are back. ${
            currentQuestionNumber > 0
              ? `You were on question ${currentQuestionNumber}. In one short sentence say you're back, then briefly repeat question ${currentQuestionNumber} and let them continue their answer.`
              : 'In one short sentence say you are back, then continue the introduction from where you were.'
          }${recentContext ? `\nLast exchanges before the drop:\n${recentContext}` : ''}`
        : (session.resumedCount || 0) > 0 && session.currentPhase === 'questioning'
        ? `${firstName} has reconnected to the interview. In one sentence welcome them back, then ask question ${session.currentQuestionIndex + 1} with its exact wording, and listen.`
        : LIVE_NOTES.kickoff(firstName, session.isFirstTimeCandidate === false);
      await sendSystemNote(openingNote, true);
    } catch (err: any) {
      console.warn('Failed to initialize Gemini Live session, switching to fallback:', err?.message);
      sendToClient({ type: 'fallback_required', reason: err?.message || 'Live connection unavailable' });
      shutdown();
      return;
    }

    // 10-minute limit, enforced by the server (one-minute warning, then a short closing).
    const left = Math.max(30, secondsLeft());
    if (left > 75) {
      timers.push(
        setTimeout(() => {
          void sendSystemNote(
            'About one minute of interview time is left. Let the candidate finish the current answer, do not start another question, then go straight to the closing and call end_call.',
            false
          );
        }, (left - 60) * 1000)
      );
    }
    timers.push(
      setTimeout(() => {
        requestGracefulEnd(
          'time_up',
          `The 10 minutes of the interview are over. Politely tell ${session.candidateName} that the interview time is up, thank them, say their results will be sent to their email, and say goodbye, in at most two short sentences. Then call end_call with reason "time_up". Do not ask anything else.`,
          20000
        );
      }, left * 1000)
    );

    clientWs.on('message', async (raw) => {
      if (stopped || callEnded) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        if (msg?.realtimeInput) {
          // Once the call is closing, the candidate's microphone is no longer passed on.
          if (!geminiSession || endingReason) return;
          const audio = msg.realtimeInput.audio || msg.realtimeInput.mediaChunks?.[0];
          if (!audio?.data || typeof audio.data !== 'string') return;
          if (audio.data.length <= 64_000) {
            recorder.addFrame(
              Buffer.from(audio.data, 'base64'),
              currentQuestionNumber > 0 ? currentQuestionNumber - 1 : undefined
            );
          }
          await geminiSession.sendRealtimeInput({
            audio: { data: audio.data, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (msg?.type === 'timer_expired') {
          if (endingReason) return;
          const expired = Number(msg.currentQuestionIndex) + 1;
          // Ignore stale or repeated timer messages.
          if (expired !== currentQuestionNumber || expired === lastExpiredQuestion) return;
          lastExpiredQuestion = expired;
          if (expired < totalQuestions) {
            await sendSystemNote(LIVE_NOTES.questionTimeUp(expired + 1), true);
          } else {
            await sendSystemNote(LIVE_NOTES.lastQuestionTimeUp(secondsLeft() > 75), true);
          }
        } else if (msg?.type === 'request_rephrase') {
          if (endingReason || currentQuestionNumber < 1) return;
          await sendSystemNote(
            `The candidate pressed the "rephrase" button. Say Question ${currentQuestionNumber} again in simpler words with exactly the same meaning. Do not move to another question.`,
            true
          );
        }
        // Any other frame (including arbitrary text prompts) is ignored on purpose.
      } catch (e) {
        console.warn('Error forwarding client WS frame:', e);
      }
    });

    clientWs.on('close', () => shutdown());
  });

  // Bind port 3000 immediately so container health checks succeed without delay
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Global Hire 360 Server running on http://localhost:${PORT}`);
    // Automatically provision & seed Supabase tables on startup when credentials are configured
    const resendKey = (process.env.RESEND_API_KEY || '').trim();
    if (!resendKey || resendKey === 're_your_resend_api_key') {
      console.warn('[Resend] RESEND_API_KEY is not set — result emails will NOT be sent.');
    } else {
      console.log(
        `[Resend] Email delivery enabled (from: ${
          process.env.RESEND_FROM_EMAIL || process.env.RESEND_SENDER_EMAIL || 'onboarding@resend.dev'
        }).`
      );
    }
    void retryUnsentResultEmails().catch((e) => console.warn('Results email retry failed:', e?.message || e));
    provisionSupabaseTablesViaManagementApi()
      .then(() => checkSupabaseTables())
      .then((ready) => (ready ? seedCustomerServiceQuestionsToSupabase() : undefined))
      .catch(() => {});
  });

  // Load Vite middleware in development with retry in case container is still unpacking node_modules
  const distPath = path.join(process.cwd(), 'dist');
  if (process.env.NODE_ENV !== 'production') {
    let viteLoaded = false;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
          server: {
            middlewareMode: true,
            ws: { server: httpServer },
          },
          appType: 'spa',
        });

        app.use(vite.middlewares);
        viteLoaded = true;
        break;
      } catch (err: any) {
        console.warn(`Vite init attempt ${attempt}/15 waiting for node_modules:`, err?.message || err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!viteLoaded && fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

export default httpServer;
startServer();
