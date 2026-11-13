/**
 * Marks each answer out of 5 against the question's suggested answer, with a fixed rubric so
 * marks are consistent and explainable:
 *
 *   relevance  0–2    does it answer the question that was asked?
 *   alignment  0–2    does it go in the same direction as the suggested answer (key ideas)?
 *   evidence   0–1    concrete example / result, clearly explained?
 *
 * The model only scores the parts; the server adds them up and applies the hard rules
 * (off-topic or nearly empty answers cannot score more than 1).
 */
import { Type, type GoogleGenAI } from '@google/genai';
import { generateWithFallback } from './gemini-call';


export interface RubricQuestion {
  number: number;
  question: string;
  suggestedAnswer: string;
  expectedFocus: string;
}

export interface RubricGrade {
  scoreOutOf5: number;
  relevance: number;
  alignment: number;
  evidence: number;
  onTopic: boolean;
  feedback: string;
  strengths: string[];
  improvementTip: string;
}

const half = (n: number, max: number) => Math.max(0, Math.min(max, Math.round((Number(n) || 0) * 2) / 2));

export function wordCount(text: string): number {
  return String(text || '').split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

async function gradeOne(
  ai: GoogleGenAI,
  role: string,
  q: RubricQuestion,
  answer: string
): Promise<RubricGrade> {
  const resp = await generateWithFallback(ai, {
    contents: `You are a fair, strict and consistent interview assessor for a ${role} position.

QUESTION ${q.number}: ${q.question}

SUGGESTED ANSWER (the marking guide — what a strong answer covers):
${q.suggestedAnswer}

WHAT EMPLOYERS LOOK FOR: ${q.expectedFocus}

CANDIDATE'S ANSWER (accurate transcript of their speech; it may include a question they asked or a request to repeat):
"""
${answer}
"""

Mark only the candidate's actual words. Do not reward things they did not say, and do not punish wording, accent, filler words or small grammar slips — judge the meaning. A word-for-word match with the suggested answer is NOT required: an answer that makes the same points in its own words, or other points that are equally valid for this question, deserves full credit.

Score three parts (0.5 steps allowed):
- relevance (0–2): 2 = directly answers this question; 1 = partly answers it or drifts; 0 = does not answer it (off-topic, only small talk, "I don't know", only asking to repeat).
- alignment (0–2): 2 = covers the key ideas of the suggested answer (or equally valid ones); 1 = covers some of them; 0 = none.
- evidence (0–1): 1 = gives a concrete example, action or result and is clear/structured; 0.5 = some specifics; 0 = vague or none.

Also set onTopic (false if the answer is about something else entirely), one or two sentences of neutral feedback addressed to the candidate ("You ..."), up to 2 short strengths (empty if none), and one practical improvement tip.`,
    config: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          relevance: { type: Type.NUMBER },
          alignment: { type: Type.NUMBER },
          evidence: { type: Type.NUMBER },
          onTopic: { type: Type.BOOLEAN },
          feedback: { type: Type.STRING },
          strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          improvementTip: { type: Type.STRING },
        },
        required: ['relevance', 'alignment', 'evidence', 'onTopic', 'feedback', 'strengths', 'improvementTip'],
      },
    },
  }, { label: `grading Q${q.number}` });
  const r = JSON.parse(resp.text || '{}');
  const relevance = half(r.relevance, 2);
  const alignment = half(r.alignment, 2);
  const evidence = half(r.evidence, 1);
  const onTopic = r.onTopic !== false && relevance > 0;
  let score = relevance + alignment + evidence;
  if (!onTopic) score = Math.min(score, 1);
  if (wordCount(answer) < 8) score = Math.min(score, 1);
  return {
    scoreOutOf5: half(score, 5),
    relevance,
    alignment,
    evidence,
    onTopic,
    feedback: String(r.feedback || '').slice(0, 1500),
    strengths: Array.isArray(r.strengths) ? r.strengths.slice(0, 2).map((x: any) => String(x).slice(0, 300)) : [],
    improvementTip: String(r.improvementTip || '').slice(0, 800),
  };
}

/**
 * Grades every answered question in parallel. Questions with no answer are not sent.
 * A question whose grading fails on every model is absent from the result (the caller falls
 * back to the keyword marking guide for it).
 */
export async function gradeAnswersWithRubric(
  ai: GoogleGenAI,
  role: string,
  items: { question: RubricQuestion; answer: string }[]
): Promise<Map<number, RubricGrade>> {
  const out = new Map<number, RubricGrade>();
  await Promise.all(
    items
      .filter((it) => wordCount(it.answer) > 0)
      .map(async (it) => {
        try {
          out.set(it.question.number, await gradeOne(ai, role, it.question, it.answer));
        } catch (err: any) {
          console.warn(`Rubric grading failed for Q${it.question.number}:`, String(err?.message || err).slice(0, 200));
        }
      })
  );
  return out;
}
