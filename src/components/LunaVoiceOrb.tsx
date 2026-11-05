import React, { useEffect, useRef } from 'react';

interface LunaVoiceOrbProps {
  rms: number;
  isSpeaking: boolean;
  speaker: 'candidate' | 'interviewer' | 'idle';
  logoUrl: string;
}

export const LunaVoiceOrb: React.FC<LunaVoiceOrbProps> = ({
  rms,
  isSpeaking,
  speaker,
  logoUrl,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const rmsRef = useRef<number>(0);

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

    let phase = 0;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = width / dpr;
      const h = height / dpr;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const baseRadius = 68;
      const scale = isSpeaking ? 1 + rmsRef.current * 1.45 : 1;
      const radius = baseRadius * scale;

      // Global Hire 360 Palette: Emerald Green (#339A05) for Candidate/Active, Bright Gold/Cyan-Blue for Interviewer
      let primaryRgba = 'rgba(51, 154, 5, ';
      let secondaryRgba = 'rgba(104, 227, 46, ';

      if (speaker === 'interviewer') {
        primaryRgba = 'rgba(56, 189, 248, ';
        secondaryRgba = 'rgba(51, 154, 5, ';
      } else if (speaker === 'idle') {
        primaryRgba = 'rgba(148, 163, 184, ';
        secondaryRgba = 'rgba(100, 116, 139, ';
      }

      // Outer radial glow
      const outerGlow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.1);
      outerGlow.addColorStop(0, primaryRgba + '0.22)');
      outerGlow.addColorStop(1, 'rgba(4, 30, 65, 0)');
      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 2.2, 0, Math.PI * 2);
      ctx.fill();

      // 3 Harmonic Waveform Rings (exact LUNA v2 math)
      for (let ring = 0; ring < 3; ring++) {
        ctx.beginPath();
        const ringOffset = phase + ring * (Math.PI / 3);
        const steps = 360;
        for (let deg = 0; deg <= steps; deg += 2) {
          const rad = (deg * Math.PI) / 180;
          const freq = 4 + ring;
          const amp = isSpeaking ? 7 + rmsRef.current * 42 : 2.2;
          const wave = Math.sin(rad * freq + ringOffset) * amp;
          const r = radius + wave;
          const x = cx + Math.cos(rad) * r;
          const y = cy + Math.sin(rad) * r;
          if (deg === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();

        const alpha = (0.45 - ring * 0.12).toFixed(2);
        ctx.strokeStyle = ring === 0 ? primaryRgba + '0.9)' : secondaryRgba + alpha + ')';
        ctx.lineWidth = 1.6 + (2 - ring) * 1.1;
        ctx.stroke();

        if (ring === 0) {
          const innerGrad = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
          innerGrad.addColorStop(0, primaryRgba + '0.35)');
          innerGrad.addColorStop(1, secondaryRgba + '0.06)');
          ctx.fillStyle = innerGrad;
          ctx.fill();
        }
      }

      phase += isSpeaking ? 0.045 + rmsRef.current * 0.11 : 0.015;
      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isSpeaking, speaker]);

  return (
    <div className="w-full h-72 relative flex items-center justify-center select-none">
      <canvas ref={canvasRef} className="w-full h-full max-w-sm max-h-sm block" />

      {/* Global Hire 360 Logo Emblem Centered Inside the Live Voice Orb */}
      <div className="absolute flex flex-col items-center justify-center pointer-events-none">
        <div
          className={`w-24 h-24 rounded-full bg-white p-3 shadow-lg flex items-center justify-center transition-transform duration-200 ${
            isSpeaking ? 'scale-105' : 'scale-100'
          }`}
        >
          <img
            src={logoUrl}
            alt="Global Hire 360 AI Interviewer"
            referrerPolicy="no-referrer"
            className="w-full h-full object-contain"
          />
        </div>
        <span
          className={`mt-3 text-[11px] tracking-wider uppercase font-extrabold px-3.5 py-1 rounded-md border backdrop-blur-md shadow-xs ${
            speaker === 'candidate'
              ? 'bg-[#339A05] text-white border-white/30'
              : speaker === 'interviewer'
              ? 'bg-sky-500 text-slate-950 border-sky-300'
              : 'bg-slate-900/90 text-slate-300 border-white/15'
          }`}
        >
          {speaker === 'candidate'
            ? 'You Speaking'
            : speaker === 'interviewer'
            ? 'Interviewer Speaking'
            : 'Listening Live'}
        </span>
      </div>
    </div>
  );
};
