"use client";

import { useEffect, useRef } from "react";
import type { AnalysisData } from "@/types/audio";
import { getVisibleTimeRange } from "@/lib/timeWindow";

export function Overview({ analysis, currentTime, duration, onSeek }: { analysis: AnalysisData | null; currentTime: number; duration: number; onSeek: (v: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect(), ratio = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(1, rect.width * ratio); canvas.height = Math.max(1, rect.height * ratio);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(ratio, ratio); const w = rect.width, h = rect.height;
    ctx.fillStyle = "#081311"; ctx.fillRect(0, 0, w, h);
    if (!analysis) return;
    const heatHeight = h * 0.52;
    for (let x = 0; x < Math.ceil(w); x++) {
      const col = Math.min(analysis.columns - 1, Math.floor(x / w * analysis.columns));
      for (let y = 0; y < 28; y++) {
        const band = Math.floor((1 - y / 28) * (analysis.bands - 1));
        const p = analysis.spectral[col * analysis.bands + band] / 255;
        ctx.fillStyle = `hsla(${190 - p * 150},90%,${12 + p * 55}%,${0.2 + p * 0.8})`;
        ctx.fillRect(x, y / 28 * heatHeight, 1.2, heatHeight / 28 + 1);
      }
      const voiceLikelihood = Math.max(analysis.speech[col], analysis.whisper[col] * 0.9);
      if (voiceLikelihood > 0.52) { ctx.fillStyle = `rgba(107,255,207,${voiceLikelihood * 0.32})`; ctx.fillRect(x, heatHeight, 1.5, h - heatHeight); }
      const mid = heatHeight + (h - heatHeight) / 2, amp = (h - heatHeight) * 0.43;
      ctx.strokeStyle = "#75e8ce"; ctx.globalAlpha = 0.72; ctx.beginPath();
      ctx.moveTo(x, mid + analysis.waveform[col * 2] * amp); ctx.lineTo(x, mid + analysis.waveform[col * 2 + 1] * amp); ctx.stroke(); ctx.globalAlpha = 1;
    }
    const cursor = duration ? currentTime / duration * w : 0;
    ctx.fillStyle = "#ffc85a"; ctx.fillRect(cursor - 1, 0, 2, h);
    ctx.beginPath(); ctx.moveTo(cursor - 6, 0); ctx.lineTo(cursor + 6, 0); ctx.lineTo(cursor, 8); ctx.fill();
  }, [analysis, currentTime, duration]);
  return <canvas ref={canvasRef} className="overview-canvas" aria-label="Waveform and spectrogram overview. Tap to seek." onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek((e.clientX - r.left) / r.width * duration); }}/>
}

export function WindowWaveform({ analysis, currentTime, duration, windowSeconds, onSeek }: { analysis: AnalysisData | null; currentTime: number; duration: number; windowSeconds: number; onSeek: (v: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const range = getVisibleTimeRange(currentTime, duration, windowSeconds);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect(), ratio = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(1, rect.width * ratio); canvas.height = Math.max(1, rect.height * ratio);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(ratio, ratio); const w = rect.width, h = rect.height;
    ctx.fillStyle = "#081311"; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#132a26"; ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) { const x = i / 6 * w; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!analysis || !range.span) return;

    for (let x = 0; x < Math.ceil(w); x++) {
      const time = range.start + x / w * range.span;
      const col = Math.min(analysis.columns - 1, Math.max(0, Math.floor(time / analysis.duration * analysis.columns)));
      const voiceLikelihood = Math.max(analysis.speech[col], analysis.whisper[col] * 0.9);
      if (voiceLikelihood > 0.5) {
        ctx.fillStyle = `rgba(111,241,207,${0.04 + voiceLikelihood * 0.11})`;
        ctx.fillRect(x, 0, 1.5, h);
      }
      const low = analysis.waveform[col * 2], high = analysis.waveform[col * 2 + 1];
      ctx.strokeStyle = analysis.whisper[col] > analysis.speech[col] && analysis.whisper[col] > 0.5 ? "#f2ba53" : voiceLikelihood > 0.5 ? "#89f6d8" : "#3f8f7e";
      ctx.globalAlpha = 0.9; ctx.beginPath();
      ctx.moveTo(x, h / 2 + low * h * 0.44); ctx.lineTo(x, h / 2 + high * h * 0.44); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const cursor = range.cursorRatio * w;
    ctx.fillStyle = "#ffc85a"; ctx.fillRect(cursor - 1, 0, 2, h);
  }, [analysis, range.cursorRatio, range.span, range.start]);

  return <canvas ref={canvasRef} className="window-canvas" aria-label={`Waveform detail for the visible ${windowSeconds} second window. Tap to seek.`} onPointerDown={(e) => {
    if (!range.span) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(range.start + (e.clientX - rect.left) / rect.width * range.span);
  }}/>
}
