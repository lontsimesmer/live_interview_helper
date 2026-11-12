import React, { useEffect, useRef } from 'react';

interface LunaVoiceOrbProps {
  rms: number;
  isSpeaking: boolean;
  speaker: 'candidate' | 'interviewer' | 'idle';
  logoUrl: string;
}

/**
 * Interviewer Profile Orb:
 * - Displays expanding concentric acoustic sound-wave ripples ONLY when the interviewer is speaking.
 * - Radial equalizer bars have been completely removed per user specification.
 */
export const LunaVoiceOrb: React.FC<LunaVoiceOrbProps> = ({
  rms,
  speaker,
  logoUrl,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const rmsRef = useRef<number>(0);

  const isInterviewerSpeaking = speaker === 'interviewer';

  useEffect(() => {
    rmsRef.current = rms;
  }, [rms]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = canvas.width;
    let height = canvas.height;

    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      width = canvas.width;
      height = canvas.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    let tick = 0;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = width / dpr;
      const h = height / dpr;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const baseRadius = 52;
      const currentRms = Math.min(1, Math.max(0, rmsRef.current));
      const activeEnergy = isInterviewerSpeaking ? Math.max(0.28, currentRms * 2.2) : 0;

      // 1. Ambient Halo around the Interviewer Emblem
      const outerGlow = ctx.createRadialGradient(
        cx,
        cy,
        baseRadius * 0.6,
        cx,
        cy,
        baseRadius * (isInterviewerSpeaking ? 2.4 + activeEnergy * 0.6 : 1.35)
      );
      if (isInterviewerSpeaking) {
        outerGlow.addColorStop(0, 'rgba(56, 189, 248, 0.42)');
        outerGlow.addColorStop(0.55, 'rgba(51, 154, 5, 0.24)');
        outerGlow.addColorStop(1, 'rgba(4, 30, 65, 0)');
      } else {
        outerGlow.addColorStop(0, 'rgba(148, 163, 184, 0.12)');
        outerGlow.addColorStop(1, 'rgba(4, 30, 65, 0)');
      }
      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * 2.7, 0, Math.PI * 2);
      ctx.fill();

      // 2. High-Visibility Expanding Concentric Acoustic Sound-Wave Ripples (ONLY when Interviewer speaks)
      if (isInterviewerSpeaking) {
        const rippleCount = 4;
        for (let r = 0; r < rippleCount; r++) {
          const progress = (tick * 0.018 + r / rippleCount) % 1;
          const maxExpansion = 68 + activeEnergy * 34;
          const rippleRadius = baseRadius + 4 + progress * maxExpansion;
          const alpha = Math.pow(1 - progress, 1.15) * 0.88;

          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, rippleRadius, 0, Math.PI * 2);
          ctx.strokeStyle =
            r % 2 === 0
              ? `rgba(56, 189, 248, ${alpha.toFixed(3)})`
              : `rgba(74, 222, 128, ${alpha.toFixed(3)})`;
          ctx.lineWidth = 4.0 - progress * 2.2;
          ctx.shadowColor = r % 2 === 0 ? 'rgba(56, 189, 248, 0.7)' : 'rgba(51, 154, 5, 0.7)';
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.restore();
        }
      } else {
        // Calm static ring when interviewer is listening
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      tick += 1;
      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isInterviewerSpeaking]);

  return (
    <div className="w-full h-64 relative flex items-center justify-center select-none">
      <canvas ref={canvasRef} className="w-full h-full max-w-sm max-h-sm block" />

      {/* Global Hire 360 Interviewer Profile Centered Inside the Concentric Ripples */}
      <div className="absolute flex flex-col items-center justify-center pointer-events-none">
        <div
          className={`w-24 h-24 rounded-full bg-white p-3 shadow-lg flex items-center justify-center transition-transform duration-200 ring-4 ${
            isInterviewerSpeaking ? 'ring-sky-400 scale-105' : 'ring-white/25 scale-100'
          }`}
        >
          <img
            src={logoUrl}
            alt="Sarah — Global Hire 360 Hiring Manager"
            referrerPolicy="no-referrer"
            className="w-full h-full object-contain"
          />
        </div>
        <span
          className={`mt-4 text-xs font-semibold px-3 py-1 rounded-md border ${
            isInterviewerSpeaking
              ? 'bg-sky-400 text-slate-950 border-sky-200'
              : 'bg-slate-900/85 text-slate-300 border-white/15'
          }`}
        >
          {isInterviewerSpeaking ? 'Sarah Speaking' : 'Sarah Listening'}
        </span>
      </div>
    </div>
  );
};

interface CandidateAcousticAvatarProps {
  candidateName: string;
  candidateEmail: string;
  profilePictureUrl: string;
  fallbackAvatarUrl: string;
  isCandidateSpeaking: boolean;
  rms: number;
}

/**
 * Candidate Profile Picture with High-Visibility Expanding Concentric Acoustic Sound-Wave Ripples
 * Appears when the candidate's camera is turned off, and animates SVG + CSS keyframe concentric ripples
 * originating from the center of the profile picture and scaling dynamically with `rms` when the candidate speaks.
 */
export const CandidateAcousticAvatar: React.FC<CandidateAcousticAvatarProps> = ({
  candidateName,
  profilePictureUrl,
  fallbackAvatarUrl,
  isCandidateSpeaking,
  rms,
}) => {
  const normalizedRms = Math.min(1, Math.max(0, rms));
  const activeVoice = isCandidateSpeaking || normalizedRms > 0.03;

  // Dynamic vocal energy derived from live microphone RMS when the candidate is speaking
  const dynamicEnergy = activeVoice
    ? Math.min(1.4, Math.max(0.35, normalizedRms * 3.4))
    : 0;

  // Dynamic scale & speed parameters driven by `rms`
  const rippleMaxScale = (2.05 + dynamicEnergy * 0.75).toFixed(3);
  const rippleDurationSec = Math.max(1.15, 2.1 - dynamicEnergy * 0.65).toFixed(2);
  const strokeWidthBase = Number((3.8 + dynamicEnergy * 2.4).toFixed(2));
  const livePulseRadius = Number((50 + dynamicEnergy * 22).toFixed(1));
  const auraRadius = Number((58 + dynamicEnergy * 34).toFixed(1));
  const avatarDynamicScale = activeVoice
    ? 1 + Math.min(0.14, Math.max(0.04, normalizedRms * 0.35))
    : 1;

  const concentricRings = [0, 1, 2, 3, 4];

  return (
    <div
      className="candidate-acoustic-avatar w-full flex flex-col items-center justify-center p-2 text-center select-none relative"
      style={
        {
          '--ripple-max-scale': rippleMaxScale,
        } as React.CSSProperties
      }
    >
      <div className="relative w-60 h-60 flex items-center justify-center">
        {/* High-Visibility SVG Expanding Concentric Ripples Originating from Center (120, 120) */}
        <svg
          viewBox="0 0 240 240"
          className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="candidate-rms-aura" cx="50%" cy="50%" r="50%">
              <stop
                offset="0%"
                stopColor="#4ADE80"
                stopOpacity={activeVoice ? Math.min(0.65, 0.35 + dynamicEnergy * 0.25) : 0.08}
              />
              <stop
                offset="55%"
                stopColor="#38BDF8"
                stopOpacity={activeVoice ? Math.min(0.42, 0.2 + dynamicEnergy * 0.18) : 0.03}
              />
              <stop offset="100%" stopColor="#041E41" stopOpacity="0" />
            </radialGradient>
            <filter id="candidate-ripple-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation={activeVoice ? 3.5 + dynamicEnergy * 2.5 : 1.5} result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Center-Origin Radial Aura Scaling with RMS */}
          <circle cx="120" cy="120" r={auraRadius} fill="url(#candidate-rms-aura)" />

          {activeVoice ? (
            <g filter="url(#candidate-ripple-glow)">
              {/* 5 Expanding Concentric Ripples Originating from Exact Center (120, 120) */}
              {concentricRings.map((ringIndex) => {
                const delaySec = (
                  (ringIndex / concentricRings.length) *
                  Number(rippleDurationSec)
                ).toFixed(2);
                const isEven = ringIndex % 2 === 0;
                return (
                  <circle
                    key={ringIndex}
                    cx="120"
                    cy="120"
                    r="46"
                    fill="none"
                    stroke={isEven ? '#4ADE80' : '#38BDF8'}
                    strokeWidth={strokeWidthBase}
                    className="candidate-ripple-ring"
                    style={{
                      animationDuration: `${rippleDurationSec}s`,
                      animationDelay: `-${delaySec}s`,
                    }}
                  />
                );
              })}

              {/* Direct RMS-Responsive Acoustic Pressure Ring Originating from Center */}
              <circle
                cx="120"
                cy="120"
                r={livePulseRadius}
                fill="none"
                stroke="#86EFAC"
                strokeWidth={strokeWidthBase * 0.9}
                strokeOpacity={Math.min(0.95, 0.65 + dynamicEnergy * 0.25)}
              />
            </g>
          ) : (
            /* Calm Standby Ring Centered Around Profile Picture */
            <circle
              cx="120"
              cy="120"
              r="53"
              fill="none"
              stroke="rgba(148, 163, 184, 0.3)"
              strokeWidth="1.75"
            />
          )}
        </svg>

        {/* Candidate Profile Picture Centered at (120, 120) */}
        <div
          className="relative z-10 transition-transform duration-75 flex items-center justify-center"
          style={{ transform: `scale(${avatarDynamicScale.toFixed(3)})` }}
        >
          <img
            src={profilePictureUrl}
            alt={`${candidateName} Profile`}
            referrerPolicy="no-referrer"
            onError={(e) => {
              const target = e.currentTarget;
              if (target.src !== fallbackAvatarUrl) {
                target.src = fallbackAvatarUrl;
              }
            }}
            className={`w-24 h-24 rounded-full object-cover shadow-xl bg-[#041E41] border-4 ${
              activeVoice
                ? 'border-emerald-400 ring-4 ring-emerald-400/40'
                : 'border-white/30'
            }`}
          />
          <span
            title="Candidate Profile Picture"
            className="w-7 h-7 rounded-full bg-white shadow-md border border-slate-200 flex items-center justify-center absolute -bottom-1 -right-1"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.13-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
              />
            </svg>
          </span>
        </div>
      </div>
      <span
        className={`-mt-1 mb-1 text-xs font-semibold px-3 py-1 rounded-md border ${
          activeVoice
            ? 'bg-[#339A05] text-white border-emerald-300 shadow-sm'
            : 'bg-slate-900/80 text-slate-300 border-white/15'
        }`}
      >
        {activeVoice ? 'You Speaking' : 'Camera Off · Profile Active'}
      </span>
    </div>
  );
};


