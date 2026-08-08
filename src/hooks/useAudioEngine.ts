"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisData, EnhanceSettings, LiveMetrics } from "@/types/audio";

const emptyMetrics: LiveMetrics = { speech: 0, peak: 0, rms: 0, dominant: 0 };

export function useAudioEngine(settings: EnhanceSettings) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const volumeValueRef = useRef(0.9);
  const filtersRef = useRef<{ highpass: BiquadFilterNode; low: BiquadFilterNode; presence: BiquadFilterNode; comp: DynamicsCompressorNode; gain: GainNode } | null>(null);
  const urlRef = useRef<string | null>(null);
  const frameRef = useRef(0);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<LiveMetrics>(emptyMetrics);

  const updateMetrics = useCallback((time: number, data = analysis) => {
    if (!data || !data.duration) return setMetrics(emptyMetrics);
    const index = Math.min(data.columns - 1, Math.max(0, Math.floor(time / data.duration * data.columns)));
    setMetrics({ speech: data.speech[index], peak: data.peak[index], rms: data.rms[index], dominant: data.dominant[index] });
  }, [analysis]);

  useEffect(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (audio) { setCurrentTime(audio.currentTime); updateMetrics(audio.currentTime); }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [updateMetrics]);

  useEffect(() => {
    const nodes = filtersRef.current;
    const context = contextRef.current;
    if (!nodes || !context || !wetGainRef.current || !dryGainRef.current) return;
    const now = context.currentTime;
    const active = settings.enabled ? 1 : 0;
    wetGainRef.current.gain.setTargetAtTime(active, now, 0.015);
    dryGainRef.current.gain.setTargetAtTime(1 - active, now, 0.015);
    nodes.highpass.frequency.setTargetAtTime(65 + settings.strength * 45, now, 0.03);
    nodes.low.gain.setTargetAtTime(-settings.suppression * 7, now, 0.03);
    nodes.presence.gain.setTargetAtTime(settings.clarity * 8, now, 0.03);
    nodes.comp.threshold.setTargetAtTime(-14 - settings.strength * 18, now, 0.03);
    nodes.comp.ratio.setTargetAtTime(2 + settings.strength * 5, now, 0.03);
    nodes.gain.gain.setTargetAtTime(Math.pow(10, ((settings.gain - 0.5) * 14 + settings.strength * 3) / 20), now, 0.03);
  }, [settings]);

  const ensureGraph = useCallback(() => {
    if (contextRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const dry = context.createGain(), wet = context.createGain(), master = context.createGain();
    const highpass = context.createBiquadFilter(); highpass.type = "highpass";
    const low = context.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 230;
    const presence = context.createBiquadFilter(); presence.type = "peaking"; presence.frequency.value = 2700; presence.Q.value = 0.75;
    const comp = context.createDynamicsCompressor(); comp.attack.value = 0.008; comp.release.value = 0.18; comp.knee.value = 12;
    const gain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.08;
    source.connect(dry).connect(master);
    source.connect(highpass).connect(low).connect(presence).connect(comp).connect(gain).connect(wet).connect(master);
    master.connect(limiter).connect(context.destination);
    dry.gain.value = 1; wet.gain.value = 0;
    master.gain.value = volumeValueRef.current;
    contextRef.current = context; wetGainRef.current = wet; dryGainRef.current = dry; masterGainRef.current = master;
    filtersRef.current = { highpass, low, presence, comp, gain };
  }, []);

  const loadFile = useCallback(async (file: File) => {
    setError(""); setProgress(0.01); setAnalysis(null); setFileName(file.name);
    try {
      const data = await file.arrayBuffer();
      const decodeContext = new AudioContext();
      const buffer = await decodeContext.decodeAudioData(data.slice(0));
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const input = buffer.getChannelData(channel);
        for (let i = 0; i < input.length; i++) mono[i] += input[i] / buffer.numberOfChannels;
      }
      await decodeContext.close();
      const worker = new Worker(new URL("../workers/analyze.worker.ts", import.meta.url));
      worker.onmessage = ({ data: message }) => {
        if (message.type === "progress") setProgress(message.progress);
        if (message.type === "complete") { setAnalysis(message.analysis); setProgress(1); worker.terminate(); }
      };
      worker.onerror = () => { setError("The recording decoded, but spectral analysis could not finish."); worker.terminate(); };
      worker.postMessage({ samples: mono, sampleRate: buffer.sampleRate, duration: buffer.duration }, [mono.buffer]);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file); urlRef.current = url;
      if (audioRef.current) { audioRef.current.src = url; audioRef.current.load(); }
      setDuration(buffer.duration);
    } catch {
      setError("This browser could not decode that audio file. Try WAV, MP3, M4A, or AAC.");
      setProgress(0);
    }
  }, []);

  const playPause = useCallback(async () => {
    const audio = audioRef.current; if (!audio?.src) return;
    ensureGraph(); await contextRef.current?.resume();
    if (audio.paused) await audio.play(); else audio.pause();
  }, [ensureGraph]);
  const seek = useCallback((time: number) => { if (!audioRef.current) return; audioRef.current.currentTime = Math.max(0, Math.min(duration, time)); setCurrentTime(audioRef.current.currentTime); updateMetrics(audioRef.current.currentTime); }, [duration, updateMetrics]);
  const skip = useCallback((delta: number) => seek((audioRef.current?.currentTime || 0) + delta), [seek]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); contextRef.current?.close(); }, []);

  return { audioRef, fileName, duration, currentTime, playing, analysis, progress, error, metrics, loadFile, playPause, seek, skip,
    setRate: (v: number) => {
      if (!audioRef.current) return;
      audioRef.current.preservesPitch = true;
      audioRef.current.playbackRate = Math.max(0.5, Math.min(2, v));
    },
    setVolume: (v: number) => {
      const safeValue = Math.max(0, Math.min(5, v));
      volumeValueRef.current = safeValue;
      const context = contextRef.current;
      if (context && masterGainRef.current) masterGainRef.current.gain.setTargetAtTime(safeValue, context.currentTime, 0.015);
    },
    setLoop: (v: boolean) => { if (audioRef.current) audioRef.current.loop = v; },
    events: { onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false), onDurationChange: () => setDuration(audioRef.current?.duration || duration) }
  };
}
