/**
 * Accurate English transcript of what the candidate said.
 *
 * The live captions from Gemini Live are produced on the fly and can be wrong (wrong words,
 * other languages). Answers are marked on the transcript, so the server also keeps the
 * candidate's own microphone audio, split into turns (one segment per time the candidate
 * speaks between two interviewer turns), and transcribes it again after the call with a
 * full speech model. The accurate text then replaces the live captions for those turns.
 *
 * Audio only lives in memory for the duration of the interview and is dropped once the
 * transcript has been produced.
 */
import { Type, type GoogleGenAI } from '@google/genai';
import { generateWithFallback } from './gemini-call.js';

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Frames quieter than this (RMS, 0..1) count as silence. */
const QUIET_RMS = 0.006;
/** Keep at most this many quiet frames in a row (~1 s); longer pauses are shortened. */
const MAX_QUIET_FRAMES = 8;
/** Per-interview cap (~12 minutes of speech). */
const MAX_TOTAL_BYTES = 12 * 60 * BYTES_PER_SECOND;
/** Turns shorter than this carry no real speech. */
const MIN_SEGMENT_BYTES = Math.round(0.6 * BYTES_PER_SECOND);

export interface CandidateSegment {
  /** 0-based index of the question being answered (undefined during the introduction). */
  questionIndex?: number;
  /** Transcript entries (live captions) this audio belongs to. */
  entryIds: string[];
  frames: Buffer[];
  bytes: number;
  quietRun: number;
}

function frameRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

function isAllZero(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
  return true;
}

export class CandidateAudioRecorder {
  readonly createdAt = Date.now();
  readonly segments: CandidateSegment[] = [];
  private open: CandidateSegment | null = null;
  private totalBytes = 0;

  /** One microphone frame (16 kHz, 16-bit mono PCM) from the candidate. */
  addFrame(pcm: Buffer, questionIndex?: number): void {
    // The browser sends zeros while Sarah is speaking (echo gate): not candidate speech.
    if (!pcm.length || isAllZero(pcm) || this.totalBytes >= MAX_TOTAL_BYTES) return;
    let seg = this.open;
    if (!seg || seg.questionIndex !== questionIndex) {
      seg = { questionIndex, entryIds: [], frames: [], bytes: 0, quietRun: 0 };
      this.segments.push(seg);
      this.open = seg;
    }
    if (frameRms(pcm) < QUIET_RMS) {
      seg.quietRun += 1;
      if (seg.quietRun > MAX_QUIET_FRAMES || seg.bytes === 0) return; // trim long / leading silence
    } else {
      seg.quietRun = 0;
    }
    seg.frames.push(pcm);
    seg.bytes += pcm.length;
    this.totalBytes += pcm.length;
  }

  /** The interviewer started talking: the candidate's current turn is over. */
  closeTurn(): void {
    this.open = null;
  }

  /** Links the live-caption entry the candidate is speaking into to the current turn's audio. */
  linkEntry(entryId: string): void {
    const seg = this.open ?? this.segments[this.segments.length - 1];
    if (seg && !seg.entryIds.includes(entryId)) seg.entryIds.push(entryId);
  }

  get hasAudio(): boolean {
    return this.segments.some((s) => s.bytes >= MIN_SEGMENT_BYTES);
  }
}

/** Recorders by interview session id (kept across reconnects of the same interview). */
export const candidateRecorders = new Map<string, CandidateAudioRecorder>();

/** Drops recordings of interviews that are over or abandoned (audio is never kept long). */
export function pruneRecorders(isStillRunning: (sessionId: string) => boolean, maxAgeMs = 30 * 60_000): void {
  for (const [id, rec] of candidateRecorders) {
    if (!isStillRunning(id) || Date.now() - rec.createdAt > maxAgeMs) candidateRecorders.delete(id);
  }
}

export function recorderFor(sessionId: string): CandidateAudioRecorder {
  let rec = candidateRecorders.get(sessionId);
  if (!rec) {
    rec = new CandidateAudioRecorder();
    candidateRecorders.set(sessionId, rec);
  }
  return rec;
}

function toWav(frames: Buffer[]): Buffer {
  const data = Buffer.concat(frames);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Transcribes every recorded candidate turn (one request per question, in parallel).
 * Returns the accurate text for each live-caption entry id; entries that could not be
 * transcribed are simply absent (their live caption is kept).
 */
export async function transcribeCandidateAudio(
  ai: GoogleGenAI,
  recorder: CandidateAudioRecorder,
  context: { vocabulary: string[]; questions: { number: number; question: string }[] }
): Promise<Map<string, string>> {
  const usable = recorder.segments.filter((s) => s.bytes >= MIN_SEGMENT_BYTES && s.entryIds.length > 0);
  const groups = new Map<string, CandidateSegment[]>();
  for (const seg of usable) {
    const key = String(seg.questionIndex ?? 'intro');
    groups.set(key, [...(groups.get(key) || []), seg]);
  }

  const textBySegment = new Map<CandidateSegment, string>();
  await Promise.all(
    Array.from(groups.entries()).map(async ([key, segs]) => {
      const question = key === 'intro' ? undefined : context.questions[Number(key)];
      const parts: any[] = [];
      segs.forEach((seg, i) => {
        parts.push({ text: `Clip ${i + 1}:` });
        parts.push({ inlineData: { mimeType: 'audio/wav', data: toWav(seg.frames).toString('base64') } });
      });
      parts.push({
        text: `These ${segs.length} audio clip(s) are a job candidate speaking English during a recorded interview${
          question ? `, in reply to the question: "${question.question}"` : ''
        }.
Transcribe each clip verbatim, in English only.
- Write exactly the words spoken. Do not translate, summarize, correct, complete or improve anything, and never add words that were not said (do not make the answer fit the question).
- Keep numbers as spoken words or digits, whichever is clearer.
- If a stretch is unintelligible or not in English, write [unclear] for it. Never output text in another language or script.
- If a clip contains no speech, return an empty string for it.
Terms that may occur: ${context.vocabulary.join(', ')}.`,
      });
      try {
        const resp = await generateWithFallback(ai, {
          contents: [{ role: 'user', parts }],
          config: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                clips: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: { clip: { type: Type.NUMBER }, text: { type: Type.STRING } },
                    required: ['clip', 'text'],
                  },
                },
              },
              required: ['clips'],
            },
          },
        }, { label: `transcription (${key})`, timeoutMs: 60000 });
        const parsed = JSON.parse(resp.text || '{}');
        for (const c of Array.isArray(parsed.clips) ? parsed.clips : []) {
          const seg = segs[Number(c?.clip) - 1];
          const text = String(c?.text || '').replace(/\s+/g, ' ').trim();
          // Ignore results that are only [unclear] markers: the live caption is better than nothing.
          if (seg && text && text.replace(/\[unclear\]/gi, '').trim()) textBySegment.set(seg, text);
        }
      } catch (err: any) {
        console.warn(`Candidate audio transcription failed (${key}):`, String(err?.message || err).slice(0, 200));
      }
    })
  );

  // An entry may span several turns (if Sarah's words in between were not captioned). It is
  // only replaced when every one of its turns was transcribed, so no words are ever lost.
  const segsByEntry = new Map<string, CandidateSegment[]>();
  for (const seg of usable) {
    for (const id of seg.entryIds) segsByEntry.set(id, [...(segsByEntry.get(id) || []), seg]);
  }
  const byEntry = new Map<string, string>();
  for (const [id, segs] of segsByEntry) {
    if (segs.every((seg) => textBySegment.has(seg))) {
      byEntry.set(id, segs.map((seg) => textBySegment.get(seg)).join(' ').trim());
    }
  }
  return byEntry;
}
