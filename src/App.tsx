import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  createContext,
  useContext,
} from "react";

type NavigateOptions = { replace?: boolean };
type NavigateFn = (to: string, options?: NavigateOptions) => void;

const RouterContext = createContext<{ path: string; navigate: NavigateFn }>({
  path: "/",
  navigate: () => {},
});

function useNavigate(): NavigateFn {
  return useContext(RouterContext).navigate;
}

const BrowserRouter: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [path, setPath] = useState<string>(
    () => window.location.pathname || "/",
  );

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: NavigateOptions) => {
    if (options?.replace) {
      window.history.replaceState({}, "", to);
    } else {
      window.history.pushState({}, "", to);
    }
    setPath(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <RouterContext.Provider value={{ path, navigate }}>
      {children}
    </RouterContext.Provider>
  );
};

const Routes: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { path } = useContext(RouterContext);
  const childArray = React.Children.toArray(children) as React.ReactElement<{
    path: string;
    element: React.ReactNode;
  }>[];
  const exactMatch = childArray.find((c) => c.props.path === path);
  if (exactMatch) return <>{exactMatch.props.element}</>;
  const wildcard = childArray.find((c) => c.props.path === "*");
  return <>{wildcard ? wildcard.props.element : null}</>;
};

const Route: React.FC<{ path: string; element: React.ReactNode }> = () => null;

const Navigate: React.FC<{ to: string; replace?: boolean }> = ({
  to,
  replace,
}) => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace });
  }, [to, replace, navigate]);
  return null;
};
import {
  CheckCircle2,
  Clock,
  FileText,
  Mail,
  Mic,
  MicOff,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  User,
  Video,
  VideoOff,
  Volume2,
  Award,
  AlertTriangle,
  PhoneOff,
  Briefcase,
  Check,
  Download,
  ArrowRight,
  RotateCcw,
  ChevronDown,
} from "lucide-react";

const LOGO_URL =
  "/assets/aistudio/cropped-cropped-Global-Hire-360-Logo-2_18222f57.png";

export const SINGLE_INTERVIEWER_VOICE = {
  id: "Aoede" as const,
  label: "Sarah — Operations & Talent Manager (Global Hire 360)",
  shortLabel: "Sarah (Hiring Manager)",
  pitch: 1.0,
  rate: 0.99,
  voiceMatchRegex:
    /google us english|ava|aria|jenny|samantha|allison|sara|sonia|natural/i,
};

/**
 * Dedicated helper to resolve the candidate's Google account profile picture when their camera is off.
 * Uses verified Google/Gravatar/webcam avatar URLs or the Google Account monogram SVG endpoint.
 */
export function findCandidateProfilePicture(
  email: string,
  fullName: string,
  sessionAvatarUrl?: string,
): string {
  const cleanEmail = (email || "").trim().toLowerCase();
  const displayName = (fullName || "").trim() || cleanEmail || "Candidate";

  if (cleanEmail) {
    try {
      const localCached = window.localStorage.getItem(
        `gh360_google_pic_${cleanEmail}`,
      );
      if (localCached && !localCached.includes("unavatar.io")) {
        return localCached;
      }
    } catch {
      // ignore storage errors
    }
  }

  if (
    sessionAvatarUrl &&
    sessionAvatarUrl.trim().length > 0 &&
    !sessionAvatarUrl.includes("unavatar.io")
  ) {
    return sessionAvatarUrl.trim();
  }

  return `/api/google-avatar.svg?email=${encodeURIComponent(
    cleanEmail,
  )}&name=${encodeURIComponent(displayName)}`;
}

// ============================================================================
// SESSION ACCESS TOKEN (required by the backend for every session-scoped call)
// Kept in memory, and mirrored in localStorage so an unfinished interview can be
// continued directly after a reload or when the candidate comes back.
// ============================================================================
const ACTIVE_SESSION_STORAGE_KEY = "gh360_active_session";
let currentSessionToken = "";

function setActiveSessionAuth(sessionId: string, token: string) {
  currentSessionToken = token;
  try {
    window.localStorage.setItem(
      ACTIVE_SESSION_STORAGE_KEY,
      JSON.stringify({ sessionId, token }),
    );
  } catch {
    // storage unavailable (private mode) — in-memory token still works
  }
}

function loadActiveSessionAuth(): { sessionId: string; token: string } | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.sessionId && parsed?.token) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function clearActiveSessionAuth() {
  try {
    window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function sessionHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-session-token": currentSessionToken,
  };
}

/**
 * Deduplicates overlapping words between final/interim browser SpeechRecognition segments
 * so candidate speech is transcribed cleanly and accurately.
 */
function mergeSpeechChunksAccurately(
  existingText: string,
  newChunk: string,
): string {
  const prev = existingText.replace(/\s+/g, " ").trim();
  const next = newChunk.replace(/\s+/g, " ").trim();
  if (!prev) return next;
  if (!next) return prev;

  const prevLower = prev.toLowerCase();
  const nextLower = next.toLowerCase();

  // If the new chunk already contains the entire previous text (Chrome mobile/desktop quirk)
  if (nextLower.startsWith(prevLower)) {
    return next;
  }
  // If the previous text already ends with the new chunk
  if (prevLower.endsWith(nextLower)) {
    return prev;
  }

  // Check word-level suffix/prefix overlap (up to 6 words)
  const prevWords = prev.split(" ");
  const nextWords = next.split(" ");
  const maxOverlap = Math.min(6, prevWords.length, nextWords.length);

  for (let k = maxOverlap; k >= 1; k--) {
    const prevSuffix = prevWords
      .slice(prevWords.length - k)
      .join(" ")
      .toLowerCase();
    const nextPrefix = nextWords.slice(0, k).join(" ").toLowerCase();
    if (prevSuffix === nextPrefix) {
      return [...prevWords, ...nextWords.slice(k)].join(" ");
    }
  }

  return `${prev} ${next}`;
}

export interface TranscriptEntry {
  id: string;
  speaker: "interviewer" | "candidate";
  speakerName: string;
  text: string;
  timestamp: string;
  questionIndex?: number;
  eventTag?:
    | "greeting"
    | "question"
    | "rephrase"
    | "timeout"
    | "termination"
    | "closing"
    | "answer"
    | "misconduct_warning"
    | "misconduct_termination";
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
}

export interface InterviewSessionRecord {
  id: string;
  candidateId?: string;
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
  }[];
  status:
    | "in_progress"
    | "completed_success"
    | "completed_unsuccessful"
    | "terminated_attempts"
    | "terminated_misconduct"
    | "terminated_rules_violation"
    | "abandoned";
  isFirstTimeCandidate?: boolean;
  currentPhase:
    | "greeting_how_are_you"
    | "process_walkthrough"
    | "questioning"
    | "candidate_questions"
    | "finished";
  currentQuestionIndex: number;
  currentQuestionAttempts: number;
  questionEvaluations: QuestionEvaluation[];
  transcript: TranscriptEntry[];
  totalScoreOutOf20?: number;
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

interface ResumeExaminationResult {
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
  }[];
}

// ============================================================================
// PAGE 1: HOMEPAGE (/) — Short Welcome Message, Instructions & Candidate Form
// ============================================================================
interface HomePageProps {
  onSessionStarted: (
    session: InterviewSessionRecord,
    initialMessage: string,
    liveWsAvailable: boolean,
  ) => void;
}

const HomePage: React.FC<HomePageProps> = ({ onSessionStarted }) => {
  const navigate = useNavigate();

  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeBase64, setResumeBase64] = useState("");
  const [agreedToInstructions, setAgreedToInstructions] = useState(false);

  // Resume Examination State
  const [isExaminingResume, setIsExaminingResume] = useState(false);
  const [examinedResume, setExaminedResume] =
    useState<ResumeExaminationResult | null>(null);
  const [confirmedJobPosition, setConfirmedJobPosition] = useState("");
  const [rejectedDocumentInfo, setRejectedDocumentInfo] = useState<{
    fileName: string;
    message: string;
  } | null>(null);

  const [isStarting, setIsStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [recognizedCandidate, setRecognizedCandidate] = useState<{
    firstName: string;
    sessionsCount: number;
    completedSessionsCount: number;
    savedJobPosition: string;
    hasSavedProfile: boolean;
  } | null>(null);
  const [nameMatchesExisting, setNameMatchesExisting] = useState(false);
  const [unfinishedSession, setUnfinishedSession] = useState<{
    sessionId: string;
    token: string;
    role: string;
    candidateName: string;
  } | null>(null);
  const [isResuming, setIsResuming] = useState(false);

  // Continue directly: if this browser holds an unfinished interview, offer to resume it.
  useEffect(() => {
    const saved = loadActiveSessionAuth();
    if (!saved) return;
    (async () => {
      try {
        const res = await fetch(
          `/api/session/${encodeURIComponent(saved.sessionId)}`,
          { headers: { "x-session-token": saved.token } },
        );
        if (!res.ok) {
          clearActiveSessionAuth();
          return;
        }
        const data = await res.json();
        const s = data.session as InterviewSessionRecord | undefined;
        const maxMs = (s?.maxDurationSeconds || 600) * 1000;
        const stillOpen =
          s &&
          s.status === "in_progress" &&
          s.currentPhase !== "finished" &&
          new Date(s.createdAt).getTime() + maxMs > Date.now();
        if (stillOpen) {
          setUnfinishedSession({
            sessionId: saved.sessionId,
            token: saved.token,
            role: s!.detectedRole,
            candidateName: s!.candidateName,
          });
        } else {
          clearActiveSessionAuth();
        }
      } catch {
        // non-blocking
      }
    })();
  }, []);

  const handleResumeUnfinished = async () => {
    if (!unfinishedSession) return;
    setIsResuming(true);
    setFormError(null);
    try {
      const res = await fetch("/api/resume-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-token": unfinishedSession.token,
        },
        body: JSON.stringify({ sessionId: unfinishedSession.sessionId }),
      });
      const data = await res.json();
      if (!res.ok || !data.resumed || !data.session) {
        clearActiveSessionAuth();
        setUnfinishedSession(null);
        setFormError(
          "That interview can no longer be continued (it finished or its 10 minutes ran out). Please start a new one.",
        );
        return;
      }
      setActiveSessionAuth(data.session.id, data.accessToken || unfinishedSession.token);
      onSessionStarted(
        data.session,
        data.interviewerMessage,
        Boolean(data.liveWsAvailable),
      );
      navigate("/interview");
    } catch {
      setFormError("Could not reconnect to your interview. Please try again.");
    } finally {
      setIsResuming(false);
    }
  };

  // Recognize returning candidates by email (and flag name-only matches) to prevent duplicates
  useEffect(() => {
    const trimmed = candidateEmail.trim().toLowerCase();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    const nameQuery = candidateName.trim();
    if (!validEmail && nameQuery.length < 3) {
      setRecognizedCandidate(null);
      setNameMatchesExisting(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (validEmail) params.set("email", trimmed);
        if (nameQuery) params.set("name", nameQuery);
        const res = await fetch(`/api/candidate-history?${params.toString()}`);
        const data = await res.json();
        if (data.exists) {
          setRecognizedCandidate({
            firstName: data.firstName,
            sessionsCount: data.sessionsCount || 1,
            completedSessionsCount: data.completedSessionsCount || 0,
            savedJobPosition: data.savedJobPosition || "",
            hasSavedProfile: Boolean(data.hasSavedProfile),
          });
          setNameMatchesExisting(false);
          if (data.savedJobPosition && !confirmedJobPosition.trim()) {
            setConfirmedJobPosition(data.savedJobPosition);
          }
        } else {
          setRecognizedCandidate(null);
          setNameMatchesExisting(Boolean(data.nameMatchesExistingCandidate));
        }
      } catch {
        // non-blocking
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [candidateEmail, candidateName]);

  const handleResumeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".pdf") && !ext.endsWith(".docx")) {
      const msg =
        "Document Rejected: Invalid file format. Please upload a valid Resume or CV in .PDF or .DOCX format.";
      setFormError(msg);
      setRejectedDocumentInfo({ fileName: file.name, message: msg });
      setResumeFile(null);
      setResumeBase64("");
      setExaminedResume(null);
      setConfirmedJobPosition("");
      e.target.value = "";
      return;
    }

    setFormError(null);
    setRejectedDocumentInfo(null);
    setResumeFile(file);
    setExaminedResume(null);
    setConfirmedJobPosition("");
    setIsExaminingResume(true);

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result as string;
      setResumeBase64(base64Data);

      try {
        const res = await fetch("/api/examine-resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resumeFileName: file.name,
            resumeMimeType: file.type,
            resumeBase64: base64Data,
          }),
        });
        const data = await res.json();
        if (res.ok && data.detectedRole) {
          setRejectedDocumentInfo(null);
          setExaminedResume(data);
          setConfirmedJobPosition(data.detectedRole);
        } else {
          const rejectionMessage =
            data.error ||
            "Document Rejected: This document does not relate to a Resume, CV, or professional job search profile. Please upload a valid Resume or CV.";
          setRejectedDocumentInfo({
            fileName: file.name,
            message: rejectionMessage,
          });
          setFormError(rejectionMessage);
          setResumeFile(null);
          setResumeBase64("");
          setExaminedResume(null);
          setConfirmedJobPosition("");
        }
      } catch (err) {
        console.warn("Resume examination preview warning:", err);
        setFormError(
          "Failed to examine the uploaded document. Please try again.",
        );
      } finally {
        setIsExaminingResume(false);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleStartInterview = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!candidateName.trim()) {
      setFormError("Please enter your full name.");
      return;
    }
    if (
      !candidateEmail.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail.trim())
    ) {
      setFormError(
        "Please enter a valid email address to receive your assessment results.",
      );
      return;
    }
    if (rejectedDocumentInfo) {
      setFormError(rejectedDocumentInfo.message);
      return;
    }
    const canUseSavedProfile = Boolean(recognizedCandidate?.hasSavedProfile);
    const hasNewResume = Boolean(resumeFile && resumeBase64 && examinedResume);
    if (!hasNewResume && !canUseSavedProfile) {
      setFormError(
        "Please upload a valid Resume or CV (.pdf or .docx) before joining the interview room.",
      );
      return;
    }
    if (!agreedToInstructions) {
      setFormError(
        "Please check the box confirming you have read and agreed to follow the interview instructions.",
      );
      return;
    }

    setIsStarting(true);
    try {
      const res = await fetch("/api/start-interview-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateName: candidateName.trim(),
          candidateEmail: candidateEmail.trim(),
          resumeFileName: hasNewResume ? resumeFile!.name : undefined,
          resumeMimeType: hasNewResume ? resumeFile!.type : undefined,
          resumeBase64: hasNewResume ? resumeBase64 : undefined,
          confirmedJobPosition:
            confirmedJobPosition.trim() ||
            examinedResume?.detectedRole ||
            recognizedCandidate?.savedJobPosition,
          agreedToInstructions: Boolean(agreedToInstructions),
          preExaminedData: hasNewResume ? examinedResume : undefined,
          // Lets the server continue this browser's unfinished session instead of creating a new one
          existingSessionToken: loadActiveSessionAuth()?.token,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not start interview session.");
      }
      if (data.session?.id && data.accessToken) {
        setActiveSessionAuth(data.session.id, data.accessToken);
      }

      onSessionStarted(
        data.session,
        data.interviewerMessage,
        Boolean(data.liveWsAvailable),
      );
      navigate("/interview");
    } catch (err: any) {
      setFormError(
        err?.message || "Unable to start interview session. Please try again.",
      );
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Clean Brand Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-center">
          <div className="flex items-center gap-3">
            <img
              src={LOGO_URL}
              alt="Global Hire 360"
              referrerPolicy="no-referrer"
              className="h-11 w-auto object-contain"
            />
            <div className="border-l border-slate-200 pl-3">
              <span className="block text-sm font-extrabold text-[#041E41] tracking-tight">
                Global Hire 360
              </span>
              <span className="block text-xs text-[#339A05] font-semibold">
                Live AI Interview Room
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content: Short Welcome Message + Instructions + Candidate Form */}
      <main className="flex-1 max-w-2xl w-full mx-auto px-6 py-8">
        {/* 1. Short Welcome Message */}
        <section className="bg-[#041E41] text-white rounded-xl p-6 shadow-sm border-b-4 border-[#339A05] mb-6">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight mb-2">
            Welcome, Candidate!
          </h1>
          <p className="text-sm text-slate-200 leading-relaxed">
            Welcome to the official <strong>Global Hire 360</strong> Live Voice
            Interview Platform. You are about to enter a live interactive voice
            interview where our AI Interviewer will examine your resume, greet
            you, and assess your readiness for your target role.
          </p>
        </section>

        {/* 2. Clear Instructions Before Joining the Room */}
        <section className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[#041E41] mb-3.5 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#339A05]" />
            Instructions Before Joining the Interview Room
          </h2>
          <ul className="space-y-2.5 text-sm text-slate-700">
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                1
              </span>
              <span>
                <strong>Camera &amp; Microphone On, One-to-One:</strong> Join
                alone from a quiet space with your camera and microphone
                enabled. Headphones give the clearest conversation. Speak when
                Sarah has finished her sentence — your microphone is paused
                while she talks. Only you may answer: if someone else answers
                or coaches you, the interviewer can end the call.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                2
              </span>
              <span>
                <strong>
                  10-Minute Max Session &amp; 90-Second Question Timer:
                </strong>{" "}
                Each interview consists of <strong>4 questions</strong> (5 for returning candidates) within a{" "}
                <strong>10-minute maximum session</strong>. You have{" "}
                <strong>90 seconds</strong> per question before the interviewer
                politely advances to the next question.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                3
              </span>
              <span>
                <strong>Stress-Free Conversational Coaching:</strong> Speak
                comfortably with Sarah, your AI Hiring Manager. You can ask her
                anything during the call, or ask her to repeat or rephrase a
                question. If you feel stuck, she will rephrase it in simpler
                words before moving on to the next question.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                4
              </span>
              <span>
                <strong>
                  Professional Conduct &amp; 24-Hour Suspension Policy:
                </strong>{" "}
                Enjoy a natural, warm conversation with your interviewer, but
                keep all dialogue strictly professional. Inappropriate or
                profane language results in a{" "}
                <strong>3-point score deduction</strong>, or immediate call
                termination and a <strong>24-hour suspension</strong> from
                attempting another interview.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                5
              </span>
              <span>
                <strong>
                  Marking Guide Scoring (0 to 5 Scale) &amp; Email Report:
                </strong>{" "}
                Each question is graded from <strong>0 to 5 points</strong>{" "}
                on how closely your answer follows the direction of the
                suggested answer, and your total is always marked{" "}
                <strong>out of 20</strong> (passing benchmark: 13/20 = 65%). Results and transcript are
                sent to your email.
              </span>
            </li>
          </ul>
        </section>

        {/* 3. Candidate Check-In Form */}
        <form
          onSubmit={handleStartInterview}
          className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-5"
        >
          <h2 className="text-base font-bold text-[#041E41] border-b border-slate-100 pb-3 flex items-center justify-between">
            <span>Candidate Details &amp; Resume Check-In</span>
            {recognizedCandidate && (
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-100 text-[#15803D] inline-flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Returning Candidate Recognized
              </span>
            )}
          </h2>

          {unfinishedSession && (
            <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span>
                You have an unfinished <strong>{unfinishedSession.role}</strong>{" "}
                interview. Continue where you left off?
              </span>
              <button
                type="button"
                onClick={handleResumeUnfinished}
                disabled={isResuming}
                className="shrink-0 px-4 py-2 rounded-lg bg-[#041E41] hover:bg-[#0a2d5e] disabled:opacity-60 text-white font-bold cursor-pointer"
              >
                {isResuming ? "Reconnecting..." : "Continue my interview"}
              </button>
            </div>
          )}

          {recognizedCandidate && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#339A05] shrink-0" />
                <span>
                  Welcome back, <strong>{recognizedCandidate.firstName}</strong>!
                  This session will be added to your existing candidate profile
                  ({recognizedCandidate.sessionsCount} session
                  {recognizedCandidate.sessionsCount === 1 ? "" : "s"} on record).
                  {recognizedCandidate.hasSavedProfile &&
                    ` Your saved role is ${recognizedCandidate.savedJobPosition}, so uploading your resume again is optional.`}
                </span>
              </div>
            </div>
          )}

          {!recognizedCandidate && nameMatchesExisting && (
            <div className="p-3 rounded-lg bg-sky-50 border border-sky-200 text-sky-900 text-xs">
              We already have a candidate profile with this name. If it is
              yours, use the same email address you used before so your
              sessions continue in one profile.
            </div>
          )}

          {formError && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
              <span>{formError}</span>
            </div>
          )}

          {/* Full Name */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Full Name <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                required
                value={candidateName}
                onChange={(e) => setCandidateName(e.target.value)}
                placeholder="Enter your full name"
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:border-[#041E41] focus:ring-2 focus:ring-[#041E41]/10"
              />
            </div>
          </div>

          {/* Email Address */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Email Address <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                value={candidateEmail}
                onChange={(e) => setCandidateEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:border-[#041E41] focus:ring-2 focus:ring-[#041E41]/10"
              />
            </div>
          </div>

          {/* Upload Resume (.pdf or .docx) */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Upload Resume (.PDF or .DOCX){" "}
              {recognizedCandidate?.hasSavedProfile ? (
                <span className="text-slate-500 normal-case font-medium">
                  (optional — saved profile on file)
                </span>
              ) : (
                <span className="text-red-500">*</span>
              )}
            </label>
            <label
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-5 cursor-pointer transition-colors ${
                rejectedDocumentInfo
                  ? "border-red-300 bg-red-50/40 hover:border-red-400"
                  : "border-slate-300 hover:border-[#339A05] bg-slate-50/70 hover:bg-[#339A05]/5"
              }`}
            >
              <Upload
                className={`w-6 h-6 mb-1.5 ${
                  rejectedDocumentInfo ? "text-red-600" : "text-[#041E41]"
                }`}
              />
              <span
                className={`text-sm font-semibold ${
                  rejectedDocumentInfo ? "text-red-700" : "text-[#041E41]"
                }`}
              >
                {resumeFile
                  ? resumeFile.name
                  : rejectedDocumentInfo
                    ? `${rejectedDocumentInfo.fileName} (Rejected — Click to upload a valid Resume/CV)`
                    : "Click to upload your resume (.pdf or .docx)"}
              </span>
              <span className="text-xs text-slate-500 mt-0.5">
                Your resume is automatically examined to extract the job
                position you are applying for
              </span>
              <input
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleResumeUpload}
                className="hidden"
              />
            </label>

            {/* Live Resume Examination Result */}
            {isExaminingResume && (
              <div className="mt-3 p-3 rounded-lg bg-slate-100 border border-slate-200 flex items-center gap-2.5 text-xs font-medium text-[#041E41]">
                <RefreshCw className="w-4 h-4 animate-spin text-[#339A05]" />
                <span>Examining your document...</span>
              </div>
            )}

            {!isExaminingResume &&
              !examinedResume &&
              recognizedCandidate?.hasSavedProfile && (
                <div className="mt-3 p-3.5 rounded-lg bg-[#339A05]/10 border border-[#339A05]/30">
                  <label className="block text-xs font-bold uppercase tracking-wider text-[#041E41] mb-1">
                    Job Position (from your saved profile)
                  </label>
                  <input
                    type="text"
                    value={confirmedJobPosition}
                    maxLength={120}
                    onChange={(e) => setConfirmedJobPosition(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-[#339A05]/40 bg-white text-sm font-bold text-[#041E41] focus:outline-none focus:border-[#041E41]"
                  />
                </div>
              )}

            {!isExaminingResume && examinedResume && !rejectedDocumentInfo && (
              <div className="mt-3 p-3.5 rounded-lg bg-[#339A05]/10 border border-[#339A05]/30 space-y-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-[#041E41] mb-1">
                    Job Position
                  </label>
                  <input
                    type="text"
                    value={confirmedJobPosition}
                    onChange={(e) => setConfirmedJobPosition(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-[#339A05]/40 bg-white text-sm font-bold text-[#041E41] focus:outline-none focus:border-[#041E41]"
                  />
                </div>

                {examinedResume.keySkills.length > 0 && (
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-[#041E41] mb-1">
                      Skills
                    </label>
                    <div className="w-full px-3 py-2 rounded-md border border-[#339A05]/40 bg-white text-xs text-slate-700 leading-relaxed">
                      {examinedResume.keySkills.join(", ")}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mandatory Agreement Checkbox */}
          <label className="flex items-start gap-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agreedToInstructions}
              onChange={(e) => setAgreedToInstructions(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[#339A05] rounded cursor-pointer"
            />
            <span className="text-xs text-slate-700 leading-relaxed font-medium">
              I confirm that I have read and followed all the instructions
              above, my camera and microphone are ready, and I agree to join the
              live interview room. <span className="text-red-500">*</span>
            </span>
          </label>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isStarting || isExaminingResume}
            className="w-full py-3.5 px-6 rounded-xl bg-[#339A05] hover:bg-[#2b8204] disabled:opacity-60 text-white font-bold text-sm shadow-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {isStarting ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Entering Live Interview Room...
              </>
            ) : (
              <>
                Join Live Interview Room
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </main>
    </div>
  );
};

// ============================================================================
// PAGE 2: INTERVIEW ROOM (/interview) — LUNA AI Style Live Voice Call
// ============================================================================
interface InterviewRoomPageProps {
  session: InterviewSessionRecord | null;
  initialMessage: string;
  liveWsAvailable: boolean;
  onSessionCompleted: (updatedSession: InterviewSessionRecord) => void;
}

const InterviewRoomPage: React.FC<InterviewRoomPageProps> = ({
  session: initialSession,
  initialMessage,
  liveWsAvailable,
  onSessionCompleted,
}) => {
  const navigate = useNavigate();

  const [session, setSession] = useState<InterviewSessionRecord | null>(
    initialSession,
  );
  const [speakerState, setSpeakerState] = useState<
    "interviewer" | "candidate" | "idle"
  >("idle");
  // Audio level is no longer displayed (no sound-wave visuals); kept as a no-op so the
  // audio pipeline does not re-render the page dozens of times per second.
  const setMicRms = useCallback((_level: number) => {}, []);
  const [questionSecondsLeft, setQuestionSecondsLeft] = useState<number>(90);
  const [liveCaption, setLiveCaption] = useState<string>(initialMessage || "");
  const [candidateSpokenBuffer, setCandidateSpokenBuffer] =
    useState<string>("");
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [isProcessingTurn, setIsProcessingTurn] = useState<boolean>(false);
  const [isInitializingCall, setIsInitializingCall] = useState<boolean>(true);
  const [isReconnectingVoice, setIsReconnectingVoice] =
    useState<boolean>(false);
  const [isScrutinizingCall, setIsScrutinizingCall] = useState<boolean>(false);
  const [usingGeminiLiveWs, setUsingGeminiLiveWs] = useState<boolean>(false);
  const [misconductBanner, setMisconductBanner] = useState<{
    pointsDeducted: number;
    totalPenaltyPoints: number;
    message: string;
  } | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const spokenAccumulatorRef = useRef<string>("");
  const interimSpeechRef = useRef<string>("");
  const isInterviewerSpeakingRef = useRef<boolean>(false);
  const isSubmittingTurnRef = useRef<boolean>(false);
  const liveTranscriptRef = useRef<TranscriptEntry[]>(
    initialSession?.transcript || [],
  );
  const sessionRef = useRef<InterviewSessionRecord | null>(initialSession);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const waveIntervalRef = useRef<number | null>(null);
  const safetySpeechTimerRef = useRef<number | null>(null);
  const initializedSessionIdRef = useRef<string | null>(null);
  // Single-voice guarantees: only one interviewer audio source may ever play.
  const liveModeRef = useRef<boolean>(false); // Gemini Live voice is active: never play TTS
  const speechGenerationRef = useRef<number>(0); // invalidates stale TTS requests
  const micReopenAtRef = useRef<number>(0); // ignore the mic briefly after Sarah stops (echo tail)
  const callEndingRef = useRef<boolean>(false); // call is over: mic closed, no new audio
  const lastLiveAudioAtRef = useRef<number>(0);
  const isMicMutedRef = useRef<boolean>(false);
  const liveAudioDoneRef = useRef<boolean>(false); // server: closing audio fully sent
  const liveCleanupRef = useRef<(() => void) | null>(null);

  // Silent background timers (90s per question + 10m total session) — hidden from UI per specification
  const questionSecondsRef = useRef<number>(90);
  const finalizeRequestedRef = useRef<boolean>(false);
  const sessionSecondsRef = useRef<number>(
    (() => {
      const max = initialSession?.maxDurationSeconds || 600;
      const startedAt = initialSession?.createdAt
        ? new Date(initialSession.createdAt).getTime()
        : Date.now();
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      // Resumed sessions continue with the time that is left (at least 30s to wrap up).
      return Math.max(30, max - elapsed);
    })(),
  );
  const sessionTimeoutTriggeredRef = useRef<boolean>(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Preload browser voices early as backup
  useEffect(() => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      const handleVoicesChanged = () => {
        window.speechSynthesis.getVoices();
      };
      window.speechSynthesis.addEventListener?.(
        "voiceschanged",
        handleVoicesChanged,
      );
      return () => {
        window.speechSynthesis.removeEventListener?.(
          "voiceschanged",
          handleVoicesChanged,
        );
      };
    }
  }, []);

  // Redirect to / if no session exists
  useEffect(() => {
    if (!initialSession) {
      navigate("/", { replace: true });
    }
  }, [initialSession, navigate]);

  const clearCurrentSpeechPlayback = useCallback(() => {
    // Any TTS request still loading must not start playing later (that caused two voices).
    speechGenerationRef.current += 1;
    if (waveIntervalRef.current) {
      clearInterval(waveIntervalRef.current);
      waveIntervalRef.current = null;
    }
    if (safetySpeechTimerRef.current) {
      clearTimeout(safetySpeechTimerRef.current);
      safetySpeechTimerRef.current = null;
    }
    if (ttsAudioRef.current) {
      try {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.src = "";
      } catch {
        // ignore
      }
      ttsAudioRef.current = null;
    }
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    activeUtteranceRef.current = null;
    isInterviewerSpeakingRef.current = false;
    setMicRms(0);
    setSpeakerState("idle");
  }, []);

  // Speak helper locked to Sarah's single NotebookLM female voice (/api/interviewer-tts)
  const speakInterviewerText = useCallback(
    (text: string, onDone?: () => void) => {
      const cleanText = String(text || "").trim();
      // In a Gemini Live call Sarah speaks only through the live stream, never through TTS,
      // and nothing is spoken any more once the call is over.
      if (!cleanText || liveModeRef.current || callEndingRef.current) {
        isInterviewerSpeakingRef.current = false;
        setSpeakerState("idle");
        onDone?.();
        return;
      }

      clearCurrentSpeechPlayback();
      const myGeneration = speechGenerationRef.current;
      const isStale = () => myGeneration !== speechGenerationRef.current;

      // Clear any residual mic noise picked up before the interviewer started speaking
      spokenAccumulatorRef.current = "";
      interimSpeechRef.current = "";

      isInterviewerSpeakingRef.current = true;
      setSpeakerState("interviewer");
      setLiveCaption(cleanText);

      let finished = false;
      const finishSpeaking = () => {
        if (finished) return;
        finished = true;
        if (isStale()) return; // a newer line (or a stop) already took over
        // Keep the mic closed a little longer so the tail of Sarah's voice from the
        // speakers is not recognised as the candidate speaking, and drop anything the
        // recogniser buffered while she was talking.
        micReopenAtRef.current = Date.now() + 900;
        spokenAccumulatorRef.current = "";
        interimSpeechRef.current = "";
        try {
          recognitionRef.current?.abort?.();
        } catch {
          // ignore (onend restarts recognition)
        }
        if (waveIntervalRef.current) {
          clearInterval(waveIntervalRef.current);
          waveIntervalRef.current = null;
        }
        if (safetySpeechTimerRef.current) {
          clearTimeout(safetySpeechTimerRef.current);
          safetySpeechTimerRef.current = null;
        }
        activeUtteranceRef.current = null;
        setMicRms(0);
        isInterviewerSpeakingRef.current = false;
        setSpeakerState("idle");
        onDone?.();
      };

      const speakWithBrowserSynthesis = () => {
        if (isStale() || finished) return;
        if (!("speechSynthesis" in window)) {
          finishSpeaking();
          return;
        }

        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }

        const utterance = new SpeechSynthesisUtterance(cleanText);
        activeUtteranceRef.current = utterance;

        const voices = window.speechSynthesis.getVoices();
        const englishVoices = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
        const femaleEnglishVoices = englishVoices.filter(
          (v) =>
            !/david|mark|alex|daniel|fred|george|james|richard|guy|christopher|eric|roger|steffan|ryan|male/i.test(
              v.name,
            ),
        );

        const matchedVoice =
          femaleEnglishVoices.find((v) =>
            SINGLE_INTERVIEWER_VOICE.voiceMatchRegex.test(v.name),
          ) ||
          femaleEnglishVoices[0] ||
          englishVoices[0] ||
          voices[0];

        if (matchedVoice) {
          utterance.voice = matchedVoice;
        }
        utterance.pitch = SINGLE_INTERVIEWER_VOICE.pitch;
        utterance.rate = SINGLE_INTERVIEWER_VOICE.rate;

        let tickCount = 0;
        waveIntervalRef.current = window.setInterval(() => {
          tickCount += 1;
          setMicRms(0.22 + Math.random() * 0.28);
          if (
            tickCount > 12 &&
            !window.speechSynthesis.speaking &&
            !window.speechSynthesis.pending
          ) {
            finishSpeaking();
          }
        }, 85);

        const wordCount = cleanText.split(/\s+/).length;
        const maxDurationMs = Math.max(
          4000,
          Math.min(30000, wordCount * 520 + 2500),
        );
        safetySpeechTimerRef.current = window.setTimeout(() => {
          finishSpeaking();
        }, maxDurationMs);

        utterance.onend = () => {
          finishSpeaking();
        };

        utterance.onerror = () => {
          finishSpeaking();
        };

        window.speechSynthesis.speak(utterance);
      };

      // Always fetch Sarah's single neural female voice from /api/interviewer-tts
      fetch("/api/interviewer-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: cleanText,
          voiceName: SINGLE_INTERVIEWER_VOICE.id,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (finished || isStale()) return;
          if (data && !data.fallback && data.audioBase64) {
            const audioSrc = `data:${data.mimeType || "audio/mpeg"};base64,${data.audioBase64}`;
            const audio = new Audio(audioSrc);
            ttsAudioRef.current = audio;

            waveIntervalRef.current = window.setInterval(() => {
              setMicRms(0.24 + Math.random() * 0.3);
            }, 85);

            audio.onended = () => {
              finishSpeaking();
            };
            audio.onerror = () => {
              speakWithBrowserSynthesis();
            };
            audio.play().catch(() => {
              speakWithBrowserSynthesis();
            });
          } else {
            speakWithBrowserSynthesis();
          }
        })
        .catch(() => {
          if (!finished && !isStale()) {
            speakWithBrowserSynthesis();
          }
        });
    },
    [clearCurrentSpeechPlayback],
  );

  // Submit a conversational turn in Continuous Voice Mode
  const submitVoiceTurn = useCallback(
    async (opts: {
      text?: string;
      timedOut?: boolean;
      sessionTimedOut?: boolean;
      requestedRephrase?: boolean;
    }) => {
      const currentSession = sessionRef.current;
      if (!currentSession || isSubmittingTurnRef.current) return;

      const combinedSpoken = (
        spokenAccumulatorRef.current +
        " " +
        interimSpeechRef.current
      )
        .replace(/\s+/g, " ")
        .trim();

      const textToSend = (
        opts.text !== undefined ? opts.text : combinedSpoken
      ).trim();
      if (
        !textToSend &&
        !opts.timedOut &&
        !opts.sessionTimedOut &&
        !opts.requestedRephrase
      )
        return;

      // Stop any ongoing interviewer speech before processing candidate's turn
      clearCurrentSpeechPlayback();

      isSubmittingTurnRef.current = true;
      setIsProcessingTurn(true);
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      spokenAccumulatorRef.current = "";
      interimSpeechRef.current = "";
      setCandidateSpokenBuffer("");

      try {
        const res = await fetch("/api/interview-turn", {
          method: "POST",
          headers: sessionHeaders(),
          body: JSON.stringify({
            sessionId: currentSession.id,
            candidateText: textToSend,
            timedOut: Boolean(opts.timedOut),
            sessionTimedOut: Boolean(opts.sessionTimedOut),
            requestedRephrase: Boolean(opts.requestedRephrase),
          }),
        });

        const data = await res.json();
        if (res.ok && data.session) {
          sessionRef.current = data.session;
          setSession(data.session);
          liveTranscriptRef.current = data.session.transcript;

          if (data.misconductWarning) {
            setMisconductBanner({
              pointsDeducted: data.misconductWarning.pointsDeducted || 3,
              totalPenaltyPoints:
                data.misconductWarning.totalPenaltyPoints || 3,
              message:
                "Professional Conduct Warning: -3 points deducted for inappropriate language. Repeating this will end the call and suspend your account for 24 hours.",
            });
          }

          if (data.resetQuestionTimer) {
            questionSecondsRef.current = 90;
          }

          if (data.interviewEnded) {
            speakInterviewerText(data.interviewerMessage, () => {
              setIsScrutinizingCall(true);
              window.setTimeout(() => {
                onSessionCompleted(data.session);
                navigate("/scoring");
              }, 1400);
            });
            return;
          }

          if (data.interviewerMessage) {
            speakInterviewerText(data.interviewerMessage, () => {
              // Ensure the candidate starts with a full 90 seconds AFTER Sarah finishes asking a question
              if (
                data.resetQuestionTimer ||
                data.session?.currentPhase === "questioning"
              ) {
                questionSecondsRef.current = 90;
              }
            });
          }
        }
      } catch (err) {
        console.warn("Turn error:", err);
      } finally {
        isSubmittingTurnRef.current = false;
        setIsProcessingTurn(false);
      }
    },
    [
      clearCurrentSpeechPlayback,
      speakInterviewerText,
      onSessionCompleted,
      navigate,
    ],
  );

  // Keep a stable ref to submitVoiceTurn for timers and speech recognition callbacks
  const submitVoiceTurnRef = useRef(submitVoiceTurn);
  useEffect(() => {
    submitVoiceTurnRef.current = submitVoiceTurn;
  }, [submitVoiceTurn]);

  // Coordinated Background Timers (90s Per-Question Response Timer + 10m Overall Session Timer)
  // Hidden from the UI to prevent visual distraction and coordinated so they never conflict.
  useEffect(() => {
    if (!session || session.currentPhase === "finished") return;

    const unifiedTimer = window.setInterval(() => {
      setQuestionSecondsLeft(Math.max(0, questionSecondsRef.current));
      const activeSess = sessionRef.current;
      if (
        !activeSess ||
        activeSess.currentPhase === "finished" ||
        sessionTimeoutTriggeredRef.current
      ) {
        return;
      }

      // 1. 10-Minute (600s) Overall Interview Session Timer
      sessionSecondsRef.current -= 1;
      if (liveModeRef.current) {
        // Live call: the server tells Sarah to close at 10:00 and ends the call itself.
        // This is only a safety net in case the connection to the server is lost.
        if (sessionSecondsRef.current <= -40 && !callEndingRef.current) {
          sessionTimeoutTriggeredRef.current = true;
          finalizeGeminiLiveCallRef.current?.(false, false);
        }
        if (sessionSecondsRef.current <= 0) return;
      } else if (sessionSecondsRef.current <= 0) {
        sessionTimeoutTriggeredRef.current = true;
        const currentSpoken = mergeSpeechChunksAccurately(
          spokenAccumulatorRef.current,
          interimSpeechRef.current,
        );
        submitVoiceTurnRef.current({
          text: currentSpoken,
          sessionTimedOut: true,
        });
        return;
      }

      // 2. 90-Second Per-Question Response Timer
      // Only counts down when in 'questioning' phase AND Sarah has finished speaking AND no turn is currently submitting
      if (
        activeSess.currentPhase === "questioning" &&
        !isInterviewerSpeakingRef.current &&
        !isSubmittingTurnRef.current &&
        !callEndingRef.current &&
        questionSecondsRef.current > 0
      ) {
        questionSecondsRef.current -= 1;
        if (questionSecondsRef.current <= 0) {
          const isLastQuestion =
            (activeSess.currentQuestionIndex || 0) >=
            (activeSess.questions?.length || 1) - 1;
          // Last question: the timer stays at 0:00 while Sarah closes the interview.
          // Otherwise it restarts for the next question (Sarah also resets it when she asks it).
          questionSecondsRef.current = liveModeRef.current && isLastQuestion ? 0 : 90;
          setQuestionSecondsLeft(questionSecondsRef.current);
          if (liveModeRef.current) {
            if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(
              JSON.stringify({
                type: "timer_expired",
                currentQuestionIndex: activeSess.currentQuestionIndex || 0,
              }),
            );
          } else {
            const currentSpoken = mergeSpeechChunksAccurately(
              spokenAccumulatorRef.current,
              interimSpeechRef.current,
            );
            submitVoiceTurnRef.current({
              text: currentSpoken,
              timedOut: true,
            });
          }
        }
      }
    }, 1000);

    return () => clearInterval(unifiedTimer);
  }, [session?.currentPhase, usingGeminiLiveWs]);

  // Immediately silence the live interviewer stream (queued audio chunks included).
  const stopLiveAudio = useCallback(() => {
    activeSourcesRef.current.forEach((s) => {
      try {
        s.onended = null;
        s.stop();
      } catch {
        // ignore
      }
    });
    activeSourcesRef.current = [];
    if (playbackCtxRef.current) {
      nextPlayTimeRef.current = playbackCtxRef.current.currentTime;
    }
    isInterviewerSpeakingRef.current = false;
    setSpeakerState("idle");
    setMicRms(0);
  }, []);

  // Finalize a Gemini Live WebSocket session and navigate to /scoring with AI Coach Scrutinizing screen
  const finalizeGeminiLiveCall = useCallback(
    async (terminatedByAttemptRule = false, terminatedByMisconduct = false) => {
      const currentSession = sessionRef.current;
      if (!currentSession) return;
      // Finalize only once per session: Gemini may emit end_call more than once and the
      // candidate may also click "End Call & Score" — each extra call used to trigger
      // another results email.
      if (finalizeRequestedRef.current) return;
      finalizeRequestedRef.current = true;
      // The call is over: close the mic path and silence the interviewer for good.
      callEndingRef.current = true;
      stopLiveAudio();
      clearCurrentSpeechPlayback();
      setIsProcessingTurn(true);
      setIsScrutinizingCall(true);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      try {
        const res = await fetch("/api/finalize-live-ws-session", {
          method: "POST",
          headers: sessionHeaders(),
          body: JSON.stringify({
            sessionId: currentSession.id,
            liveTranscript: liveTranscriptRef.current,
            terminatedByAttemptRule,
            terminatedByMisconduct,
          }),
        });
        const data = await res.json();
        if (res.ok && data.session) {
          window.setTimeout(() => {
            onSessionCompleted(data.session);
            navigate("/scoring");
          }, 1200);
          return;
        }
      } catch (e) {
        console.warn("Finalize live session error:", e);
        setIsScrutinizingCall(false);
        finalizeRequestedRef.current = false; // allow a manual retry after a network failure
      } finally {
        setIsProcessingTurn(false);
      }
    },
    [clearCurrentSpeechPlayback, stopLiveAudio, onSessionCompleted, navigate],
  );
  const finalizeGeminiLiveCallRef = useRef(finalizeGeminiLiveCall);
  useEffect(() => {
    finalizeGeminiLiveCallRef.current = finalizeGeminiLiveCall;
  }, [finalizeGeminiLiveCall]);

  // Initialize Camera, 16kHz AudioWorklet Mic Engine, and Live Voice Connection ONCE per session
  useEffect(() => {
    if (!initialSession) return;
    if (initializedSessionIdRef.current === initialSession.id) return;
    initializedSessionIdRef.current = initialSession.id;

    let isUnmounted = false;

    const startContinuousSpeechLoop = () => {
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) return;

      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        if (
          isInterviewerSpeakingRef.current ||
          isSubmittingTurnRef.current ||
          callEndingRef.current ||
          Date.now() < micReopenAtRef.current
        )
          return;

        let interim = "";
        let finalChunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const bestAlternative = event.results[i][0];
          const transcriptPiece = bestAlternative
            ? String(bestAlternative.transcript || "")
            : "";
          if (event.results[i].isFinal) {
            finalChunk = mergeSpeechChunksAccurately(
              finalChunk,
              transcriptPiece,
            );
          } else {
            interim = mergeSpeechChunksAccurately(interim, transcriptPiece);
          }
        }

        if (finalChunk.trim()) {
          spokenAccumulatorRef.current = mergeSpeechChunksAccurately(
            spokenAccumulatorRef.current,
            finalChunk,
          );
        }
        interimSpeechRef.current = interim.trim();

        const combinedLive = mergeSpeechChunksAccurately(
          spokenAccumulatorRef.current,
          interimSpeechRef.current,
        );

        if (combinedLive) {
          setCandidateSpokenBuffer(combinedLive);
          setSpeakerState("candidate");

          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }

          const currentPhase =
            sessionRef.current?.currentPhase || "greeting_how_are_you";
          const wordCount = combinedLive
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;
          const isExplicitQuestionOrDontKnow =
            /\b(i\s+don'?t\s+know|not\s+sure|no\s+idea|rephrase|repeat|can\s+you\s+repeat)\b/i.test(
              combinedLive,
            );

          // In 'questioning' phase, let the candidate speak comfortably up to the full 90 seconds!
          // Do NOT cut them off on 1-3 second thinking pauses. Only auto-submit after a 4.5s pause
          // if they have already spoken a substantial answer (>= 16 words) or explicitly asked to rephrase/don't know.
          const pauseMs =
            currentPhase === "questioning"
              ? isExplicitQuestionOrDontKnow
                ? 2400
                : wordCount >= 16
                  ? 4500
                  : 0 // 0 means wait for more speech or the 90s timer / manual Done Speaking button
              : 2400;

          if (pauseMs > 0) {
            silenceTimerRef.current = window.setTimeout(() => {
              const fullAnswerToSend = mergeSpeechChunksAccurately(
                spokenAccumulatorRef.current,
                interimSpeechRef.current,
              );

              if (
                fullAnswerToSend.length >= 2 &&
                !isInterviewerSpeakingRef.current &&
                !isSubmittingTurnRef.current
              ) {
                submitVoiceTurnRef.current({ text: fullAnswerToSend });
              }
            }, pauseMs);
          }
        }
      };

      recognition.onend = () => {
        if (!isUnmounted) {
          try {
            recognition.start();
          } catch {
            // ignore
          }
        }
      };

      try {
        recognition.start();
        recognitionRef.current = recognition;
      } catch {
        // ignore
      }
    };

    const setupMediaAndVoice = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false, // voice-only interview: no camera
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        if (isUnmounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        mediaStreamRef.current = stream;

        // Set up 16kHz AudioWorkletProcessor (LUNA v2 MicProcessor)
        const audioCtx = new (
          window.AudioContext || (window as any).webkitAudioContext
        )({
          sampleRate: 16000,
        });
        audioCtxRef.current = audioCtx;

        const workletCode = `
          class LunaMicProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this.bufferSize = 2048;
              this.buffer = new Float32Array(this.bufferSize);
              this.offset = 0;
            }
            process(inputs) {
              const input = inputs[0];
              if (input && input.length > 0) {
                const channel = input[0];
                for (let i = 0; i < channel.length; i++) {
                  this.buffer[this.offset++] = channel[i];
                  if (this.offset >= this.bufferSize) {
                    let sum = 0;
                    const pcm16 = new Int16Array(this.bufferSize);
                    for (let j = 0; j < this.bufferSize; j++) {
                      const s = Math.max(-1, Math.min(1, this.buffer[j]));
                      sum += s * s;
                      pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    const rms = Math.sqrt(sum / this.bufferSize);
                    this.port.postMessage({ pcm: pcm16.buffer, rms }, [pcm16.buffer]);
                    this.offset = 0;
                  }
                }
              }
              return true;
            }
          }
          registerProcessor('luna-mic-processor', LunaMicProcessor);
        `;

        const blob = new Blob([workletCode], {
          type: "application/javascript",
        });
        const workletUrl = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        const source = audioCtx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(
          audioCtx,
          "luna-mic-processor",
        );
        source.connect(workletNode);

        workletNode.port.onmessage = (event) => {
          if (isUnmounted) return;
          const { pcm, rms } = event.data;

          // ECHO GATE: while Sarah's voice is coming out of the speakers (plus a short tail),
          // the microphone is NOT passed to the interviewer. Otherwise the agent hears its own
          // voice, takes it for the candidate and starts answering itself (the "second voice").
          // The tail is kept short (browser echo cancellation is on): a longer one swallowed
          // quick replies like "yes" or "sorry?" and Sarah never answered them.
          const playCtx = playbackCtxRef.current;
          const interviewerAudible =
            isInterviewerSpeakingRef.current ||
            activeSourcesRef.current.length > 0 ||
            (playCtx ? playCtx.currentTime < nextPlayTimeRef.current + 0.25 : false);

          if (!isInterviewerSpeakingRef.current && !interviewerAudible) {
            setMicRms(rms);
            if (rms > 0.022) {
              setSpeakerState("candidate");
            } else {
              setSpeakerState((prev) =>
                prev === "candidate" &&
                !spokenAccumulatorRef.current &&
                !interimSpeechRef.current
                  ? "idle"
                  : prev,
              );
            }
          }

          // Stream 16-bit PCM audio frames to /api/live-ws if connected
          if (
            wsRef.current &&
            wsRef.current.readyState === WebSocket.OPEN &&
            liveModeRef.current &&
            !callEndingRef.current &&
            !isMicMutedRef.current
          ) {
            // Silence (zeros) keeps the stream timing steady while the gate is closed.
            const bytes = interviewerAudible
              ? new Uint8Array((pcm as ArrayBuffer).byteLength)
              : new Uint8Array(pcm);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64Audio = window.btoa(binary);
            wsRef.current.send(
              JSON.stringify({
                realtimeInput: {
                  audio: {
                    mimeType: "audio/pcm;rate=16000",
                    data: base64Audio,
                  },
                },
              }),
            );
          }
        };
      } catch (mediaErr) {
        console.warn("Media permission warning:", mediaErr);
      }

      // Connect to LUNA v2 Gemini Live WebSocket (/api/live-ws) if available, otherwise start continuous voice loop
      let liveConnectedOnce = false;
      let fallbackStarted = false;
      let reconnectAttempts = 0;
      let reconnectTimer: number | null = null;

      const startTextVoiceFallback = () => {
        // Only used when the live voice never connected: one voice (TTS) for the whole call.
        if (fallbackStarted || isUnmounted || liveConnectedOnce) return;
        fallbackStarted = true;
        liveModeRef.current = false;
        setUsingGeminiLiveWs(false);
        setIsInitializingCall(false);
        setIsReconnectingVoice(false);
        startContinuousSpeechLoop();
        speakInterviewerText(initialMessage);
      };

      /** End of call: let the closing sentence already received finish, then finalize. */
      const finishAfterClosingAudio = (
        terminatedByAttempts: boolean,
        terminatedByMisconduct: boolean,
      ) => {
        if (callEndingRef.current && finalizeRequestedRef.current) return;
        callEndingRef.current = true; // mic is no longer sent from now on
        const startedAt = Date.now();
        const poll = window.setInterval(() => {
          const ctx = playbackCtxRef.current;
          const queueDone =
            activeSourcesRef.current.length === 0 &&
            (!ctx || ctx.currentTime >= nextPlayTimeRef.current);
          const quietFor = Date.now() - lastLiveAudioAtRef.current;
          if (
            isUnmounted ||
            (queueDone && (liveAudioDoneRef.current || quietFor > 1500)) ||
            Date.now() - startedAt > 15000
          ) {
            window.clearInterval(poll);
            if (!isUnmounted) {
              finalizeGeminiLiveCallRef.current(terminatedByAttempts, terminatedByMisconduct);
            }
          }
        }, 200);
      };

      const scheduleReconnect = () => {
        if (isUnmounted || callEndingRef.current || finalizeRequestedRef.current) return;
        if (reconnectTimer) return;
        stopLiveAudio();
        if (reconnectAttempts >= 3) {
          // Could not get the interviewer back: score what was answered so far.
          setIsReconnectingVoice(false);
          finalizeGeminiLiveCallRef.current(false, false);
          return;
        }
        reconnectAttempts += 1;
        setIsReconnectingVoice(true);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectLiveVoice(true);
        }, 800 * reconnectAttempts);
      };

      const connectLiveVoice = (isReconnect: boolean) => {
        if (isUnmounted || callEndingRef.current) return;
        // Never keep two sockets (= two interviewer voices) open at once.
        const previous = wsRef.current;
        if (previous) {
          previous.onmessage = null;
          previous.onerror = null;
          previous.onclose = null;
          try {
            previous.close();
          } catch {
            // ignore
          }
        }

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/api/live-ws?sessionId=${encodeURIComponent(
          initialSession.id,
        )}&token=${encodeURIComponent(currentSessionToken)}${isReconnect ? "&reconnect=1" : ""}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        let socketHandled = false;

        if (!playbackCtxRef.current) {
          const playCtx = new (
            window.AudioContext || (window as any).webkitAudioContext
          )({
            sampleRate: 24000,
          });
          playbackCtxRef.current = playCtx;
          nextPlayTimeRef.current = playCtx.currentTime;
        }

        const onSocketLost = () => {
          if (socketHandled || ws !== wsRef.current) return;
          socketHandled = true;
          if (isUnmounted || callEndingRef.current || finalizeRequestedRef.current) return;
          if (liveConnectedOnce) scheduleReconnect();
          else startTextVoiceFallback();
        };

        ws.onmessage = (evt) => {
          if (isUnmounted || ws !== wsRef.current) return;
          try {
            const msg = JSON.parse(evt.data);

            if (msg.type === "connected") {
              liveConnectedOnce = true;
              reconnectAttempts = 0;
              liveModeRef.current = true;
              // Make sure no TTS voice from the fallback path is playing.
              clearCurrentSpeechPlayback();
              try {
                recognitionRef.current?.stop();
              } catch {
                // ignore
              }
              setUsingGeminiLiveWs(true);
              setIsInitializingCall(false);
              setIsReconnectingVoice(false);
              return;
            }

            if (msg.type === "fallback_required" || msg.type === "live_dropped") {
              onSocketLost();
              return;
            }

            if (msg.type === "interviewer_audio_done") {
              liveAudioDoneRef.current = true;
              return;
            }

            if (msg.type === "question_advanced") {
              const total = Math.max(
                1,
                Number(msg.totalQuestions) ||
                  sessionRef.current?.questions?.length ||
                  4,
              );
              const qIdx = Math.max(
                0,
                Math.min(total - 1, Number(msg.questionNumber) - 1),
              );
              questionSecondsRef.current = 90;
              setSession((prev) => {
                if (!prev) return prev;
                const updated: InterviewSessionRecord = {
                  ...prev,
                  currentPhase: "questioning",
                  currentQuestionIndex: qIdx,
                };
                sessionRef.current = updated;
                return updated;
              });
              return;
            }

            if (msg.type === "misconduct_warning") {
              const penaltyPts = Number(msg.totalPenaltyPoints || 3);
              setMisconductBanner({
                pointsDeducted: Number(msg.pointsDeducted || 3),
                totalPenaltyPoints: penaltyPts,
                message:
                  "Professional Conduct Warning: -3 points deducted for inappropriate language. Repeating this will end the call and suspend your account for 24 hours.",
              });
              setSession((prev) => {
                if (!prev) return prev;
                const updated: InterviewSessionRecord = {
                  ...prev,
                  misconductPenaltyPoints: penaltyPts,
                };
                sessionRef.current = updated;
                return updated;
              });
              return;
            }

            if (msg.type === "end_call_triggered") {
              const terminatedByAttempts =
                msg.reason === "terminated_after_two_attempts";
              const terminatedByMisconduct =
                msg.reason === "terminated_misconduct";
              if (terminatedByMisconduct) {
                setMisconductBanner({
                  pointsDeducted: 20,
                  totalPenaltyPoints: 20,
                  message:
                    "Interview terminated due to professional misconduct. Your account is suspended from interview attempts for the next 24 hours.",
                });
              }
              finishAfterClosingAudio(terminatedByAttempts, terminatedByMisconduct);
              return;
            }

            // Handle Gemini Live serverContent (24kHz audio chunks, barge-in interruption, transcriptions)
            const serverContent = msg.serverContent;
            if (!serverContent) return;

            if (serverContent.interrupted) {
              activeSourcesRef.current.forEach((s) => {
                try {
                  s.stop();
                } catch {
                  // ignore
                }
              });
              activeSourcesRef.current = [];
              if (playbackCtxRef.current) {
                nextPlayTimeRef.current = playbackCtxRef.current.currentTime;
              }
              isInterviewerSpeakingRef.current = false;
              setSpeakerState("idle");
            }

            const parts = serverContent.modelTurn?.parts;
            if (
              Array.isArray(parts) &&
              playbackCtxRef.current &&
              !finalizeRequestedRef.current
            ) {
              for (const part of parts) {
                const b64 = part.inlineData?.data;
                if (b64) {
                  const binaryStr = window.atob(b64);
                  const len = binaryStr.length;
                  const bytes = new Uint8Array(len);
                  for (let i = 0; i < len; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                  }
                  const int16 = new Int16Array(bytes.buffer);
                  const float32 = new Float32Array(int16.length);
                  let chunkSum = 0;
                  for (let i = 0; i < int16.length; i++) {
                    const sample = int16[i] / 32768;
                    float32[i] = sample;
                    chunkSum += sample * sample;
                  }
                  const chunkRms = Math.sqrt(
                    chunkSum / Math.max(1, int16.length),
                  );
                  setMicRms(chunkRms * 1.6);
                  isInterviewerSpeakingRef.current = true;
                  setSpeakerState("interviewer");

                  const ctx = playbackCtxRef.current;
                  const audioBuffer = ctx.createBuffer(
                    1,
                    float32.length,
                    24000,
                  );
                  audioBuffer.getChannelData(0).set(float32);

                  const bufSource = ctx.createBufferSource();
                  bufSource.buffer = audioBuffer;
                  bufSource.connect(ctx.destination);

                  const startAt = Math.max(
                    nextPlayTimeRef.current,
                    ctx.currentTime,
                  );
                  bufSource.start(startAt);
                  lastLiveAudioAtRef.current = Date.now();
                  nextPlayTimeRef.current = startAt + audioBuffer.duration;
                  activeSourcesRef.current.push(bufSource);

                  bufSource.onended = () => {
                    activeSourcesRef.current = activeSourcesRef.current.filter(
                      (s) => s !== bufSource,
                    );
                    if (activeSourcesRef.current.length === 0) {
                      isInterviewerSpeakingRef.current = false;
                      setSpeakerState("idle");
                      setMicRms(0);
                    }
                  };
                }
              }
            }

            // Live output transcription (Interviewer voice captions)
            if (serverContent.outputTranscription?.text) {
              const chunk = serverContent.outputTranscription.text;
              setLiveCaption((prev) => {
                const updated = (prev + " " + chunk)
                  .replace(/\s+/g, " ")
                  .trim();
                return updated.slice(-280);
              });
              const list = liveTranscriptRef.current;
              const last = list[list.length - 1];
              if (last && last.speaker === "interviewer") {
                last.text = (last.text + " " + chunk)
                  .replace(/\s+/g, " ")
                  .trim();
              } else {
                list.push({
                  id: `tr_${Date.now()}_i`,
                  speaker: "interviewer",
                  speakerName: "Sarah (Global Hire 360 Hiring Manager)",
                  text: chunk.trim(),
                  timestamp: new Date().toISOString(),
                });
              }
            }

            // Live input transcription (Candidate voice captions)
            if (serverContent.inputTranscription?.text) {
              const chunk = serverContent.inputTranscription.text;
              setCandidateSpokenBuffer((prev) =>
                mergeSpeechChunksAccurately(prev, chunk),
              );
              const list = liveTranscriptRef.current;
              const last = list[list.length - 1];
              if (last && last.speaker === "candidate") {
                last.text = mergeSpeechChunksAccurately(last.text, chunk);
              } else {
                list.push({
                  id: `tr_${Date.now()}_c`,
                  speaker: "candidate",
                  speakerName: initialSession.candidateName,
                  text: chunk.trim(),
                  timestamp: new Date().toISOString(),
                });
              }
            }
          } catch (err) {
            console.warn("WS message parse warning:", err);
          }
        };

        ws.onerror = onSocketLost;
        ws.onclose = onSocketLost;
      };

      if (liveWsAvailable) {
        connectLiveVoice(false);
      } else {
        setIsInitializingCall(false);
        startContinuousSpeechLoop();
        speakInterviewerText(initialMessage);
      }

      liveCleanupRef.current = () => {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
      };
    };

    setupMediaAndVoice();

    return () => {
      isUnmounted = true;
      initializedSessionIdRef.current = null;
      liveCleanupRef.current?.();
      liveModeRef.current = false;
      stopLiveAudio();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      clearCurrentSpeechPlayback();
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      try {
        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.close();
        }
      } catch {
        // ignore
      }
      try {
        audioCtxRef.current?.close();
      } catch {
        // ignore
      }
      try {
        playbackCtxRef.current?.close();
      } catch {
        // ignore
      }
      playbackCtxRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // Only run once when entering the interview room for this session ID
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession?.id]);

  const toggleMic = () => {
    if (!mediaStreamRef.current) return;
    const audioTracks = mediaStreamRef.current.getAudioTracks();
    audioTracks.forEach((track) => {
      track.enabled = isMicMuted;
    });
    isMicMutedRef.current = !isMicMuted;
    setIsMicMuted(!isMicMuted);
  };

  if (!session) return null;

  // Short transition screen while the answers are being marked
  if (isScrutinizingCall) {
    return (
      <div className="min-h-screen bg-[#041E41] text-white flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-14 h-14 rounded-full border-4 border-[#339A05]/30 border-t-[#339A05] animate-spin mb-6" />
        <h2 className="text-xl font-bold">Interview complete</h2>
        <p className="text-sm text-slate-300 mt-2">Marking your answers…</p>
      </div>
    );
  }

  const totalQuestions = session.questions?.length || 4;
  const isQuestioning = session.currentPhase === "questioning";
  const sarahSpeaking = speakerState === "interviewer";
  const timerNotStarted = isQuestioning && sarahSpeaking && questionSecondsLeft >= 90;
  const timerLow = questionSecondsLeft <= 15;
  const timerText = `${Math.floor(questionSecondsLeft / 60)}:${String(
    questionSecondsLeft % 60,
  ).padStart(2, "0")}`;

  const statusText = isInitializingCall
    ? "Connecting to Sarah…"
    : isReconnectingVoice
      ? "Reconnecting…"
      : isMicMuted
        ? "Your microphone is muted"
        : sarahSpeaking
          ? "Sarah is speaking…"
          : isQuestioning
            ? "Your turn — answer when you're ready"
            : "Listening…";

  return (
    <div className="min-h-screen bg-[#041E41] text-white flex flex-col">
      {/* Minimal header */}
      <header className="px-6 py-4 flex items-center justify-between">
        <div className="bg-white rounded-lg px-2.5 py-1">
          <img
            src={LOGO_URL}
            alt="Global Hire 360"
            referrerPolicy="no-referrer"
            className="h-6 w-auto object-contain"
          />
        </div>
        <span className="text-xs font-semibold text-slate-300">
          {session.detectedRole} interview
        </span>
      </header>

      {/* Agent profile */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        {misconductBanner && (
          <div className="mb-8 max-w-md w-full px-4 py-3 rounded-xl bg-red-950/80 border border-red-500/60 text-red-100 text-xs font-semibold flex items-center gap-2.5 text-left">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{misconductBanner.message}</span>
          </div>
        )}

        <div
          className={`w-40 h-40 rounded-full bg-gradient-to-br from-[#339A05] to-[#1f5f03] flex items-center justify-center text-6xl font-extrabold shadow-2xl border-4 transition-colors duration-300 ${
            sarahSpeaking ? "border-white" : "border-white/15"
          }`}
          aria-hidden="true"
        >
          S
        </div>
        <h1 className="mt-6 text-2xl font-bold">Sarah</h1>
        <p className="text-sm text-slate-300">
          Operations &amp; Talent Manager · Global Hire 360
        </p>

        <p
          className={`mt-6 text-sm font-medium ${
            isMicMuted ? "text-amber-300" : "text-slate-200"
          }`}
          aria-live="polite"
        >
          {statusText}
        </p>

        {/* 90-second question timer — appears once the questions start */}
        {isQuestioning && (
          <div className="mt-8 w-full max-w-xs">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              Question {Math.min(totalQuestions, session.currentQuestionIndex + 1)} of{" "}
              {totalQuestions}
            </div>
            <div
              className={`mt-2 text-5xl font-extrabold tabular-nums ${
                timerLow ? "text-red-400" : "text-white"
              }`}
            >
              {timerText}
            </div>
            <div className="mt-3 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ease-linear ${
                  timerLow ? "bg-red-500" : "bg-[#339A05]"
                }`}
                style={{ width: `${(questionSecondsLeft / 90) * 100}%` }}
              />
            </div>
            {timerNotStarted && (
              <div className="mt-2 text-xs text-slate-400">
                Starts when Sarah finishes the question
              </div>
            )}
          </div>
        )}

        {/* Fallback (no live voice) only: send the answer manually */}
        {!usingGeminiLiveWs && !isInitializingCall && (
          <button
            type="button"
            onClick={() => {
              const spoken = mergeSpeechChunksAccurately(
                spokenAccumulatorRef.current,
                interimSpeechRef.current,
              );
              if (spoken) submitVoiceTurn({ text: spoken });
            }}
            disabled={isProcessingTurn || sarahSpeaking}
            className="mt-8 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 border border-white/15 text-xs font-bold cursor-pointer"
          >
            <Check className="w-4 h-4 text-[#339A05]" />
            {isProcessingTurn ? "Processing…" : "I'm done answering"}
          </button>
        )}
      </main>

      {/* Call controls */}
      <footer className="px-6 py-8 flex items-center justify-center gap-5">
        <button
          type="button"
          onClick={toggleMic}
          aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
          title={isMicMuted ? "Unmute" : "Mute"}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
            isMicMuted
              ? "bg-amber-500 text-white"
              : "bg-white/10 hover:bg-white/20 text-white border border-white/15"
          }`}
        >
          {isMicMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>
        <button
          type="button"
          onClick={() => finalizeGeminiLiveCall(false)}
          disabled={isProcessingTurn && !usingGeminiLiveWs}
          aria-label="End call"
          title="End call"
          className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 text-white flex items-center justify-center shadow-lg shadow-red-600/30 transition-colors cursor-pointer"
        >
          <PhoneOff className="w-7 h-7" />
        </button>
      </footer>
    </div>
  );
};


// ============================================================================
// CHAT-BUBBLE PDF GENERATOR (Generates a valid binary .PDF with chat bubbles)
// ============================================================================
function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [""];
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function buildMultiPagePdfFromJpegDataUrls(
  jpegDataUrls: string[],
  pageWidthPt = 595.28,
  pageHeightPt = 841.89,
  pixelWidth = 1190,
  pixelHeight = 1684,
): Uint8Array {
  const jpegBytesList = jpegDataUrls.map((dataUrl) => {
    const base64 = dataUrl.split(",")[1] || "";
    const bin = window.atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      arr[i] = bin.charCodeAt(i);
    }
    return arr;
  });

  const numPages = jpegBytesList.length;
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // For page i (0..numPages-1):
  //   Page object = 3 + i * 3
  //   Content stream = 4 + i * 3
  //   Image XObject = 5 + i * 3
  const totalObjects = 2 + numPages * 3;
  const chunks: Uint8Array[] = [];
  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  let currentOffset = 0;

  const encoder = new TextEncoder();
  const pushStr = (s: string) => {
    const bytes = encoder.encode(s);
    chunks.push(bytes);
    currentOffset += bytes.byteLength;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    currentOffset += b.byteLength;
  };

  pushStr("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");

  // 1: Catalog
  offsets[1] = currentOffset;
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // 2: Pages
  const kidsRefs = Array.from(
    { length: numPages },
    (_, i) => `${3 + i * 3} 0 R`,
  ).join(" ");
  offsets[2] = currentOffset;
  pushStr(
    `2 0 obj\n<< /Type /Pages /Kids [ ${kidsRefs} ] /Count ${numPages} >>\nendobj\n`,
  );

  for (let i = 0; i < numPages; i++) {
    const pageObjId = 3 + i * 3;
    const contentObjId = 4 + i * 3;
    const imgObjId = 5 + i * 3;
    const jpegBytes = jpegBytesList[i];

    // Page object
    offsets[pageObjId] = currentOffset;
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${pageWidthPt.toFixed(
        2,
      )} ${pageHeightPt.toFixed(
        2,
      )} ] /Resources << /XObject << /Im${i} ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );

    // Content stream drawing the full-page image
    const contentStream = `q\n${pageWidthPt.toFixed(2)} 0 0 ${pageHeightPt.toFixed(
      2,
    )} 0 0 cm\n/Im${i} Do\nQ\n`;
    offsets[contentObjId] = currentOffset;
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`,
    );

    // Image XObject
    offsets[imgObjId] = currentOffset;
    pushStr(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`,
    );
    pushBytes(jpegBytes);
    pushStr("\nendstream\nendobj\n");
  }

  const xrefOffset = currentOffset;
  pushStr(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);
  for (let objId = 1; objId <= totalObjects; objId++) {
    pushStr(`${String(offsets[objId]).padStart(10, "0")} 00000 n \n`);
  }
  pushStr(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const output = new Uint8Array(currentOffset);
  let pos = 0;
  for (const chunk of chunks) {
    output.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return output;
}

function generateChatBubbleTranscriptPdf(
  session: InterviewSessionRecord,
): void {
  const PAGE_W = 1190;
  const PAGE_H = 1684;
  const MARGIN_X = 72;
  const MAX_BUBBLE_W = 780;

  const canvases: HTMLCanvasElement[] = [];
  const createPageCanvas = (pageIndex: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = PAGE_W;
    canvas.height = PAGE_H;
    const ctx = canvas.getContext("2d")!;

    // Page background
    ctx.fillStyle = "#F8FAFC";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    // Header Banner on Page 1, compact header on subsequent pages
    if (pageIndex === 0) {
      ctx.fillStyle = "#041E41";
      ctx.fillRect(0, 0, PAGE_W, 195);
      ctx.fillStyle = "#339A05";
      ctx.fillRect(0, 195, PAGE_W, 8);

      ctx.fillStyle = "#86EFAC";
      ctx.font = "bold 20px Inter, Arial, sans-serif";
      ctx.fillText(
        "GLOBAL HIRE 360 • INTERVIEW CONVERSATION TRANSCRIPT",
        MARGIN_X,
        58,
      );

      ctx.fillStyle = "#FFFFFF";
      ctx.font = "bold 34px Inter, Arial, sans-serif";
      ctx.fillText(
        `${session.candidateName} — ${session.detectedRole}`,
        MARGIN_X,
        108,
      );

      ctx.fillStyle = "#CBD5E1";
      ctx.font = "600 22px Inter, Arial, sans-serif";
      ctx.fillText(
        `Final Score: ${session.totalScoreOutOf20 ?? session.totalScoreOutOf25} / ${session.maxScore || 20} (${session.percentageScore}%) • ${
          session.successful ? "PASSED" : "PRACTICE RECOMMENDED"
        }`,
        MARGIN_X,
        152,
      );
    } else {
      ctx.fillStyle = "#041E41";
      ctx.fillRect(0, 0, PAGE_W, 92);
      ctx.fillStyle = "#339A05";
      ctx.fillRect(0, 92, PAGE_W, 5);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "bold 22px Inter, Arial, sans-serif";
      ctx.fillText(
        `Global Hire 360 Chat Transcript — ${session.candidateName} (Page ${pageIndex + 1})`,
        MARGIN_X,
        56,
      );
    }

    canvases.push(canvas);
    return { canvas, ctx, startY: pageIndex === 0 ? 245 : 135 };
  };

  let currentPageIndex = 0;
  let { ctx, startY: cursorY } = createPageCanvas(0);

  for (const item of session.transcript) {
    const isInterviewer = item.speaker === "interviewer";
    const speakerLabel = isInterviewer
      ? "Sarah (Global Hire 360 Hiring Manager)"
      : `${session.candidateName} (Candidate)`;
    const timeLabel = new Date(item.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    ctx.font = "400 23px Inter, Arial, sans-serif";
    const textLines = wrapCanvasLines(ctx, item.text, MAX_BUBBLE_W - 56);
    const lineHeight = 33;
    const bubbleHeight = 64 + textLines.length * lineHeight + 22;

    if (cursorY + bubbleHeight > PAGE_H - 90) {
      currentPageIndex += 1;
      const nextPage = createPageCanvas(currentPageIndex);
      ctx = nextPage.ctx;
      cursorY = nextPage.startY;
    }

    const bubbleX = isInterviewer ? MARGIN_X : PAGE_W - MARGIN_X - MAX_BUBBLE_W;

    // Draw Chat Bubble Box
    drawRoundedRect(ctx, bubbleX, cursorY, MAX_BUBBLE_W, bubbleHeight, 22);
    ctx.fillStyle = isInterviewer ? "#FFFFFF" : "#EBF7E3";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = isInterviewer ? "#CBD5E1" : "#339A05";
    ctx.stroke();

    // Speaker Name & Timestamp inside Bubble Header
    ctx.font = "bold 20px Inter, Arial, sans-serif";
    ctx.fillStyle = isInterviewer ? "#041E41" : "#1E6B03";
    ctx.fillText(speakerLabel, bubbleX + 28, cursorY + 38);

    ctx.font = "400 18px Inter, Arial, sans-serif";
    ctx.fillStyle = "#64748B";
    const timeWidth = ctx.measureText(timeLabel).width;
    ctx.fillText(
      timeLabel,
      bubbleX + MAX_BUBBLE_W - 28 - timeWidth,
      cursorY + 38,
    );

    // Spoken Text Lines
    ctx.font = "400 23px Inter, Arial, sans-serif";
    ctx.fillStyle = "#0F172A";
    textLines.forEach((line, i) => {
      ctx.fillText(line, bubbleX + 28, cursorY + 76 + i * lineHeight);
    });

    cursorY += bubbleHeight + 26;
  }

  // Footer on each page
  canvases.forEach((c, idx) => {
    const fCtx = c.getContext("2d")!;
    fCtx.fillStyle = "#64748B";
    fCtx.font = "500 18px Inter, Arial, sans-serif";
    fCtx.fillText(
      `Global Hire 360 • Live Voice AI Interview Transcript • Page ${idx + 1} of ${canvases.length}`,
      MARGIN_X,
      PAGE_H - 36,
    );
  });

  const jpegUrls = canvases.map((c) => c.toDataURL("image/jpeg", 0.92));
  const pdfBytes = buildMultiPagePdfFromJpegDataUrls(jpegUrls);
  const blob = new Blob([pdfBytes as unknown as BlobPart], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `GlobalHire360_Transcript_${session.candidateName.replace(/\s+/g, "_")}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// PAGE 3: SCORING PAGE (/scoring) — Short, Simple & Executive B2B Layout
// 1. Final Score First
// 2. Mark Attributed to Each Question + Suggested Answer
// 3. Chat-Bubble Conversation Transcript + Download Transcript in PDF
// ============================================================================
interface ScoringPageProps {
  session: InterviewSessionRecord | null;
  onStartNewSession: () => void;
}

const ScoringPage: React.FC<ScoringPageProps> = ({
  session,
  onStartNewSession,
}) => {
  const navigate = useNavigate();
  const [emailNote, setEmailNote] = useState<string>(
    session?.emailDeliveryNote || "",
  );

  useEffect(() => {
    if (!session) {
      navigate("/", { replace: true });
    } else {
      // The interview is over: nothing left to resume on this device.
      if (session.currentPhase === "finished") clearActiveSessionAuth();
      // The results email is sent once, automatically, when the interview ends.
      setEmailNote(
        session.emailDeliveryNote ||
          (session.emailSent
            ? `Your results were emailed to ${session.candidateEmail}.`
            : `Your results will be emailed to ${session.candidateEmail}.`),
      );
    }
  }, [session, navigate]);

  const uniqueQuestionEvaluations = React.useMemo(() => {
    if (!session?.questionEvaluations) return [];
    const map = new Map<number, QuestionEvaluation>();
    for (const q of session.questionEvaluations) {
      map.set(q.questionNumber, q);
    }
    return Array.from(map.values()).sort(
      (a, b) => a.questionNumber - b.questionNumber,
    );
  }, [session]);

  if (!session) return null;

  const candidateAvatarUrl = findCandidateProfilePicture(
    session.candidateEmail,
    session.candidateName,
    session.candidateGoogleAvatarUrl,
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 pb-14">
      {/* Clean Executive Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={LOGO_URL}
              alt="Global Hire 360"
              referrerPolicy="no-referrer"
              className="h-10 w-auto object-contain"
            />
            <div>
              <span className="block text-sm font-extrabold text-[#041E41]">
                Interview Scorecard
              </span>
              <span className="block text-xs text-slate-500">
                {session.candidateName} &bull; {session.detectedRole}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              onStartNewSession();
              navigate("/");
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#339A05] hover:bg-[#2b8204] text-white text-xs font-bold transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Retake Practice Interview
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 pt-7 space-y-6">
        {/* 1. FINAL SCORE FIRST */}
        <section className="bg-[#041E41] text-white rounded-2xl p-6 sm:p-7 shadow-sm border-b-4 border-[#339A05]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
            <div className="space-y-2">
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-extrabold uppercase tracking-wider ${
                  session.successful
                    ? "bg-[#339A05] text-white"
                    : "bg-amber-500 text-slate-950"
                }`}
              >
                <Award className="w-4 h-4" />
                {session.successful
                  ? "Passed Assessment"
                  : "Practice Recommended"}
              </span>
              <p className="text-base sm:text-lg font-bold leading-snug max-w-xl">
                {session.interviewerFinalImpression}
              </p>
            </div>

            <div className="bg-white/10 border border-white/15 rounded-xl p-5 text-center shrink-0 min-w-[155px]">
              <div className="text-[11px] uppercase font-bold tracking-wider text-slate-300">
                Final Score
              </div>
              <div className="text-3xl font-black text-white mt-1">
                {session.totalScoreOutOf20 ?? session.totalScoreOutOf25}{" "}
                <span className="text-lg font-normal text-slate-300">
                  / {session.maxScore || 20}
                </span>
              </div>
              <div className="text-xs font-bold text-[#86EFAC] mt-1">
                {session.percentageScore}% Overall
              </div>
            </div>
          </div>

          {/* Concise Email Summary Confirmation */}
          <div className="mt-5 pt-4 border-t border-white/10 flex items-center gap-2 text-xs text-slate-300">
            <Mail className="w-4 h-4 text-[#339A05] shrink-0" />
            <span>{emailNote}</span>
          </div>
        </section>

        {/* 2. MARK PER QUESTION (OUT OF 5, WITH PROGRESS BAR) + SUGGESTED ANSWER */}
        <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-base font-extrabold text-[#041E41]">
              Your Marks &amp; Suggested Answers
            </h2>
            <span className="text-xs font-semibold text-slate-500">
              {uniqueQuestionEvaluations.length} questions &bull; 5 pts each
            </span>
          </div>

          <div className="space-y-4">
            {uniqueQuestionEvaluations.map((q, idx) => {
              const score = Math.max(0, Math.min(5, Number(q.scoreOutOf5) || 0));
              const pct = (score / 5) * 100;
              const barColor =
                score >= 3.5
                  ? "bg-[#339A05]"
                  : score >= 2
                    ? "bg-amber-500"
                    : "bg-red-500";
              return (
                <div
                  key={`${q.questionId || "q"}-${q.questionNumber}-${idx}`}
                  className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3"
                >
                  <span className="block text-xs font-extrabold uppercase tracking-wider text-[#041E41]">
                    Question {q.questionNumber} &bull; {q.category}
                  </span>
                  <p className="text-sm font-bold text-slate-900">
                    {q.questionText}
                  </p>

                  <div className="flex items-center gap-3">
                    <div
                      className="flex-1 h-2.5 rounded-full bg-slate-200 overflow-hidden"
                      role="progressbar"
                      aria-label={`Question ${q.questionNumber} mark`}
                      aria-valuemin={0}
                      aria-valuemax={5}
                      aria-valuenow={score}
                    >
                      <div
                        className={`h-full rounded-full ${barColor} transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-sm font-extrabold text-[#041E41] tabular-nums shrink-0">
                      {score} / 5
                    </span>
                  </div>

                  <div className="text-xs text-slate-800 bg-[#339A05]/10 border border-[#339A05]/25 p-3 rounded-lg leading-relaxed">
                    <strong className="text-[#041E41] block mb-0.5">
                      Suggested Answer
                    </strong>
                    {q.proposedAnswer || q.improvementTip}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 3. CONVERSATION TRANSCRIPT (EXPANDABLE) + PDF DOWNLOAD ICON */}
        <section className="bg-white rounded-2xl border border-slate-200 shadow-xs">
          <details className="group">
            <summary className="flex items-center justify-between gap-3 p-5 cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              <div>
                <h2 className="text-base font-extrabold text-[#041E41]">
                  Conversation Transcript
                </h2>
                <p className="text-xs text-slate-500">
                  Your answers and Sarah's questions, word for word
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    // Don't toggle the dropdown when downloading.
                    e.preventDefault();
                    e.stopPropagation();
                    generateChatBubbleTranscriptPdf(session);
                  }}
                  title="Download transcript (PDF)"
                  aria-label="Download transcript (PDF)"
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[#041E41] hover:bg-[#062d61] text-white transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4 text-[#86EFAC]" />
                </button>
                <ChevronDown className="w-5 h-5 text-slate-500 transition-transform group-open:rotate-180" />
              </div>
            </summary>

            <div className="px-5 pb-5">
          {/* Chat Bubbles Container */}
          <div className="space-y-4 max-h-[480px] overflow-y-auto p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            {session.transcript.map((item, idx) => {
              const isInterviewer = item.speaker === "interviewer";
              return (
                <div
                  key={`${item.id || "tr"}-${idx}`}
                  className={`flex items-start gap-3 ${
                    isInterviewer ? "justify-start" : "justify-end"
                  }`}
                >
                  {isInterviewer && (
                    <div className="w-8 h-8 rounded-full bg-[#041E41] text-white font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 shadow-xs">
                      S
                    </div>
                  )}

                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-2xs ${
                      isInterviewer
                        ? "bg-white border border-slate-200 text-slate-800 rounded-tl-xs"
                        : "bg-[#041E41] text-white rounded-tr-xs"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4 mb-1">
                      <span
                        className={`font-extrabold text-[11px] ${
                          isInterviewer ? "text-[#041E41]" : "text-[#86EFAC]"
                        }`}
                      >
                        {isInterviewer
                          ? "Sarah (Hiring Manager)"
                          : session.candidateName}
                      </span>
                      <span
                        className={`text-[10px] ${
                          isInterviewer ? "text-slate-400" : "text-slate-300"
                        }`}
                      >
                        {new Date(item.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{item.text}</p>
                  </div>

                  {!isInterviewer && (
                    <img
                      src={candidateAvatarUrl}
                      alt={session.candidateName}
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 rounded-full object-cover border border-[#339A05] shrink-0 mt-0.5 bg-[#041E41]"
                    />
                  )}
                </div>
              );
            })}
          </div>
            </div>
          </details>
        </section>
      </main>
    </div>
  );
};

// ============================================================================
// ROOT ROUTER APP — Routes: / (Homepage), /interview (Interview Room), /scoring (Scoring Page)
// ============================================================================
export default function App() {
  const [activeSession, setActiveSession] =
    useState<InterviewSessionRecord | null>(null);
  const [initialInterviewerMessage, setInitialInterviewerMessage] =
    useState<string>("");
  const [liveWsAvailable, setLiveWsAvailable] = useState<boolean>(false);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <HomePage
              onSessionStarted={(session, message, wsAvailable) => {
                setActiveSession(session);
                setInitialInterviewerMessage(message);
                setLiveWsAvailable(wsAvailable);
              }}
            />
          }
        />
        <Route
          path="/interview"
          element={
            <InterviewRoomPage
              session={activeSession}
              initialMessage={initialInterviewerMessage}
              liveWsAvailable={liveWsAvailable}
              onSessionCompleted={(completedSession) => {
                setActiveSession(completedSession);
              }}
            />
          }
        />
        <Route
          path="/scoring"
          element={
            <ScoringPage
              session={activeSession}
              onStartNewSession={() => {
                setActiveSession(null);
                setInitialInterviewerMessage("");
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
