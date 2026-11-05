import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Type, Modality, FunctionDeclaration } from '@google/genai';
import dotenv from 'dotenv';
import mammoth from 'mammoth';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '30mb' }));

// ============================================================================
// 1. SUPABASE DATABASE CLIENT & PERSISTENCE (Direct PostgREST API)
// ============================================================================
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

  const supabaseKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();

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
  eventTag?: 'greeting' | 'question' | 'rephrase' | 'timeout' | 'termination' | 'closing' | 'answer';
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
}

export interface CandidateRecord {
  id: string;
  fullName: string;
  email: string;
  resumeFileName: string;
  extractedJobPosition: string;
  confirmedJobPosition: string;
  experienceSummary: string;
  extractedSkills: string[];
  agreedToInstructions: boolean;
  sessionsCount: number;
  latestSessionId?: string;
  latestSessionStatus?: string;
  latestScoreOutOf25?: number;
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
  status: 'in_progress' | 'completed_success' | 'completed_unsuccessful' | 'terminated_attempts';
  currentPhase: 'greeting_how_are_you' | 'questioning' | 'finished';
  currentQuestionIndex: number;
  currentQuestionAttempts: number;
  questionEvaluations: QuestionEvaluation[];
  transcript: TranscriptEntry[];
  totalScoreOutOf25: number;
  maxScore: number;
  percentageScore: number;
  successful: boolean;
  interviewerFinalImpression: string;
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

async function saveCandidateToSupabase(
  candidate: CandidateRecord
): Promise<{ saved: boolean; error?: string }> {
  const config = getSupabaseConfig();
  if (!config) {
    return {
      saved: false,
      error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY are not configured yet.',
    };
  }

  try {
    const payload = {
      id: candidate.id,
      full_name: candidate.fullName,
      email: candidate.email,
      resume_file_name: candidate.resumeFileName,
      extracted_job_position: candidate.extractedJobPosition,
      confirmed_job_position: candidate.confirmedJobPosition,
      experience_summary: candidate.experienceSummary,
      extracted_skills: candidate.extractedSkills,
      agreed_to_instructions: candidate.agreedToInstructions,
      sessions_count: candidate.sessionsCount,
      latest_session_id: candidate.latestSessionId || null,
      latest_session_status: candidate.latestSessionStatus || 'in_progress',
      latest_score_out_of_25: candidate.latestScoreOutOf25 ?? 0,
      created_at: candidate.createdAt,
      updated_at: candidate.updatedAt,
    };

    const response = await fetch(`${config.url}/rest/v1/candidates?on_conflict=email`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('Supabase candidate upsert warning:', errText);
      return { saved: false, error: errText };
    }

    return { saved: true };
  } catch (err: any) {
    console.warn('Supabase candidate save exception:', err?.message || err);
    return { saved: false, error: err?.message || 'Supabase candidate request failed' };
  }
}

async function upsertCandidateOnCheckIn(params: {
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
  const normalizedEmail = params.email.trim().toLowerCase();
  const candidateId = buildCandidateIdFromEmail(normalizedEmail);
  const nowIso = new Date().toISOString();

  // Check if candidate already exists by ID or email
  let existing = activeCandidates.get(candidateId);
  if (!existing) {
    for (const c of activeCandidates.values()) {
      if (c.email.toLowerCase() === normalizedEmail) {
        existing = c;
        break;
      }
    }
  }

  const candidate: CandidateRecord = existing
    ? {
        ...existing,
        fullName: params.fullName.trim(),
        email: normalizedEmail,
        resumeFileName: params.resumeFileName,
        extractedJobPosition: params.extractedJobPosition,
        confirmedJobPosition: params.confirmedJobPosition,
        experienceSummary: params.experienceSummary,
        extractedSkills: params.extractedSkills,
        agreedToInstructions: params.agreedToInstructions,
        sessionsCount: (existing.sessionsCount || 0) + 1,
        latestSessionId: params.sessionId,
        latestSessionStatus: 'in_progress',
        updatedAt: nowIso,
      }
    : {
        id: candidateId,
        fullName: params.fullName.trim(),
        email: normalizedEmail,
        resumeFileName: params.resumeFileName,
        extractedJobPosition: params.extractedJobPosition,
        confirmedJobPosition: params.confirmedJobPosition,
        experienceSummary: params.experienceSummary,
        extractedSkills: params.extractedSkills,
        agreedToInstructions: params.agreedToInstructions,
        sessionsCount: 1,
        latestSessionId: params.sessionId,
        latestSessionStatus: 'in_progress',
        latestScoreOutOf25: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

  activeCandidates.set(candidate.id, candidate);
  flushCandidatesAndSessionsToDisk();
  await saveCandidateToSupabase(candidate);
  return candidate;
}

async function saveSessionToSupabase(session: InterviewSessionRecord): Promise<{ saved: boolean; error?: string }> {
  // Always update linked candidate record & flush to local disk first
  const linkedCandidate = activeCandidates.get(session.candidateId);
  if (linkedCandidate) {
    linkedCandidate.latestSessionId = session.id;
    linkedCandidate.latestSessionStatus = session.status;
    linkedCandidate.latestScoreOutOf25 = session.totalScoreOutOf25;
    linkedCandidate.updatedAt = new Date().toISOString();
    activeCandidates.set(linkedCandidate.id, linkedCandidate);
  }
  activeSessions.set(session.id, session);
  flushCandidatesAndSessionsToDisk();

  const config = getSupabaseConfig();
  if (!config) {
    return {
      saved: false,
      error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY are not configured yet.',
    };
  }

  try {
    // Ensure parent candidate exists in Supabase first to satisfy foreign key constraint (interview_sessions.candidate_id -> candidates.id)
    if (linkedCandidate) {
      await saveCandidateToSupabase(linkedCandidate);
    }

    const payloadWithFk = {
      id: session.id,
      candidate_id: session.candidateId,
      candidate_name: session.candidateName,
      candidate_email: session.candidateEmail,
      resume_file_name: session.resumeFileName,
      job_position: session.detectedRole,
      experience_summary: session.candidateExperienceSummary,
      key_skills: session.keySkills,
      status: session.status,
      total_score: session.totalScoreOutOf25,
      max_score: session.maxScore,
      percentage_score: session.percentageScore,
      successful: session.successful,
      final_impression: session.interviewerFinalImpression,
      question_evaluations: session.questionEvaluations,
      transcript: session.transcript,
      created_at: session.createdAt,
      completed_at: session.completedAt || new Date().toISOString(),
    };

    let response = await fetch(`${config.url}/rest/v1/interview_sessions?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payloadWithFk),
    });

    // Fallback if remote interview_sessions table hasn't added candidate_id column yet
    if (!response.ok) {
      const errText = await response.text();
      if (/candidate_id/i.test(errText)) {
        const { candidate_id: _omit, ...payloadWithoutFk } = payloadWithFk;
        response = await fetch(`${config.url}/rest/v1/interview_sessions?on_conflict=id`, {
          method: 'POST',
          headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(payloadWithoutFk),
        });
      } else {
        console.warn('Supabase upsert warning (check if interview_sessions table exists):', errText);
        return { saved: false, error: errText };
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      return { saved: false, error: errText };
    }

    return { saved: true };
  } catch (err: any) {
    console.warn('Supabase save exception:', err?.message || err);
    return { saved: false, error: err?.message || 'Supabase request failed' };
  }
}

// ============================================================================
// 2. BREVO TRANSACTIONAL EMAIL INTEGRATION
// ============================================================================
async function sendBrevoAssessmentEmail(session: InterviewSessionRecord): Promise<{ sent: boolean; note: string }> {
  const brevoApiKey = process.env.BREVO_API_KEY?.trim();
  const senderEmail = process.env.BREVO_SENDER_EMAIL?.trim() || 'interviews@globalhire360.com';
  const senderName = process.env.BREVO_SENDER_NAME?.trim() || 'Global Hire 360 Interview Coach';

  const transcriptHtml = session.transcript
    .map(
      (t) => `
      <div style="margin-bottom: 12px; padding: 12px 14px; border-radius: 8px; background: ${
        t.speaker === 'interviewer' ? '#F0F4F8' : '#F2F9EE'
      }; border-left: 4px solid ${t.speaker === 'interviewer' ? '#041E41' : '#339A05'};">
        <div style="font-size: 12px; font-weight: 700; color: ${
          t.speaker === 'interviewer' ? '#041E41' : '#339A05'
        }; margin-bottom: 4px;">
          ${t.speakerName} &bull; <span style="font-weight: 400; color: #64748B;">${new Date(
        t.timestamp
      ).toLocaleTimeString()}</span>
        </div>
        <div style="font-size: 14px; color: #1E293B; line-height: 1.55;">${t.text}</div>
      </div>`
    )
    .join('');

  const questionsHtml = session.questionEvaluations
    .map(
      (q) => `
      <div style="margin-bottom: 14px; padding: 14px; border: 1px solid #E2E8F0; border-radius: 8px; background: #FFFFFF;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <strong style="color: #041E41; font-size: 14px;">Question ${q.questionNumber} (${q.category})</strong>
          <span style="background: ${
            q.scoreOutOf5 >= 3.5 ? '#339A05' : '#041E41'
          }; color: #FFFFFF; padding: 3px 10px; border-radius: 4px; font-size: 12px; font-weight: 700;">
            ${q.scoreOutOf5} / 5
          </span>
        </div>
        <p style="margin: 0 0 8px 0; font-size: 13px; color: #334155; font-weight: 600;">${q.questionText}</p>
        <p style="margin: 0 0 6px 0; font-size: 12px; color: #475569;"><strong>Your Answer:</strong> ${
          q.candidateAnswer || 'No response recorded'
        }</p>
        <p style="margin: 0; font-size: 12px; color: #041E41;"><strong>Coach Feedback:</strong> ${q.feedback}</p>
      </div>`
    )
    .join('');

  const htmlContent = `
    <div style="font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif; max-width: 680px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 12px; overflow: hidden; background: #FFFFFF;">
      <div style="background: #041E41; color: #FFFFFF; padding: 24px 28px; border-bottom: 4px solid #339A05;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 800;">Global Hire 360 — Live Interview Assessment</h1>
        <p style="margin: 6px 0 0 0; font-size: 13px; color: #CBD5E1;">Candidate Performance Report &amp; Full Voice Transcript</p>
      </div>
      <div style="padding: 28px;">
        <p style="font-size: 15px; color: #1E293B; margin-top: 0;">Hello <strong>${session.candidateName}</strong>,</p>
        <p style="font-size: 14px; color: #475569; line-height: 1.6;">
          Thank you for completing your live voice interview on the <strong>Global Hire 360</strong> platform for the <strong>${session.detectedRole}</strong> position. Below is your official evaluation summary and voice transcript.
        </p>
        <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px; padding: 18px; margin: 20px 0;">
          <div style="font-size: 13px; color: #64748B; text-transform: uppercase; font-weight: 700;">Overall Verdict</div>
          <div style="font-size: 22px; font-weight: 800; color: ${
            session.successful ? '#339A05' : '#D97706'
          }; margin: 4px 0;">
            ${session.successful ? 'SUCCESSFUL — READY FOR PLACEMENT' : 'NEEDS FURTHER WORKSHOP PRACTICE'} (${
    session.totalScoreOutOf25
  } / ${session.maxScore})
          </div>
          <p style="font-size: 13px; color: #334155; margin: 8px 0 0 0; line-height: 1.55;">
            <strong>Interviewer Final Impression:</strong> ${session.interviewerFinalImpression}
          </p>
        </div>
        <h3 style="color: #041E41; font-size: 16px; border-bottom: 2px solid #E2E8F0; padding-bottom: 8px;">Question-by-Question Scores (/ 5)</h3>
        ${questionsHtml}
        <h3 style="color: #041E41; font-size: 16px; border-bottom: 2px solid #E2E8F0; padding-bottom: 8px; margin-top: 26px;">Full Voice Call Transcript</h3>
        ${transcriptHtml}
      </div>
    </div>
  `;

  if (!brevoApiKey || brevoApiKey === 'xkeysib-your-brevo-api-key') {
    return {
      sent: false,
      note: `Report prepared for ${session.candidateEmail} (Add BREVO_API_KEY in Secrets to enable live Brevo email delivery).`,
    };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          name: senderName,
          email: senderEmail,
        },
        to: [
          {
            email: session.candidateEmail,
            name: session.candidateName,
          },
        ],
        subject: `Global Hire 360 Interview Results: ${session.candidateName} (${session.detectedRole}) — ${session.totalScoreOutOf25}/25`,
        htmlContent,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.warn('Brevo API non-200 response:', response.status, errBody);
      return {
        sent: false,
        note: `Brevo API returned status ${response.status}. Please verify BREVO_API_KEY and verified BREVO_SENDER_EMAIL.`,
      };
    }

    return {
      sent: true,
      note: `Assessment report & transcript emailed to ${session.candidateEmail} via Brevo.`,
    };
  } catch (err: any) {
    console.error('Brevo email error:', err);
    return {
      sent: false,
      note: `Could not reach Brevo API: ${err?.message || 'Unknown error'}`,
    };
  }
}

// ============================================================================
// 3. GEMINI CLIENT HELPER
// ============================================================================
function getGenAIClientOrNull(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({ apiKey });
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
  const config = getSupabaseConfig();
  if (!config) {
    return {
      seeded: false,
      error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are not configured.',
    };
  }

  try {
    const payload = CUSTOMER_SERVICE_QUESTION_TABLE.map((row) => ({
      id: row.id,
      role_category: row.roleCategory,
      category: row.category,
      question_text: row.question,
      proposed_answer: row.proposedAnswer,
      expected_focus: row.expectedFocus,
      is_behavioral_star: row.isBehavioralStar,
    }));

    const response = await fetch(
      `${config.url}/rest/v1/customer_service_questions?on_conflict=id`,
      {
        method: 'POST',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return { seeded: false, error: errText };
    }
    return { seeded: true };
  } catch (err: any) {
    return { seeded: false, error: err?.message || 'Failed to seed customer_service_questions' };
  }
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

  // Look up the Customer Service table row if this question belongs to the CS Marking Guide
  const csRow =
    CUSTOMER_SERVICE_QUESTION_TABLE.find(
      (r) =>
        r.id === questionId ||
        r.question.toLowerCase().trim() === (questionText || '').toLowerCase().trim()
    ) || null;

  const refAnswer = proposedAnswer || csRow?.proposedAnswer || '';

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

  // 3. Evaluate Marking Guide Pillars (if defined on the CS question row)
  const matchedPillars: string[] = [];
  const missingTips: string[] = [];

  if (csRow && csRow.markingPillars.length > 0) {
    for (const pillar of csRow.markingPillars) {
      if (pillar.regex.test(clean)) {
        matchedPillars.push(pillar.label);
      } else {
        missingTips.push(pillar.tip);
      }
    }
  }

  // Check general customer-service & professional sense signals
  const hasProfessionalSense =
    /\b(?:customer(?:s)?|client(?:s)?|people|team|help(?:ed|ing)?|support(?:ed|ing)?|communicat(?:e|ed|ing|ion)|listen(?:ed|ing)?|solv(?:e|ed|ing)|solution(?:s)?|issue(?:s)?|problem(?:s)?|patient|patience|calm|polic(?:y|ies)|procedure(?:s)?|priorit(?:y|ize|ized|izing)|organiz(?:e|ed|ing)|accura(?:te|cy)|mistake|apologiz(?:e|ed)|follow(?:ed)?\s+up|resolv(?:e|ed|ing)|experience|work(?:ed|ing)?)\b/i.test(
      clean
    );

  // If the answer has 0 matched pillars, 0 shared stems with the marking guide, and no professional/CS sense at all, it is off-topic!
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

  if (csRow) {
    const pillarCount = matchedPillars.length; // 0 to 4
    // Base score from semantic marking pillars:
    // 4 pillars -> 4.5, 3 pillars -> 3.8, 2 pillars -> 3.0, 1 pillar -> 2.3, 0 pillars (but on-topic) -> 2.0
    if (pillarCount === 4) rawScore = 4.6;
    else if (pillarCount === 3) rawScore = 3.9;
    else if (pillarCount === 2) rawScore = 3.1;
    else if (pillarCount === 1) rawScore = 2.4;
    else rawScore = 2.0;

    // Bonus for semantic concept overlap with the proposed answer (+0 to +0.5)
    const overlapBonus = Math.min(0.5, sharedStemCount * 0.08);
    rawScore += overlapBonus;

    // For behavioral STAR questions (Q6-Q10), reward clear action + result explanation
    if (csRow.isBehavioralStar) {
      const hasActionAndResult =
        /\b(?:listened|checked|explained|organized|verified|acknowledged|contacted|gathered|followed|resolved|accepted|completed|satisfied)\b/i.test(
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
    // Non-CS role fallback scoring based on expectedFocus & depth
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

  // For ANY Customer Service or Customer Support role, draw 5 shuffled questions from the 10-question Customer Service table
  if (isCustomerServiceOrSupportRole(role)) {
    return selectShuffledCustomerServiceQuestions(5);
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

        const finalQuestions = isCustomerServiceOrSupportRole(finalRole)
          ? selectShuffledCustomerServiceQuestions(5)
          : Array.isArray(parsed.questions) && parsed.questions.length >= 5
          ? parsed.questions.slice(0, 5).map((q: any, idx: number) => ({
              id: `q${idx + 1}`,
              number: idx + 1,
              category: q.category || `Competency ${idx + 1}`,
              question: q.question,
              expectedFocus:
                q.expectedFocus || 'Clear, structured STAR response with measurable results.',
            }))
          : buildTailoredQuestionsForRole(finalRole, finalSkills);

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

// 5.0 Customer Service Questions & Marking Guide Table Endpoint
app.get('/api/customer-service-questions', async (_req, res) => {
  await seedCustomerServiceQuestionsToSupabase();
  return res.json({
    role: 'Customer Service / Customer Support',
    maxSessionDurationMinutes: 10,
    questionsPerSession: 5,
    selectionMode: 'shuffled_non_chronological',
    totalQuestionsInTable: CUSTOMER_SERVICE_QUESTION_TABLE.length,
    questions: CUSTOMER_SERVICE_QUESTION_TABLE.map((q) => ({
      id: q.id,
      roleCategory: q.roleCategory,
      category: q.category,
      question: q.question,
      proposedAnswer: q.proposedAnswer,
      expectedFocus: q.expectedFocus,
      isBehavioralStar: q.isBehavioralStar,
    })),
  });
});

// 5a. Examine Resume endpoint (called immediately when candidate selects resume on Homepage)
app.post('/api/examine-resume', async (req, res) => {
  try {
    const { resumeFileName, resumeMimeType, resumeBase64 } = req.body;
    if (!resumeBase64) {
      return res.status(400).json({ error: 'Resume file data is required.' });
    }
    const result = await examineResumeForJobPosition({
      resumeFileName: resumeFileName || 'resume.pdf',
      resumeMimeType: resumeMimeType || 'application/pdf',
      resumeBase64,
    });
    return res.json(result);
  } catch (err: any) {
    if (err instanceof ResumeValidationError || err?.isRejectedDocument) {
      return res.status(422).json({
        error: err.message,
        isRejectedDocument: true,
      });
    }
    console.error('Error in /api/examine-resume:', err);
    return res.status(500).json({ error: err?.message || 'Failed to examine resume.' });
  }
});

// 5b. Start Interview Session endpoint
app.post('/api/start-interview-session', async (req, res) => {
  try {
    const {
      candidateName,
      candidateEmail,
      resumeFileName,
      resumeMimeType,
      resumeBase64,
      confirmedJobPosition,
      agreedToInstructions,
      preExaminedData,
    } = req.body;

    if (!candidateName || !candidateEmail || !resumeBase64) {
      return res.status(400).json({
        error: 'Name, Email, and Resume (.pdf or .docx) are all required fields.',
      });
    }

    let examined: ResumeExaminationResult;
    if (
      preExaminedData &&
      preExaminedData.detectedRole &&
      Array.isArray(preExaminedData.questions) &&
      preExaminedData.questions.length === 5
    ) {
      examined = {
        ...preExaminedData,
        questions: [...preExaminedData.questions],
      };
    } else {
      examined = await examineResumeForJobPosition({
        resumeFileName: resumeFileName || 'resume.pdf',
        resumeMimeType: resumeMimeType || 'application/pdf',
        resumeBase64,
      });
    }

    const extractedRoleFromResume = examined.detectedRole;
    // If the candidate confirmed or refined their exact job title on the form, honor it and tailor questions if changed
    const finalRole = (confirmedJobPosition || examined.detectedRole).trim();
    examined.detectedRole = finalRole;

    // For ANY Customer Service or Customer Support role, ALWAYS freshly query & shuffle 5 questions from the 10-question Customer Service table in Supabase!
    if (isCustomerServiceOrSupportRole(finalRole)) {
      examined.questions = await fetchShuffledCustomerServiceQuestionsFromSupabase(5);
    } else if (finalRole.toLowerCase() !== (preExaminedData?.detectedRole || '').toLowerCase()) {
      examined.questions = buildTailoredQuestionsForRole(finalRole, examined.keySkills);
    }

    const sessionId = `gh360_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // 1. Track the candidate in public.candidates (creates or updates the candidate row & increments sessions_count)
    const candidateRecord = await upsertCandidateOnCheckIn({
      fullName: candidateName.trim(),
      email: candidateEmail.trim(),
      resumeFileName: resumeFileName || 'resume.pdf',
      extractedJobPosition: extractedRoleFromResume,
      confirmedJobPosition: finalRole,
      experienceSummary: examined.candidateExperienceSummary,
      extractedSkills: examined.keySkills,
      agreedToInstructions: agreedToInstructions !== false,
      sessionId,
    });

    const greetingText = `Hello ${candidateName}! Welcome to the Global Hire 360 live interview room. I have reviewed your resume for the ${examined.detectedRole} position. Before we dive into our five interview questions, how are you doing today?`;

    // 2. Create the interview session linked to candidateRecord.id via candidateId foreign key
    const newSession: InterviewSessionRecord = {
      id: sessionId,
      candidateId: candidateRecord.id,
      createdAt: new Date().toISOString(),
      maxDurationSeconds: 600, // 10 minutes max session duration
      candidateName: candidateName.trim(),
      candidateEmail: candidateEmail.trim().toLowerCase(),
      resumeFileName: resumeFileName || 'resume.pdf',
      detectedRole: examined.detectedRole,
      candidateExperienceSummary: examined.candidateExperienceSummary,
      keySkills: examined.keySkills,
      questions: examined.questions,
      status: 'in_progress',
      currentPhase: 'greeting_how_are_you',
      currentQuestionIndex: 0,
      currentQuestionAttempts: 0,
      questionEvaluations: [],
      transcript: [
        {
          id: `tr_${Date.now()}`,
          speaker: 'interviewer',
          speakerName: 'Global Hire 360 AI Interviewer',
          text: greetingText,
          timestamp: new Date().toISOString(),
          eventTag: 'greeting',
        },
      ],
      totalScoreOutOf25: 0,
      maxScore: 25,
      percentageScore: 0,
      successful: false,
      interviewerFinalImpression: '',
      emailSent: false,
    };

    activeSessions.set(sessionId, newSession);
    // Persist initial session record (and parent candidate relation) to Supabase & disk
    const supRes = await saveSessionToSupabase(newSession);
    newSession.supabaseSaved = supRes.saved;

    return res.json({
      candidate: candidateRecord,
      session: newSession,
      interviewerMessage: greetingText,
      liveWsAvailable: Boolean(getGenAIClientOrNull()),
    });
  } catch (err: any) {
    if (err instanceof ResumeValidationError || err?.isRejectedDocument) {
      return res.status(422).json({
        error: err.message,
        isRejectedDocument: true,
      });
    }
    console.error('Error in /api/start-interview-session:', err);
    return res.status(500).json({ error: err?.message || 'Failed to start interview session.' });
  }
});

// 5c. Interactive Turn Handler (Supports conversational turns, 90s question timeout, 10m session timeout, rephrase, 2-attempt rule, and Marking Guide grading)
app.post('/api/interview-turn', async (req, res) => {
  try {
    const { sessionId, candidateText, timedOut, sessionTimedOut, requestedRephrase } = req.body;
    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found.' });
    }

    const nowIso = new Date().toISOString();
    const cleanText = (candidateText || '').trim();

    // Record candidate utterance into transcript
    if (cleanText || timedOut || sessionTimedOut || requestedRephrase) {
      session.transcript.push({
        id: `tr_${Date.now()}_c`,
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

    // If the 10-minute overall session timer expired, evaluate any partial response on the active question and conclude the session
    if (sessionTimedOut) {
      if (session.currentPhase === 'questioning') {
        const activeQ = session.questions[session.currentQuestionIndex];
        if (activeQ && cleanText.length > 0) {
          const mgEval = evaluateCandidateResponseWithMarkingGuide({
            questionId: activeQ.id,
            questionText: activeQ.question,
            category: activeQ.category,
            expectedFocus: activeQ.expectedFocus,
            proposedAnswer: activeQ.proposedAnswer,
            candidateText: cleanText,
            role: session.detectedRole,
          });
          session.questionEvaluations.push({
            questionId: activeQ.id,
            questionNumber: activeQ.number,
            category: activeQ.category,
            questionText: activeQ.question,
            proposedAnswer: activeQ.proposedAnswer,
            candidateAnswer: cleanText,
            attemptsUsed: session.currentQuestionAttempts + 1,
            timedOut: true,
            scoreOutOf5: mgEval.isOnTopic ? mgEval.scoreOutOf5 : 1,
            feedback: mgEval.feedback,
            strengths: mgEval.strengths,
            improvementTip: mgEval.improvementTip,
          });
        }
      }
      return await concludeAndFinalizeSession(session, res, false);
    }

    // PHASE 1: Candidate responds to initial greeting ("How are you doing today?")
    if (session.currentPhase === 'greeting_how_are_you') {
      session.currentPhase = 'questioning';
      session.currentQuestionIndex = 0;
      session.currentQuestionAttempts = 0;
      const firstQ = session.questions[0];

      const reply = `That's wonderful to hear, ${session.candidateName}! Let's get started with your interview for the ${session.detectedRole} position. Remember, our interview session is up to 10 minutes maximum, and you have 90 seconds for each of the 5 questions. Here is Question 1 of 5: ${firstQ.question}`;

      session.transcript.push({
        id: `tr_${Date.now()}_i`,
        speaker: 'interviewer',
        speakerName: 'Global Hire 360 AI Interviewer',
        text: reply,
        timestamp: new Date().toISOString(),
        questionIndex: 0,
        eventTag: 'question',
      });

      return res.json({
        session,
        interviewerMessage: reply,
        resetQuestionTimer: true,
        interviewEnded: false,
      });
    }

    const currentQ = session.questions[session.currentQuestionIndex];
    if (!currentQ) {
      return res.json({ session, interviewerMessage: 'The interview is complete.', interviewEnded: true });
    }

    // CASE A: Candidate explicitly asks to rephrase the question
    if (
      requestedRephrase ||
      /\b(rephrase|repeat\s+the\s+question|say\s+that\s+again|didn'?t\s+understand\s+the\s+question|clarify\s+the\s+question)\b/i.test(
        cleanText
      )
    ) {
      let rephrasedText = `Of course, ${session.candidateName}! Let me put Question ${currentQ.number} another way: Focusing on ${currentQ.category.toLowerCase()}, think about ${currentQ.expectedFocus.toLowerCase()}. How would you approach or describe that in your own words? Take your time—your 90-second timer is refreshed.`;

      const ai = getGenAIClientOrNull();
      if (ai) {
        try {
          const resp = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `You are the warm, encouraging African American female Global Hire 360 Interview Coach.
The candidate (${session.candidateName}, applying for ${session.detectedRole}) asked you to rephrase Question ${currentQ.number}: "${currentQ.question}".
Rephrase this question clearly, warmly, and simply in 2-3 sentences so they understand what key points (${currentQ.expectedFocus}) to share without giving away the answer.`,
          });
          if (resp.text) rephrasedText = resp.text.trim();
        } catch {
          // use default rephrasedText
        }
      }

      session.transcript.push({
        id: `tr_${Date.now()}_i`,
        speaker: 'interviewer',
        speakerName: 'Global Hire 360 AI Interviewer',
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
          ? evaluateCandidateResponseWithMarkingGuide({
              questionId: currentQ.id,
              questionText: currentQ.question,
              category: currentQ.category,
              expectedFocus: currentQ.expectedFocus,
              proposedAnswer: currentQ.proposedAnswer,
              candidateText: cleanText,
              role: session.detectedRole,
            })
          : null;

      const partialScore = partialEval
        ? Math.min(3.5, partialEval.scoreOutOf5)
        : 0;

      session.questionEvaluations.push({
        questionId: currentQ.id,
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
      });

      // Advance to next question or finish
      if (session.currentQuestionIndex < session.questions.length - 1) {
        session.currentQuestionIndex += 1;
        session.currentQuestionAttempts = 0;
        const nextQ = session.questions[session.currentQuestionIndex];
        const timeoutMsg = `I have to gently step in there, ${session.candidateName}, as our 90-second timer for Question ${currentQ.number} is up! Let's keep our momentum going and move straight to Question ${nextQ.number} of 5: ${nextQ.question}`;

        session.transcript.push({
          id: `tr_${Date.now()}_i`,
          speaker: 'interviewer',
          speakerName: 'Global Hire 360 AI Interviewer',
          text: timeoutMsg,
          timestamp: new Date().toISOString(),
          questionIndex: session.currentQuestionIndex,
          eventTag: 'timeout',
        });

        return res.json({
          session,
          interviewerMessage: timeoutMsg,
          resetQuestionTimer: true,
          interviewEnded: false,
        });
      } else {
        // That was the final question (Q5)
        return await concludeAndFinalizeSession(session, res);
      }
    }

    // CASE C: Evaluate Candidate's Spoken Answer Against the Proposed Marking Guide Answer!
    session.currentQuestionAttempts += 1;

    const markingGuideEval = evaluateCandidateResponseWithMarkingGuide({
      questionId: currentQ.id,
      questionText: currentQ.question,
      category: currentQ.category,
      expectedFocus: currentQ.expectedFocus,
      proposedAnswer: currentQ.proposedAnswer,
      candidateText: cleanText,
      role: session.detectedRole,
    });

    let isOnTopic = markingGuideEval.isOnTopic;
    let scoreOutOf5 = markingGuideEval.scoreOutOf5;
    let feedback = markingGuideEval.feedback;
    let strengths = markingGuideEval.strengths;
    let improvementTip = markingGuideEval.improvementTip;
    let coachingRephraseMessage = '';

    const ai = getGenAIClientOrNull();
    if (ai) {
      try {
        const evalResp = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `You are the Global Hire 360 Senior Interview Evaluator & Coach (warm, professional African American female persona).
Candidate: ${session.candidateName}
Target Job Position: ${session.detectedRole}
Question ${currentQ.number} (${currentQ.category}): "${currentQ.question}"
Proposed Marking Guide Answer: "${currentQ.proposedAnswer || currentQ.expectedFocus}"
Expected Key Focus: "${currentQ.expectedFocus}"
Attempt Number on this question: ${session.currentQuestionAttempts} of 2
Candidate's Spoken Response: "${cleanText}"

MARKING GUIDE SCORING PROTOCOL:
- The candidate does NOT need to repeat the Proposed Marking Guide Answer word-for-word.
- Evaluate whether the candidate's response makes sense and aligns in meaning and reasoning with the Proposed Marking Guide Answer.
- Score on a 0 to 5 scale (increments of 0.5 allowed):
  * 0 - 1.0: Off-topic, refusal ("I don't know"), or under 6 meaningful words (set isOnTopic = false).
  * 2.0 - 2.5: Makes basic sense and is on-topic, but only touches on a small part of the marking guide.
  * 3.0 - 3.5: Good, sensible answer that covers about half of the core ideas in the proposed answer.
  * 4.0 - 4.5: Strong answer that aligns well with most of the proposed marking guide answer.
  * 5.0: Excellent, well-structured answer that captures the full essence and key points of the proposed marking guide answer.
- If isOnTopic is false and this is Attempt 1, write a warm, motivating intervention (coachingRephraseMessage) that gently stops them, encourages them, and rephrases Question ${currentQ.number} in simpler terms so they can try one more time.`,
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
          scoreOutOf5 = Math.max(0, Math.min(5, Math.round(parsedEval.scoreOutOf5 * 2) / 2));
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

    // 2-ATTEMPT RULE ENFORCEMENT WHEN OFF-TOPIC:
    if (!isOnTopic) {
      if (session.currentQuestionAttempts === 1) {
        // Attempt 1 failed -> Motivate and rephrase the question for Attempt 2
        const rephraseMsg =
          coachingRephraseMessage ||
          `Hold on just a second, ${session.candidateName}—I know interviews can feel intense, and you are doing great! Let me help you refocus on what Question ${currentQ.number} ("${currentQ.question}") is looking for: think about ${currentQ.expectedFocus.toLowerCase()}. Let's reset your 90-second timer and give this question one more try!`;

        session.transcript.push({
          id: `tr_${Date.now()}_i`,
          speaker: 'interviewer',
          speakerName: 'Global Hire 360 AI Interviewer',
          text: rephraseMsg,
          timestamp: new Date().toISOString(),
          questionIndex: session.currentQuestionIndex,
          eventTag: 'rephrase',
        });

        return res.json({
          session,
          interviewerMessage: rephraseMsg,
          resetQuestionTimer: true,
          interviewEnded: false,
        });
      } else {
        // Attempt 2 ALSO off-topic -> Record 1/5 for this question, give warm encouraging words to practice further, and end the call!
        session.questionEvaluations.push({
          questionId: currentQ.id,
          questionNumber: currentQ.number,
          category: currentQ.category,
          questionText: currentQ.question,
          proposedAnswer: currentQ.proposedAnswer,
          candidateAnswer: cleanText,
          attemptsUsed: 2,
          timedOut: false,
          scoreOutOf5: 1,
          feedback:
            'After two attempts and a rephrased prompt, the response remained off-topic or did not align with the marking guide criteria.',
          strengths: ['Participated in the live coaching session'],
          improvementTip:
            currentQ.expectedFocus ||
            'Review the Global Hire 360 Candidate Workshop and practice structuring clear answers before your next live session.',
        });

        session.status = 'terminated_attempts';
        return await concludeAndFinalizeSession(session, res, true);
      }
    }

    // Candidate's answer is ON-TOPIC -> Record score out of 5 and move to next question (or finish)
    session.questionEvaluations.push({
      questionId: currentQ.id,
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
    });

    session.totalScoreOutOf25 = Number(
      session.questionEvaluations.reduce((sum, q) => sum + q.scoreOutOf5, 0).toFixed(1)
    );
    session.percentageScore = Math.round((session.totalScoreOutOf25 / 25) * 100);

    if (session.currentQuestionIndex < session.questions.length - 1) {
      session.currentQuestionIndex += 1;
      session.currentQuestionAttempts = 0;
      const nextQ = session.questions[session.currentQuestionIndex];

      const nextMsg = `Thank you for sharing that, ${session.candidateName}. Let's move on to Question ${nextQ.number} of 5 (${nextQ.category}): ${nextQ.question}`;

      session.transcript.push({
        id: `tr_${Date.now()}_i`,
        speaker: 'interviewer',
        speakerName: 'Global Hire 360 AI Interviewer',
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
      // Completed all 5 questions!
      return await concludeAndFinalizeSession(session, res, false);
    }
  } catch (err: any) {
    console.error('Error in /api/interview-turn:', err);
    return res.status(500).json({ error: err?.message || 'Error processing interview turn.' });
  }
});

// 5d. Finalize Session (Called either at the end of 5 questions, after 2-attempt termination, or when Live WebSocket call ends)
async function concludeAndFinalizeSession(
  session: InterviewSessionRecord,
  res: express.Response,
  terminatedEarlyForAttempts = false
) {
  // Fill any unreached questions with 0/5 so all 5 questions appear on the /scoring page
  for (let i = 0; i < session.questions.length; i++) {
    const q = session.questions[i];
    const existing = session.questionEvaluations.find((ev) => ev.questionNumber === q.number);
    if (!existing) {
      session.questionEvaluations.push({
        questionId: q.id,
        questionNumber: q.number,
        category: q.category,
        questionText: q.question,
        proposedAnswer: q.proposedAnswer,
        candidateAnswer: terminatedEarlyForAttempts
          ? '[Not reached — Session concluded early for additional workshop practice]'
          : '[Not answered]',
        attemptsUsed: 0,
        timedOut: false,
        scoreOutOf5: 0,
        feedback: terminatedEarlyForAttempts
          ? 'This question was not reached because the interview concluded after two unsuccessful attempts on an earlier question.'
          : 'No response was recorded for this question.',
        strengths: [],
        improvementTip: `Key marking guide focus: ${q.expectedFocus}`,
      });
    }
  }

  session.questionEvaluations.sort((a, b) => a.questionNumber - b.questionNumber);

  const totalScore = Number(
    session.questionEvaluations.reduce((sum, q) => sum + q.scoreOutOf5, 0).toFixed(1)
  );
  session.totalScoreOutOf25 = totalScore;
  session.maxScore = 25;
  session.percentageScore = Math.round((totalScore / 25) * 100);
  session.successful = !terminatedEarlyForAttempts && totalScore >= 16;
  session.currentPhase = 'finished';
  session.completedAt = new Date().toISOString();

  if (terminatedEarlyForAttempts) {
    session.status = 'terminated_attempts';
    session.interviewerFinalImpression = `${session.candidateName}, thank you for stepping into the Global Hire 360 interview room today. Since we tried Question ${
      session.currentQuestionIndex + 1
    } twice and still didn't quite hit the specific ${
      session.detectedRole
    } examples needed, I am going to wrap up our live call here so you were not successful on this attempt. Please don't be discouraged—you have strong potential! Review your scorecard and marking guide sent to ${
      session.candidateEmail
    }, practice structuring your answers with the Global Hire 360 Interview Helper, and come back stronger!`;
  } else if (session.successful) {
    session.status = 'completed_success';
    session.interviewerFinalImpression = `Congratulations, ${session.candidateName}! You completed all five questions for the ${session.detectedRole} position with an impressive score of ${totalScore} out of 25 (${session.percentageScore}%). Your responses made strong sense and aligned well with our Global Hire 360 marking guide—you were successful in this interview assessment! I have sent your full scorecard and voice transcript to ${session.candidateEmail}.`;
  } else {
    session.status = 'completed_unsuccessful';
    session.interviewerFinalImpression = `Thank you for completing all five questions for the ${session.detectedRole} position, ${session.candidateName}. You achieved ${totalScore} out of 25 (${session.percentageScore}%), which is below our 16/25 placement benchmark, so you were not yet successful on this attempt. Keep your head up—I've emailed your detailed question breakdown, marking guide tips, and full transcript to ${session.candidateEmail} so you can refine your answers and succeed on your next session!`;
  }

  session.transcript.push({
    id: `tr_${Date.now()}_final`,
    speaker: 'interviewer',
    speakerName: 'Global Hire 360 AI Interviewer',
    text: session.interviewerFinalImpression,
    timestamp: new Date().toISOString(),
    eventTag: terminatedEarlyForAttempts ? 'termination' : 'closing',
  });

  // Save to Supabase & send Brevo Email
  const [supabaseRes, brevoRes] = await Promise.all([
    saveSessionToSupabase(session),
    sendBrevoAssessmentEmail(session),
  ]);

  session.supabaseSaved = supabaseRes.saved;
  session.emailSent = brevoRes.sent;
  session.emailDeliveryNote = brevoRes.note;

  return res.json({
    session,
    interviewerMessage: session.interviewerFinalImpression,
    resetQuestionTimer: false,
    interviewEnded: true,
  });
}

// 5e. Finalize Live WebSocket Call Transcript endpoint (Grades a full LUNA-style Gemini Live WebSocket transcript against the Marking Guide)
app.post('/api/finalize-live-ws-session', async (req, res) => {
  try {
    const { sessionId, liveTranscript, terminatedByAttemptRule } = req.body;
    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found.' });
    }

    if (Array.isArray(liveTranscript) && liveTranscript.length > 0) {
      session.transcript = liveTranscript;
    }

    const ai = getGenAIClientOrNull();
    if (ai && session.transcript.length > 1) {
      try {
        const transcriptFormatted = session.transcript
          .map((t) => `[${t.speaker.toUpperCase()}]: ${t.text}`)
          .join('\n');

        const questionsFormatted = session.questions
          .map(
            (q) =>
              `Q${q.number} (${q.category}): ${q.question}\n  - Proposed Marking Guide Answer: ${
                q.proposedAnswer || q.expectedFocus
              }\n  - Expected Focus: ${q.expectedFocus}`
          )
          .join('\n\n');

        const gradeResp = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `You are the Senior Assessment Grader for Global Hire 360.
Candidate: ${session.candidateName}
Job Position: ${session.detectedRole}

Assigned 5 Interview Questions & Official Marking Guide Answers:
${questionsFormatted}

Full Live Voice Interview Transcript:
${transcriptFormatted}

Grade each of the 5 questions out of 5 points (0 to 5, increments of 0.5 allowed) based on how well the candidate's spoken answer in the transcript makes sense and aligns with the Proposed Marking Guide Answer (word-for-word match is NOT required, judge whether the candidate's meaning and examples make sense with the proposed answer). If a question was not answered or was skipped/cut short, score it 0 to 1.5 accordingly.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                evaluations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      questionNumber: { type: Type.NUMBER },
                      candidateAnswerSummary: { type: Type.STRING },
                      scoreOutOf5: { type: Type.NUMBER },
                      feedback: { type: Type.STRING },
                      strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
                      improvementTip: { type: Type.STRING },
                    },
                    required: [
                      'questionNumber',
                      'candidateAnswerSummary',
                      'scoreOutOf5',
                      'feedback',
                      'strengths',
                      'improvementTip',
                    ],
                  },
                },
              },
              required: ['evaluations'],
            },
          },
        });

        const parsedGrades = JSON.parse(gradeResp.text || '{}');
        if (Array.isArray(parsedGrades.evaluations)) {
          session.questionEvaluations = session.questions.map((q) => {
            const match = parsedGrades.evaluations.find(
              (ev: any) => Number(ev.questionNumber) === q.number
            );
            return {
              questionId: q.id,
              questionNumber: q.number,
              category: q.category,
              questionText: q.question,
              proposedAnswer: q.proposedAnswer,
              candidateAnswer: match?.candidateAnswerSummary || 'Recorded in live voice stream',
              attemptsUsed: 1,
              timedOut: false,
              scoreOutOf5: match
                ? Math.max(0, Math.min(5, Math.round(Number(match.scoreOutOf5) * 2) / 2))
                : 0,
              feedback: match?.feedback || 'Evaluated from live voice transcript.',
              strengths: Array.isArray(match?.strengths) ? match.strengths.slice(0, 3) : [],
              improvementTip: match?.improvementTip || q.expectedFocus,
            };
          });
        }
      } catch (gradeErr) {
        console.warn('Live transcript grading fallback:', gradeErr);
      }
    }

    // Deterministic Marking Guide grading when Gemini is not used or fallback is needed
    if (session.questionEvaluations.length === 0) {
      const candidateTurns = session.transcript.filter((t) => t.speaker === 'candidate');
      session.questionEvaluations = session.questions.map((q, idx) => {
        const answerTurn = candidateTurns[idx + 1] || candidateTurns[idx];
        const text = answerTurn?.text || '';
        if (!text.trim()) {
          return {
            questionId: q.id,
            questionNumber: q.number,
            category: q.category,
            questionText: q.question,
            proposedAnswer: q.proposedAnswer,
            candidateAnswer: '[No response recorded for this question]',
            attemptsUsed: 0,
            timedOut: false,
            scoreOutOf5: 0,
            feedback: 'No response was recorded for this question.',
            strengths: [],
            improvementTip: q.expectedFocus,
          };
        }

        const mgEval = evaluateCandidateResponseWithMarkingGuide({
          questionId: q.id,
          questionText: q.question,
          category: q.category,
          expectedFocus: q.expectedFocus,
          proposedAnswer: q.proposedAnswer,
          candidateText: text,
          role: session.detectedRole,
        });

        return {
          questionId: q.id,
          questionNumber: q.number,
          category: q.category,
          questionText: q.question,
          proposedAnswer: q.proposedAnswer,
          candidateAnswer: text,
          attemptsUsed: 1,
          timedOut: false,
          scoreOutOf5: mgEval.isOnTopic ? mgEval.scoreOutOf5 : 1,
          feedback: mgEval.feedback,
          strengths: mgEval.strengths,
          improvementTip: mgEval.improvementTip,
        };
      });
    }

    return await concludeAndFinalizeSession(session, res, Boolean(terminatedByAttemptRule));
  } catch (err: any) {
    console.error('Error in /api/finalize-live-ws-session:', err);
    return res.status(500).json({ error: err?.message || 'Failed to finalize live session.' });
  }
});

// 5f. Get session by ID (for /scoring page reload safety)
app.get('/api/session/:id', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const candidate = activeCandidates.get(session.candidateId) || null;
  return res.json({ session, candidate });
});

// 5g. Candidates & Relational Interview Sessions Endpoints (1-to-Many: candidates -> interview_sessions)
app.get('/api/candidates', async (_req, res) => {
  const config = getSupabaseConfig();
  let supabaseRelationalData: any[] | null = null;

  if (config) {
    try {
      const resp = await fetch(
        `${config.url}/rest/v1/candidates?select=*,interview_sessions(*)&order=updated_at.desc`,
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
        supabaseRelationalData = await resp.json();
      }
    } catch {
      // Fallback to local relational join below
    }
  }

  const allSessions = Array.from(activeSessions.values());
  const candidatesWithSessions = Array.from(activeCandidates.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((candidate) => {
      const linkedSessions = allSessions
        .filter(
          (s) =>
            s.candidateId === candidate.id ||
            s.candidateEmail.toLowerCase() === candidate.email.toLowerCase()
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        ...candidate,
        interviewSessions: linkedSessions,
      };
    });

  return res.json({
    totalCandidates: candidatesWithSessions.length,
    totalInterviewSessions: allSessions.length,
    relation: 'public.candidates (1) ---> (Many) public.interview_sessions via candidate_id',
    supabaseLiveJoinRows: supabaseRelationalData,
    candidates: candidatesWithSessions,
  });
});

app.get('/api/candidates/:id', (req, res) => {
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
    .filter(
      (s) =>
        s.candidateId === candidate!.id ||
        s.candidateEmail.toLowerCase() === candidate!.email.toLowerCase()
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return res.json({
    candidate,
    interviewSessions: linkedSessions,
  });
});

// 5h. Supabase Schema SQL & Live Sync Endpoints
app.get('/api/supabase/schema-sql', (_req, res) => {
  try {
    const schemaPath = path.join(process.cwd(), 'supabase-schema.sql');
    const sqlContent = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf-8') : '';
    res.type('text/plain').send(sqlContent);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to read supabase-schema.sql' });
  }
});

app.post('/api/supabase/sync', async (_req, res) => {
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

// ============================================================================
// 6. LUNA v2 REAL-TIME VOICE WEBSOCKET BRIDGE (/api/live-ws)
// ============================================================================
const endCallFunctionDeclaration: FunctionDeclaration = {
  name: 'end_call',
  description:
    'Ends the live interview call after you have spoken your final impression and told the candidate whether or not they were successful (or after 2 failed attempts on a question).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'completed_all_questions or terminated_after_two_attempts',
      },
    },
  },
};

const advanceQuestionFunctionDeclaration: FunctionDeclaration = {
  name: 'advance_question',
  description:
    'Call this whenever you move to the next interview question (Question 1, 2, 3, 4, or 5) so the candidate UI resets the 90-second timer.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      questionNumber: {
        type: Type.NUMBER,
        description: 'The question number (1 to 5) you are now asking.',
      },
    },
    required: ['questionNumber'],
  },
};

async function startServer() {
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === '/api/live-ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (clientWs: WebSocket, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const session = activeSessions.get(sessionId);

    const ai = getGenAIClientOrNull();
    if (!ai || !session) {
      clientWs.send(
        JSON.stringify({
          type: 'fallback_required',
          reason: !ai ? 'GEMINI_API_KEY not configured' : 'Session not found',
        })
      );
      clientWs.close();
      return;
    }

    let geminiSession: any = null;

    try {
      const questionsListText = session.questions
        .map((q) => `Question ${q.number} (${q.category}): "${q.question}" [Expected Focus: ${q.expectedFocus}]`)
        .join('\n');

      const systemPrompt = `You are the Official Live Voice Interviewer for Global Hire 360 (https://www.globalhire360.com/).
VOICE & PERSONA:
- Speak with a warm, articulate, confident, encouraging African American female coach voice and cadence.
- Keep your spoken turns natural, conversational, and concise (2 to 4 sentences per turn).

CANDIDATE DETAILS:
- Candidate Name: ${session.candidateName}
- Extracted Job Position from Resume: ${session.detectedRole}
- Candidate Experience Summary: ${session.candidateExperienceSummary}
- Key Skills: ${session.keySkills.join(', ')}

THE 5 INTERVIEW QUESTIONS FOR THIS ROLE:
${questionsListText}

STRICT INTERVIEW FLOW & RULES (MUST FOLLOW EXACTLY):
1. GREETING FIRST: Start immediately by warmly greeting ${session.candidateName}, welcoming them to the Global Hire 360 interview room for the ${session.detectedRole} role, and asking how they are doing today. Wait for their reply.
2. ASK QUESTIONS 1 TO 5 IN ORDER: After they reply to your greeting, call the tool "advance_question" with questionNumber: 1 and ask Question 1. Each time you move to a new question (1 through 5), call "advance_question" with that questionNumber so their 90-second timer resets.
3. REPHRASING & THE 2-ATTEMPT COACHING RULE:
   - If ${session.candidateName} asks you to repeat or rephrase a question, gladly rephrase it in simpler terms.
   - If ${session.candidateName}'s answer is off-topic or does not answer the question on their FIRST attempt, gently stop them, give them warm motivation ("You've got this, let me rephrase what I'm looking for..."), and rephrase the question for Attempt 2.
   - If after 2 attempts on the same question they STILL do not answer it properly, give them warm, encouraging words to practice further with the Global Hire 360 Workshop, tell them they were not successful today, and call "end_call" with reason "terminated_after_two_attempts".
4. 90-SECOND TIMER: If you receive a system message saying "[90-SECOND TIMER EXPIRED]", politely interrupt the candidate, let them know the 90 seconds for that question are up, call "advance_question" for the next question, and ask the next question immediately.
5. ENDING THE INTERVIEW: After Question 5 is answered, give your honest final impression, explicitly tell ${session.candidateName} whether or not they were successful, and call the "end_call" tool.`;

      geminiSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore',
              },
            },
          },
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          tools: [
            {
              functionDeclarations: [endCallFunctionDeclaration, advanceQuestionFunctionDeclaration],
            },
          ],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'connected' }));
            }
          },
          onmessage: async (message: any) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;

            // Forward serverContent (audio chunks, interruption, transcriptions)
            clientWs.send(JSON.stringify(message));

            // Handle tool calls (advance_question / end_call)
            const toolCalls = message?.toolCall?.functionCalls;
            if (Array.isArray(toolCalls)) {
              for (const call of toolCalls) {
                if (call.name === 'advance_question') {
                  const qNum = Number(call.args?.questionNumber) || 1;
                  clientWs.send(
                    JSON.stringify({
                      type: 'question_advanced',
                      questionNumber: Math.max(1, Math.min(5, qNum)),
                    })
                  );
                  try {
                    await geminiSession.sendToolResponse({
                      functionResponses: [
                        {
                          id: call.id,
                          name: call.name,
                          response: { result: `Timer reset for Question ${qNum}` },
                        },
                      ],
                    });
                  } catch {
                    // ignore
                  }
                } else if (call.name === 'end_call') {
                  clientWs.send(
                    JSON.stringify({
                      type: 'end_call_triggered',
                      reason: call.args?.reason || 'completed_all_questions',
                    })
                  );
                }
              }
            }
          },
          onerror: (err: any) => {
            console.warn('Gemini Live WebSocket error:', err);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: 'fallback_required',
                  reason: err?.message || 'Gemini Live error',
                })
              );
            }
          },
          onclose: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          },
        },
      });

      // Kick off the interviewer's initial greeting automatically
      await geminiSession.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [
              {
                text: `The candidate ${session.candidateName} has just joined the interview room with their camera and microphone on. Greet them warmly by name and ask how they are doing today.`,
              },
            ],
          },
        ],
        turnComplete: true,
      });
    } catch (err: any) {
      console.warn('Failed to initialize Gemini Live session, switching to fallback:', err?.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'fallback_required',
            reason: err?.message || 'Live connection unavailable',
          })
        );
        clientWs.close();
      }
      return;
    }

    clientWs.on('message', async (raw) => {
      if (!geminiSession) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.realtimeInput) {
          await geminiSession.sendRealtimeInput(msg.realtimeInput);
        } else if (msg.clientContent) {
          await geminiSession.sendClientContent(msg.clientContent);
        } else if (msg.type === 'timer_expired') {
          const nextQNum = (msg.currentQuestionIndex || 0) + 2;
          await geminiSession.sendClientContent({
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: `[SYSTEM NOTIFICATION: 90-SECOND TIMER EXPIRED on Question ${
                      (msg.currentQuestionIndex || 0) + 1
                    }. Politely interrupt ${session.candidateName} right now, let them know their 90 seconds are up for this question, and ${
                      nextQNum <= 5
                        ? `call advance_question(${nextQNum}) and ask Question ${nextQNum} immediately.`
                        : `give your final impression and call end_call.`
                    }]`,
                  },
                ],
              },
            ],
            turnComplete: true,
          });
        }
      } catch (e) {
        console.warn('Error forwarding client WS frame:', e);
      }
    });

    clientWs.on('close', () => {
      try {
        geminiSession?.close();
      } catch {
        // ignore
      }
    });
  });

  // Bind port 3000 immediately so container health checks succeed without delay
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Global Hire 360 Server running on http://localhost:${PORT}`);
    // Automatically provision & seed Supabase tables on startup when credentials are configured
    provisionSupabaseTablesViaManagementApi()
      .then(() => seedCustomerServiceQuestionsToSupabase())
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
            hmr: false,
            watch: null,
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

startServer();
