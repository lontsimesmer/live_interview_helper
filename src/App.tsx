import React, { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';

type NavigateOptions = { replace?: boolean };
type NavigateFn = (to: string, options?: NavigateOptions) => void;

const RouterContext = createContext<{ path: string; navigate: NavigateFn }>({
  path: '/',
  navigate: () => {},
});

function useNavigate(): NavigateFn {
  return useContext(RouterContext).navigate;
}

const BrowserRouter: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [path, setPath] = useState<string>(() => window.location.pathname || '/');

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname || '/');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: NavigateOptions) => {
    if (options?.replace) {
      window.history.replaceState({}, '', to);
    } else {
      window.history.pushState({}, '', to);
    }
    setPath(to);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
};

const Routes: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { path } = useContext(RouterContext);
  const childArray = React.Children.toArray(children) as React.ReactElement<{
    path: string;
    element: React.ReactNode;
  }>[];
  const exactMatch = childArray.find((c) => c.props.path === path);
  if (exactMatch) return <>{exactMatch.props.element}</>;
  const wildcard = childArray.find((c) => c.props.path === '*');
  return <>{wildcard ? wildcard.props.element : null}</>;
};

const Route: React.FC<{ path: string; element: React.ReactNode }> = () => null;

const Navigate: React.FC<{ to: string; replace?: boolean }> = ({ to, replace }) => {
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
} from 'lucide-react';
import { LunaVoiceOrb } from './components/LunaVoiceOrb';

const LOGO_URL = '/assets/aistudio/cropped-cropped-Global-Hire-360-Logo-2_18222f57.png';
const VOICE_SAMPLE_URL = '/assets/aistudio/audio-sample_63bf5371.wav';

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

export interface InterviewSessionRecord {
  id: string;
  candidateId?: string;
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
  onSessionStarted: (session: InterviewSessionRecord, initialMessage: string, liveWsAvailable: boolean) => void;
}

const HomePage: React.FC<HomePageProps> = ({ onSessionStarted }) => {
  const navigate = useNavigate();

  const [candidateName, setCandidateName] = useState('');
  const [candidateEmail, setCandidateEmail] = useState('');
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeBase64, setResumeBase64] = useState('');
  const [agreedToInstructions, setAgreedToInstructions] = useState(false);

  // Resume Examination State
  const [isExaminingResume, setIsExaminingResume] = useState(false);
  const [examinedResume, setExaminedResume] = useState<ResumeExaminationResult | null>(null);
  const [confirmedJobPosition, setConfirmedJobPosition] = useState('');
  const [rejectedDocumentInfo, setRejectedDocumentInfo] = useState<{
    fileName: string;
    message: string;
  } | null>(null);

  const [isStarting, setIsStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPlayingSample, setIsPlayingSample] = useState(false);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  const handleResumeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.pdf') && !ext.endsWith('.docx')) {
      const msg =
        'Document Rejected: Invalid file format. Please upload a valid Resume or CV in .PDF or .DOCX format.';
      setFormError(msg);
      setRejectedDocumentInfo({ fileName: file.name, message: msg });
      setResumeFile(null);
      setResumeBase64('');
      setExaminedResume(null);
      setConfirmedJobPosition('');
      e.target.value = '';
      return;
    }

    setFormError(null);
    setRejectedDocumentInfo(null);
    setResumeFile(file);
    setExaminedResume(null);
    setConfirmedJobPosition('');
    setIsExaminingResume(true);

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result as string;
      setResumeBase64(base64Data);

      try {
        const res = await fetch('/api/examine-resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
            'Document Rejected: This document does not relate to a Resume, CV, or professional job search profile. Please upload a valid Resume or CV.';
          setRejectedDocumentInfo({
            fileName: file.name,
            message: rejectionMessage,
          });
          setFormError(rejectionMessage);
          setResumeFile(null);
          setResumeBase64('');
          setExaminedResume(null);
          setConfirmedJobPosition('');
        }
      } catch (err) {
        console.warn('Resume examination preview warning:', err);
        setFormError('Failed to examine the uploaded document. Please try again.');
      } finally {
        setIsExaminingResume(false);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const toggleSampleAudio = () => {
    if (!sampleAudioRef.current) {
      sampleAudioRef.current = new Audio(VOICE_SAMPLE_URL);
      sampleAudioRef.current.onended = () => setIsPlayingSample(false);
    }
    if (isPlayingSample) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current.currentTime = 0;
      setIsPlayingSample(false);
    } else {
      sampleAudioRef.current.play().catch(() => setIsPlayingSample(false));
      setIsPlayingSample(true);
    }
  };

  const handleStartInterview = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!candidateName.trim()) {
      setFormError('Please enter your full name.');
      return;
    }
    if (!candidateEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail.trim())) {
      setFormError('Please enter a valid email address to receive your assessment results.');
      return;
    }
    if (rejectedDocumentInfo) {
      setFormError(rejectedDocumentInfo.message);
      return;
    }
    if (!resumeFile || !resumeBase64 || !examinedResume) {
      setFormError('Please upload a valid Resume or CV (.pdf or .docx) before joining the interview room.');
      return;
    }
    if (!agreedToInstructions) {
      setFormError('Please check the box confirming you have read and agreed to follow the interview instructions.');
      return;
    }

    setIsStarting(true);
    try {
      const res = await fetch('/api/start-interview-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateName: candidateName.trim(),
          candidateEmail: candidateEmail.trim(),
          resumeFileName: resumeFile.name,
          resumeMimeType: resumeFile.type,
          resumeBase64,
          confirmedJobPosition: confirmedJobPosition.trim() || examinedResume?.detectedRole,
          agreedToInstructions: Boolean(agreedToInstructions),
          preExaminedData: examinedResume,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not start interview session.');
      }

      onSessionStarted(data.session, data.interviewerMessage, Boolean(data.liveWsAvailable));
      navigate('/interview');
    } catch (err: any) {
      setFormError(err?.message || 'Unable to start interview session. Please try again.');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Clean Brand Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
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

          <button
            type="button"
            onClick={toggleSampleAudio}
            className="inline-flex items-center gap-2 text-xs font-semibold px-3.5 py-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[#041E41] transition-colors cursor-pointer"
          >
            <Volume2 className="w-4 h-4 text-[#339A05]" />
            {isPlayingSample ? 'Stop Voice Sample' : 'Hear Interviewer Voice'}
          </button>
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
            Welcome to the official <strong>Global Hire 360</strong> Live Voice Interview Platform.
            You are about to enter a live interactive voice interview where our AI Interviewer will
            examine your resume, greet you, and assess your readiness for your target role.
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
                <strong>Camera &amp; Microphone On:</strong> Ensure you are in a quiet space with your
                camera and microphone enabled for a live voice conversation with the interviewer.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                2
              </span>
              <span>
                <strong>10-Minute Max Session &amp; 90-Second Question Timer:</strong> Each interview
                consists of <strong>5 shuffled questions</strong> within a{' '}
                <strong>10-minute maximum session</strong>. You have <strong>90 seconds</strong> per
                question before the interviewer politely advances to the next question.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                3
              </span>
              <span>
                <strong>Rephrasing &amp; 2-Attempt Rule:</strong> You may ask the interviewer to
                rephrase a question if needed. If your answer is off-topic, the interviewer will
                motivate you and rephrase the question once. After <strong>2 unsuccessful attempts</strong>,
                the interviewer will encourage you to practice further and end the call.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-[#339A05]/15 text-[#339A05] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                4
              </span>
              <span>
                <strong>Marking Guide Scoring (0 to 5 Scale) &amp; Email Report:</strong> Each of the 5
                questions is graded from <strong>0 to 5 points</strong> (Total: 25) based on how well
                your response aligns in meaning with our marking guide. Results and transcript are sent
                to your email.
              </span>
            </li>
          </ul>
        </section>

        {/* 3. Candidate Check-In Form */}
        <form
          onSubmit={handleStartInterview}
          className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-5"
        >
          <h2 className="text-base font-bold text-[#041E41] border-b border-slate-100 pb-3">
            Candidate Details &amp; Resume Check-In
          </h2>

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
                placeholder="you@example.com (Your scorecard & transcript will be sent here)"
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:border-[#041E41] focus:ring-2 focus:ring-[#041E41]/10"
              />
            </div>
          </div>

          {/* Upload Resume (.pdf or .docx) */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Upload Resume (.PDF or .DOCX) <span className="text-red-500">*</span>
            </label>
            <label
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-5 cursor-pointer transition-colors ${
                rejectedDocumentInfo
                  ? 'border-red-300 bg-red-50/40 hover:border-red-400'
                  : 'border-slate-300 hover:border-[#339A05] bg-slate-50/70 hover:bg-[#339A05]/5'
              }`}
            >
              <Upload
                className={`w-6 h-6 mb-1.5 ${
                  rejectedDocumentInfo ? 'text-red-600' : 'text-[#041E41]'
                }`}
              />
              <span
                className={`text-sm font-semibold ${
                  rejectedDocumentInfo ? 'text-red-700' : 'text-[#041E41]'
                }`}
              >
                {resumeFile
                  ? resumeFile.name
                  : rejectedDocumentInfo
                  ? `${rejectedDocumentInfo.fileName} (Rejected — Click to upload a valid Resume/CV)`
                  : 'Click to upload your resume (.pdf or .docx)'}
              </span>
              <span className="text-xs text-slate-500 mt-0.5">
                Your resume is automatically examined to extract the job position you are applying for
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

            {/* Document Rejection Card (shown when uploaded document is not a Resume/CV) */}
            {!isExaminingResume && rejectedDocumentInfo && (
              <div className="mt-3 p-4 rounded-lg bg-red-50 border border-red-200 text-red-800 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-red-700">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
                  <span>Invalid Document Rejected</span>
                </div>
                <p className="text-xs text-red-700 leading-relaxed font-medium">
                  {rejectedDocumentInfo.message}
                </p>
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
                      {examinedResume.keySkills.join(', ')}
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
              I confirm that I have read and followed all the instructions above, my camera and
              microphone are ready, and I agree to join the live interview room.{' '}
              <span className="text-red-500">*</span>
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

  const [session, setSession] = useState<InterviewSessionRecord | null>(initialSession);
  const [speakerState, setSpeakerState] = useState<'interviewer' | 'candidate' | 'idle'>('idle');
  const [micRms, setMicRms] = useState<number>(0);
  const [liveCaption, setLiveCaption] = useState<string>(initialMessage || '');
  const [candidateSpokenBuffer, setCandidateSpokenBuffer] = useState<string>('');
  const [questionTimeLeft, setQuestionTimeLeft] = useState<number>(90);
  const [sessionTimeLeft, setSessionTimeLeft] = useState<number>(
    initialSession?.maxDurationSeconds || 600
  );
  const [callSeconds, setCallSeconds] = useState<number>(0);
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [isCameraOn, setIsCameraOn] = useState<boolean>(true);
  const [isProcessingTurn, setIsProcessingTurn] = useState<boolean>(false);
  const [usingGeminiLiveWs, setUsingGeminiLiveWs] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const spokenAccumulatorRef = useRef<string>('');
  const isInterviewerSpeakingRef = useRef<boolean>(false);
  const isSubmittingTurnRef = useRef<boolean>(false);
  const liveTranscriptRef = useRef<TranscriptEntry[]>(initialSession?.transcript || []);

  // Redirect to / if no session exists
  useEffect(() => {
    if (!initialSession) {
      navigate('/', { replace: true });
    }
  }, [initialSession, navigate]);

  // Call duration counter
  useEffect(() => {
    const interval = window.setInterval(() => {
      setCallSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Speak helper using Web Speech Synthesis tuned to warm African American female coach cadence
  const speakInterviewerText = useCallback(
    (text: string, onDone?: () => void) => {
      if (!('speechSynthesis' in window)) {
        setSpeakerState('idle');
        isInterviewerSpeakingRef.current = false;
        onDone?.();
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice =
        voices.find((v) =>
          /samantha|ava|allison|karen|zira|google us english|natural|aria|jenny|sonia/i.test(v.name)
        ) ||
        voices.find((v) => v.lang.startsWith('en') && /female/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith('en-US')) ||
        voices[0];

      if (preferredVoice) utterance.voice = preferredVoice;
      utterance.rate = 0.98;
      utterance.pitch = 1.02;

      isInterviewerSpeakingRef.current = true;
      setSpeakerState('interviewer');
      setLiveCaption(text);

      // Simulate smooth RMS wave while interviewer speaks
      const waveInterval = window.setInterval(() => {
        setMicRms(0.18 + Math.random() * 0.28);
      }, 90);

      utterance.onend = () => {
        clearInterval(waveInterval);
        setMicRms(0);
        isInterviewerSpeakingRef.current = false;
        setSpeakerState('idle');
        onDone?.();
      };

      utterance.onerror = () => {
        clearInterval(waveInterval);
        setMicRms(0);
        isInterviewerSpeakingRef.current = false;
        setSpeakerState('idle');
        onDone?.();
      };

      window.speechSynthesis.speak(utterance);
    },
    []
  );

  // Submit a conversational turn in Fallback Continuous Voice Mode
  const submitVoiceTurn = useCallback(
    async (opts: {
      text?: string;
      timedOut?: boolean;
      sessionTimedOut?: boolean;
      requestedRephrase?: boolean;
    }) => {
      if (!session || isSubmittingTurnRef.current) return;
      const textToSend = (opts.text ?? spokenAccumulatorRef.current).trim();
      if (!textToSend && !opts.timedOut && !opts.sessionTimedOut && !opts.requestedRephrase) return;

      isSubmittingTurnRef.current = true;
      setIsProcessingTurn(true);
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      spokenAccumulatorRef.current = '';
      setCandidateSpokenBuffer('');

      try {
        const res = await fetch('/api/interview-turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.id,
            candidateText: textToSend,
            timedOut: Boolean(opts.timedOut),
            sessionTimedOut: Boolean(opts.sessionTimedOut),
            requestedRephrase: Boolean(opts.requestedRephrase),
          }),
        });

        const data = await res.json();
        if (res.ok && data.session) {
          setSession(data.session);
          liveTranscriptRef.current = data.session.transcript;

          if (data.resetQuestionTimer) {
            setQuestionTimeLeft(90);
          }

          if (data.interviewEnded) {
            speakInterviewerText(data.interviewerMessage, () => {
              onSessionCompleted(data.session);
              navigate('/scoring');
            });
            return;
          }

          if (data.interviewerMessage) {
            speakInterviewerText(data.interviewerMessage);
          }
        }
      } catch (err) {
        console.warn('Turn error:', err);
      } finally {
        isSubmittingTurnRef.current = false;
        setIsProcessingTurn(false);
      }
    },
    [session, speakInterviewerText, onSessionCompleted, navigate]
  );

  // 90-Second Per-Question Countdown Timer
  useEffect(() => {
    if (!session || session.currentPhase !== 'questioning') return;

    const timer = window.setInterval(() => {
      setQuestionTimeLeft((prev) => {
        if (prev <= 1) {
          // 90 seconds expired! Interrupt candidate and advance to next question
          if (usingGeminiLiveWs && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'timer_expired',
                currentQuestionIndex: session.currentQuestionIndex,
              })
            );
            return 90;
          } else {
            submitVoiceTurn({
              text: spokenAccumulatorRef.current,
              timedOut: true,
            });
            return 90;
          }
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [session, usingGeminiLiveWs, submitVoiceTurn]);

  // 10-Minute (600 Seconds) Maximum Interview Session Duration Timer
  useEffect(() => {
    if (!session || session.currentPhase === 'finished') return;

    const sessionTimer = window.setInterval(() => {
      setSessionTimeLeft((prev) => {
        if (prev <= 1) {
          // 10-minute session limit reached! Automatically conclude the interview
          if (usingGeminiLiveWs && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.close();
          }
          submitVoiceTurn({
            text: spokenAccumulatorRef.current,
            sessionTimedOut: true,
          });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(sessionTimer);
  }, [session, usingGeminiLiveWs, submitVoiceTurn]);

  // Finalize a Gemini Live WebSocket session and navigate to /scoring
  const finalizeGeminiLiveCall = useCallback(
    async (terminatedByAttemptRule = false) => {
      if (!session) return;
      setIsProcessingTurn(true);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      try {
        const res = await fetch('/api/finalize-live-ws-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.id,
            liveTranscript: liveTranscriptRef.current,
            terminatedByAttemptRule,
          }),
        });
        const data = await res.json();
        if (res.ok && data.session) {
          onSessionCompleted(data.session);
          navigate('/scoring');
          return;
        }
      } catch (e) {
        console.warn('Finalize live session error:', e);
      } finally {
        setIsProcessingTurn(false);
      }
    },
    [session, onSessionCompleted, navigate]
  );

  // Initialize Camera, 16kHz AudioWorklet Mic Engine, and LUNA Live Voice Connection
  useEffect(() => {
    if (!initialSession) return;
    let isUnmounted = false;

    const setupMediaAndVoice = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
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
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        // Set up 16kHz AudioWorkletProcessor (exact LUNA v2 MicProcessor)
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
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

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        const source = audioCtx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(audioCtx, 'luna-mic-processor');
        source.connect(workletNode);

        workletNode.port.onmessage = (event) => {
          if (isUnmounted) return;
          const { pcm, rms } = event.data;

          if (!isInterviewerSpeakingRef.current) {
            setMicRms(rms);
            if (rms > 0.025) {
              setSpeakerState('candidate');
            } else {
              setSpeakerState((prev) => (prev === 'candidate' ? 'idle' : prev));
            }
          }

          // Stream 16-bit PCM audio frames to /api/live-ws if connected
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            const bytes = new Uint8Array(pcm);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64Audio = window.btoa(binary);
            wsRef.current.send(
              JSON.stringify({
                realtimeInput: {
                  mediaChunks: [
                    {
                      mimeType: 'audio/pcm;rate=16000',
                      data: base64Audio,
                    },
                  ],
                },
              })
            );
          }
        };
      } catch (mediaErr) {
        console.warn('Media permission warning:', mediaErr);
      }

      // Connect to LUNA v2 Gemini Live WebSocket (/api/live-ws) if available, otherwise start continuous voice loop
      if (liveWsAvailable) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/live-ws?sessionId=${encodeURIComponent(
          initialSession.id
        )}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        const playCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: 24000,
        });
        playbackCtxRef.current = playCtx;
        nextPlayTimeRef.current = playCtx.currentTime;

        ws.onmessage = (evt) => {
          if (isUnmounted) return;
          try {
            const msg = JSON.parse(evt.data);

            if (msg.type === 'connected') {
              setUsingGeminiLiveWs(true);
              return;
            }

            if (msg.type === 'fallback_required') {
              setUsingGeminiLiveWs(false);
              ws.close();
              startContinuousSpeechLoop();
              speakInterviewerText(initialMessage);
              return;
            }

            if (msg.type === 'question_advanced') {
              const qIdx = Math.max(0, Math.min(4, Number(msg.questionNumber) - 1));
              setQuestionTimeLeft(90);
              setSession((prev) =>
                prev
                  ? {
                      ...prev,
                      currentPhase: 'questioning',
                      currentQuestionIndex: qIdx,
                    }
                  : prev
              );
              return;
            }

            if (msg.type === 'end_call_triggered') {
              const terminatedByAttempts = msg.reason === 'terminated_after_two_attempts';
              window.setTimeout(() => {
                finalizeGeminiLiveCall(terminatedByAttempts);
              }, 3500);
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
              setSpeakerState('idle');
            }

            const parts = serverContent.modelTurn?.parts;
            if (Array.isArray(parts) && playbackCtxRef.current) {
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
                  const chunkRms = Math.sqrt(chunkSum / Math.max(1, int16.length));
                  setMicRms(chunkRms * 1.6);
                  isInterviewerSpeakingRef.current = true;
                  setSpeakerState('interviewer');

                  const ctx = playbackCtxRef.current;
                  const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
                  audioBuffer.getChannelData(0).set(float32);

                  const bufSource = ctx.createBufferSource();
                  bufSource.buffer = audioBuffer;
                  bufSource.connect(ctx.destination);

                  const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime);
                  bufSource.start(startAt);
                  nextPlayTimeRef.current = startAt + audioBuffer.duration;
                  activeSourcesRef.current.push(bufSource);

                  bufSource.onended = () => {
                    activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== bufSource);
                    if (activeSourcesRef.current.length === 0) {
                      isInterviewerSpeakingRef.current = false;
                      setSpeakerState('idle');
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
                const updated = (prev + ' ' + chunk).replace(/\s+/g, ' ').trim();
                return updated.slice(-280);
              });
              const list = liveTranscriptRef.current;
              const last = list[list.length - 1];
              if (last && last.speaker === 'interviewer') {
                last.text = (last.text + ' ' + chunk).replace(/\s+/g, ' ').trim();
              } else {
                list.push({
                  id: `tr_${Date.now()}_i`,
                  speaker: 'interviewer',
                  speakerName: 'Global Hire 360 AI Interviewer',
                  text: chunk.trim(),
                  timestamp: new Date().toISOString(),
                });
              }
            }

            // Live input transcription (Candidate voice captions)
            if (serverContent.inputTranscription?.text) {
              const chunk = serverContent.inputTranscription.text;
              setCandidateSpokenBuffer((prev) => (prev + ' ' + chunk).replace(/\s+/g, ' ').trim());
              const list = liveTranscriptRef.current;
              const last = list[list.length - 1];
              if (last && last.speaker === 'candidate') {
                last.text = (last.text + ' ' + chunk).replace(/\s+/g, ' ').trim();
              } else {
                list.push({
                  id: `tr_${Date.now()}_c`,
                  speaker: 'candidate',
                  speakerName: initialSession.candidateName,
                  text: chunk.trim(),
                  timestamp: new Date().toISOString(),
                });
              }
            }
          } catch (err) {
            console.warn('WS message parse warning:', err);
          }
        };

        ws.onerror = () => {
          if (!isUnmounted) {
            setUsingGeminiLiveWs(false);
            startContinuousSpeechLoop();
            speakInterviewerText(initialMessage);
          }
        };
      } else {
        startContinuousSpeechLoop();
        speakInterviewerText(initialMessage);
      }
    };

    const startContinuousSpeechLoop = () => {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) return;

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        if (isInterviewerSpeakingRef.current || isSubmittingTurnRef.current) return;

        let interim = '';
        let finalChunk = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptPiece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalChunk += transcriptPiece + ' ';
          } else {
            interim += transcriptPiece;
          }
        }

        if (finalChunk.trim()) {
          spokenAccumulatorRef.current = (
            spokenAccumulatorRef.current +
            ' ' +
            finalChunk
          )
            .replace(/\s+/g, ' ')
            .trim();
        }

        const combinedLive = (spokenAccumulatorRef.current + ' ' + interim).trim();
        if (combinedLive) {
          setCandidateSpokenBuffer(combinedLive);
          setSpeakerState('candidate');

          // Reset 2.2-second natural pause detector to automatically send the candidate's spoken turn
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = window.setTimeout(() => {
            if (
              spokenAccumulatorRef.current.trim().length >= 2 &&
              !isInterviewerSpeakingRef.current &&
              !isSubmittingTurnRef.current
            ) {
              submitVoiceTurn({ text: spokenAccumulatorRef.current.trim() });
            }
          }, 2200);
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

    setupMediaAndVoice();

    return () => {
      isUnmounted = true;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      try {
        wsRef.current?.close();
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
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [initialSession, initialMessage, liveWsAvailable, speakInterviewerText, submitVoiceTurn, finalizeGeminiLiveCall]);

  const toggleMic = () => {
    if (!mediaStreamRef.current) return;
    const audioTracks = mediaStreamRef.current.getAudioTracks();
    audioTracks.forEach((track) => {
      track.enabled = isMicMuted;
    });
    setIsMicMuted(!isMicMuted);
  };

  const toggleCamera = () => {
    if (!mediaStreamRef.current) return;
    const videoTracks = mediaStreamRef.current.getVideoTracks();
    videoTracks.forEach((track) => {
      track.enabled = !isCameraOn;
    });
    setIsCameraOn(!isCameraOn);
  };

  const handleRequestRephrase = () => {
    if (usingGeminiLiveWs && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [{ text: 'Could you please rephrase the current question for me?' }],
              },
            ],
            turnComplete: true,
          },
        })
      );
    } else {
      submitVoiceTurn({ requestedRephrase: true });
    }
  };

  if (!session) return null;

  const currentQuestion =
    session.currentPhase === 'questioning'
      ? session.questions[session.currentQuestionIndex]
      : null;

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-[#041E41] text-white flex flex-col justify-between">
      {/* Top Bar: Role Badge, Question Progress, 90-Second Timer, End Call */}
      <header className="border-b border-white/10 bg-[#031630] px-6 py-3.5">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-white rounded-lg px-2.5 py-1">
              <img
                src={LOGO_URL}
                alt="Global Hire 360"
                referrerPolicy="no-referrer"
                className="h-7 w-auto object-contain"
              />
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-[#339A05]">
                Position: {session.detectedRole}
              </div>
              <div className="text-xs text-slate-300">
                Candidate: <strong>{session.candidateName}</strong> &bull; Call Time:{' '}
                <span className="font-mono">{formatTimer(callSeconds)}</span>
              </div>
            </div>
          </div>

          {/* 90-Second Question Countdown Timer */}
          <div className="flex items-center gap-3">
            <div className="px-3.5 py-1.5 rounded-lg bg-white/10 border border-white/15 text-xs font-bold">
              {session.currentPhase === 'greeting_how_are_you'
                ? 'Warm-Up Greeting'
                : `Question ${session.currentQuestionIndex + 1} of 5`}
            </div>

            <div
              title="10-Minute Maximum Session Countdown"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono text-xs font-bold ${
                sessionTimeLeft <= 60
                  ? 'bg-red-600/30 border-red-400 text-red-200 animate-pulse'
                  : 'bg-white/10 border-white/20 text-slate-200'
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-[#339A05]" />
              <span>Session: {formatTimer(sessionTimeLeft)} / 10:00</span>
            </div>

            <div
              title="90-Second Per-Question Countdown"
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg border font-mono text-sm font-extrabold ${
                questionTimeLeft <= 15
                  ? 'bg-red-600/30 border-red-400 text-red-200 animate-pulse'
                  : questionTimeLeft <= 30
                  ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                  : 'bg-[#339A05]/25 border-[#339A05] text-white'
              }`}
            >
              <Clock className="w-4 h-4" />
              <span>{formatTimer(questionTimeLeft)} / 01:30</span>
            </div>

            <button
              type="button"
              onClick={() => finalizeGeminiLiveCall(false)}
              disabled={isProcessingTurn}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold transition-colors cursor-pointer"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              End Interview
            </button>
          </div>
        </div>
      </header>

      {/* Center Stage: LUNA AI Voice Orb (Global Hire 360 Interviewer) + Candidate Live Camera */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-2 gap-6 items-center">
        {/* Left Card: AI Interviewer with Global Hire 360 Logo & 60fps LUNA Voice Orb */}
        <div className="bg-[#072957] border border-white/15 rounded-2xl p-6 flex flex-col items-center justify-between min-h-[420px] shadow-lg">
          <div className="w-full flex items-center justify-between text-xs text-slate-300">
            <span className="font-bold text-white flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#339A05] animate-ping" />
              Global Hire 360 AI Interviewer
            </span>
            <span className="text-[11px] text-slate-300 font-medium">
              {session.currentPhase === 'questioning'
                ? `Attempt ${session.currentQuestionAttempts + 1} of 2`
                : 'Live Voice Active'}
            </span>
          </div>

          <LunaVoiceOrb
            rms={micRms}
            isSpeaking={speakerState !== 'idle'}
            speaker={speakerState}
            logoUrl={LOGO_URL}
          />

          {/* Current Question Prompt Display */}
          <div className="w-full bg-[#041E41]/90 border border-white/10 rounded-xl p-4 text-center">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#339A05] mb-1">
              {currentQuestion
                ? `Question ${currentQuestion.number} (${currentQuestion.category})`
                : 'Live Greeting'}
            </div>
            <p className="text-sm text-slate-100 leading-relaxed">
              {currentQuestion ? currentQuestion.question : liveCaption}
            </p>
          </div>
        </div>

        {/* Right Card: Candidate Live Camera Feed */}
        <div className="bg-[#072957] border border-white/15 rounded-2xl p-6 flex flex-col justify-between min-h-[420px] shadow-lg">
          <div className="w-full flex items-center justify-between text-xs text-slate-300 mb-3">
            <span className="font-bold text-white flex items-center gap-2">
              <Video className="w-4 h-4 text-[#339A05]" />
              {session.candidateName} (Candidate Camera)
            </span>
            <span className="text-[11px] text-emerald-300 font-semibold">
              {isMicMuted ? 'Microphone Muted' : 'Mic Live — Speak Naturally'}
            </span>
          </div>

          <div className="relative flex-1 w-full bg-slate-950 rounded-xl overflow-hidden border border-white/10 flex items-center justify-center min-h-[280px]">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover transform scale-x-[-1] ${
                isCameraOn ? 'block' : 'hidden'
              }`}
            />
            {!isCameraOn && (
              <div className="flex flex-col items-center justify-center text-slate-400">
                <VideoOff className="w-10 h-10 mb-2" />
                <span className="text-xs font-medium">Camera Turned Off</span>
              </div>
            )}

            {/* Live Candidate Speech Indicator Overlay */}
            {candidateSpokenBuffer && (
              <div className="absolute bottom-3 left-3 right-3 bg-slate-950/85 backdrop-blur-md border border-[#339A05]/50 rounded-lg px-3.5 py-2 text-xs text-white">
                <span className="text-[#339A05] font-bold mr-1.5">You:</span>
                {candidateSpokenBuffer}
              </div>
            )}
          </div>

          {/* Live Voice Controls Bar */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleMic}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  isMicMuted
                    ? 'bg-red-600 text-white'
                    : 'bg-white/10 hover:bg-white/20 text-white border border-white/15'
                }`}
              >
                {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4 text-[#339A05]" />}
                {isMicMuted ? 'Unmute Mic' : 'Mic On'}
              </button>

              <button
                type="button"
                onClick={toggleCamera}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  !isCameraOn
                    ? 'bg-red-600 text-white'
                    : 'bg-white/10 hover:bg-white/20 text-white border border-white/15'
                }`}
              >
                {isCameraOn ? (
                  <Video className="w-4 h-4 text-[#339A05]" />
                ) : (
                  <VideoOff className="w-4 h-4" />
                )}
                {isCameraOn ? 'Camera On' : 'Camera Off'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {session.currentPhase === 'questioning' && (
                <button
                  type="button"
                  onClick={handleRequestRephrase}
                  disabled={isProcessingTurn}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-xs font-bold text-white transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-sky-300" />
                  Ask to Rephrase
                </button>
              )}

              {!usingGeminiLiveWs && (
                <button
                  type="button"
                  onClick={() =>
                    submitVoiceTurn({
                      text:
                        spokenAccumulatorRef.current.trim() ||
                        candidateSpokenBuffer.trim() ||
                        "I'm doing great today, thank you! I'm ready for the questions.",
                    })
                  }
                  disabled={isProcessingTurn}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#339A05] hover:bg-[#2b8204] text-xs font-bold text-white transition-colors cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  {isProcessingTurn ? 'Processing...' : 'Done Speaking'}
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Bottom Live Caption Bar */}
      <footer className="bg-[#031630] border-t border-white/10 px-6 py-3.5">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs text-slate-300 truncate">
            <strong className="text-[#339A05] uppercase tracking-wider mr-2">
              Live Caption:
            </strong>
            {liveCaption || 'Listening to your voice...'}
          </p>
        </div>
      </footer>
    </div>
  );
};

// ============================================================================
// PAGE 3: SCORING PAGE (/scoring) — Final Verdict, Per-Question Scores (/ 5) & Transcript
// ============================================================================
interface ScoringPageProps {
  session: InterviewSessionRecord | null;
  onStartNewSession: () => void;
}

const ScoringPage: React.FC<ScoringPageProps> = ({ session, onStartNewSession }) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) {
      navigate('/', { replace: true });
    }
  }, [session, navigate]);

  if (!session) return null;

  const handleDownloadTranscript = () => {
    const lines = [
      `GLOBAL HIRE 360 — INTERVIEW ASSESSMENT & VOICE TRANSCRIPT`,
      `Candidate: ${session.candidateName} (${session.candidateEmail})`,
      `Job Position: ${session.detectedRole}`,
      `Overall Score: ${session.totalScoreOutOf25} / 25 (${session.percentageScore}%)`,
      `Verdict: ${session.successful ? 'SUCCESSFUL' : 'UNSUCCESSFUL - PRACTICE FURTHER'}`,
      ``,
      `INTERVIEWER FINAL IMPRESSION:`,
      session.interviewerFinalImpression,
      ``,
      `QUESTION BREAKDOWN (/ 5):`,
      ...session.questionEvaluations.map(
        (q) =>
          `Q${q.questionNumber} (${q.category}): ${q.scoreOutOf5}/5\nQuestion: ${q.questionText}\nCandidate Answer: ${q.candidateAnswer}${
            q.proposedAnswer ? `\nMarking Guide Reference: ${q.proposedAnswer}` : ''
          }\nFeedback: ${q.feedback}\n`
      ),
      `FULL VOICE TRANSCRIPT:`,
      ...session.transcript.map(
        (t) => `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.speakerName}: ${t.text}`
      ),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `GlobalHire360_Transcript_${session.candidateName.replace(/\s+/g, '_')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 pb-14">
      {/* Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={LOGO_URL}
              alt="Global Hire 360"
              referrerPolicy="no-referrer"
              className="h-10 w-auto object-contain"
            />
            <div>
              <span className="block text-sm font-extrabold text-[#041E41]">
                Interview Assessment Results
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
              navigate('/');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#041E41] hover:bg-[#062d61] text-white text-xs font-bold transition-colors cursor-pointer"
          >
            Start New Interview
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 pt-8 space-y-6">
        {/* Overall Verdict & Score Banner */}
        <section className="bg-[#041E41] text-white rounded-2xl p-6 sm:p-8 shadow-sm border-b-4 border-[#339A05]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
            <div className="space-y-2">
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-extrabold uppercase tracking-wider ${
                  session.successful
                    ? 'bg-[#339A05] text-white'
                    : 'bg-amber-500 text-slate-950'
                }`}
              >
                <Award className="w-4 h-4" />
                {session.successful
                  ? 'Successful — Ready for Placement'
                  : 'Unsuccessful — Practice Recommended'}
              </span>
              <h1 className="text-2xl font-extrabold tracking-tight">
                {session.candidateName} — {session.detectedRole}
              </h1>
              <p className="text-sm text-slate-200 leading-relaxed max-w-2xl">
                {session.interviewerFinalImpression}
              </p>
            </div>

            <div className="bg-white/10 border border-white/15 rounded-xl p-5 text-center shrink-0 min-w-[150px]">
              <div className="text-xs uppercase font-bold text-slate-300">Overall Score</div>
              <div className="text-3xl font-black text-white mt-1">
                {session.totalScoreOutOf25}{' '}
                <span className="text-lg font-normal text-slate-300">/ 25</span>
              </div>
              <div className="text-xs font-bold text-[#339A05] mt-1">
                {session.percentageScore}% Performance
              </div>
            </div>
          </div>

          {/* Email & Database Status Strip */}
          <div className="mt-5 pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-[#339A05]" />
              <span>{session.emailDeliveryNote || `Results prepared for ${session.candidateEmail}`}</span>
            </div>
            <button
              type="button"
              onClick={handleDownloadTranscript}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-white hover:text-[#339A05] transition-colors cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Download Transcript (.TXT)
            </button>
          </div>
        </section>

        {/* Per-Question Scores (/ 5) */}
        <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
          <h2 className="text-base font-extrabold text-[#041E41] border-b border-slate-100 pb-3">
            Question-by-Question Marking Guide Evaluation (0 to 5 Scale)
          </h2>

          <div className="space-y-4">
            {session.questionEvaluations.map((q) => {
              const pct = Math.round((q.scoreOutOf5 / 5) * 100);
              return (
                <div
                  key={q.questionId}
                  className="p-4 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wider text-[#041E41]">
                      Question {q.questionNumber}: {q.category}
                    </span>
                    <span
                      className={`px-2.5 py-1 rounded-md text-xs font-extrabold text-white ${
                        q.scoreOutOf5 >= 3.5 ? 'bg-[#339A05]' : 'bg-[#041E41]'
                      }`}
                    >
                      {q.scoreOutOf5} / 5
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        q.scoreOutOf5 >= 3.5 ? 'bg-[#339A05]' : 'bg-[#041E41]'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <p className="text-sm font-semibold text-slate-800">{q.questionText}</p>
                  <p className="text-xs text-slate-700">
                    <strong>Candidate Response:</strong> {q.candidateAnswer}
                  </p>
                  {q.proposedAnswer && (
                    <div className="text-xs text-slate-700 bg-[#339A05]/10 border border-[#339A05]/25 p-2.5 rounded-lg">
                      <strong className="text-[#041E41]">Marking Guide Reference Answer:</strong>{' '}
                      {q.proposedAnswer}
                    </div>
                  )}
                  <p className="text-xs text-[#041E41] bg-white p-2.5 rounded-lg border border-slate-200">
                    <strong>Interviewer Feedback:</strong> {q.feedback}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Full Voice Call Transcript */}
        <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
          <h2 className="text-base font-extrabold text-[#041E41] border-b border-slate-100 pb-3">
            Full Interview Voice Transcript
          </h2>

          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {session.transcript.map((item) => (
              <div
                key={item.id}
                className={`p-3.5 rounded-xl border text-xs leading-relaxed ${
                  item.speaker === 'interviewer'
                    ? 'bg-slate-50 border-slate-200 text-slate-800'
                    : 'bg-[#339A05]/10 border-[#339A05]/30 text-slate-900'
                }`}
              >
                <div className="flex items-center justify-between font-bold mb-1">
                  <span
                    className={
                      item.speaker === 'interviewer' ? 'text-[#041E41]' : 'text-[#339A05]'
                    }
                  >
                    {item.speakerName}
                  </span>
                  <span className="text-[11px] font-normal text-slate-400">
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p>{item.text}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

// ============================================================================
// ROOT ROUTER APP — Routes: / (Homepage), /interview (Interview Room), /scoring (Scoring Page)
// ============================================================================
export default function App() {
  const [activeSession, setActiveSession] = useState<InterviewSessionRecord | null>(null);
  const [initialInterviewerMessage, setInitialInterviewerMessage] = useState<string>('');
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
                setInitialInterviewerMessage('');
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
