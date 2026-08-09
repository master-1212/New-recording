"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisData, EnhanceSettings, FocusSettings, LiveMetrics } from "@/types/audio";

const emptyMetrics: LiveMetrics = { speech: 0, whisper: 0, pitch: 0, profile: 0, profileConfidence: 0, peak: 0, rms: 0, dominant: 0 };

function voiceLikelihood(data: AnalysisData, index: number, sensitivity: number) {
  return Math.min(1, Math.max(data.speech[index], data.whisper[index] * (0.78 + sensitivity * 0.3)));
}

type RnnoiseModule = {
  loadRnnoise: (options: { url: string; simdUrl: string }) => Promise<ArrayBuffer>;
  RnnoiseWorkletNode: new (context: AudioContext, options: { wasmBinary: ArrayBuffer; maxChannels: number }) => AudioWorkletNode;
};

export function useAudioEngine(settings: EnhanceSettings, focus: FocusSettings) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const neuralDryRef = useRef<GainNode | null>(null);
  const neuralWetRef = useRef<GainNode | null>(null);
  const rnnoiseRef = useRef<AudioWorkletNode | null>(null);
  const rnnoisePromiseRef = useRef<Promise<void> | null>(null);
  const adaptiveGateRef = useRef<GainNode | null>(null);
  const transcriptionAudioRef = useRef<Float32Array | null>(null);
  const focusRef = useRef(focus);
  const analysisRef = useRef<AnalysisData | null>(null);
  const lastVoiceSkipRef = useRef(-1);
  const volumeValueRef = useRef(0.9);
  const filtersRef = useRef<{ highpass: BiquadFilterNode; low: BiquadFilterNode; presence: BiquadFilterNode; articulation: BiquadFilterNode; lowpass: BiquadFilterNode; comp: DynamicsCompressorNode; gain: GainNode } | null>(null);
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
  const [neuralStatus, setNeuralStatus] = useState<"off" | "loading" | "ready" | "error">("off");
  const [neuralDetail, setNeuralDetail] = useState("");

  useEffect(() => { focusRef.current = focus; }, [focus]);
  useEffect(() => { analysisRef.current = analysis; }, [analysis]);

  const updateMetrics = useCallback((time: number, data = analysis) => {
    if (!data || !data.duration) return setMetrics(emptyMetrics);
    const index = Math.min(data.columns - 1, Math.max(0, Math.floor(time / data.duration * data.columns)));
    setMetrics({
      speech: data.speech[index],
      whisper: data.whisper[index],
      pitch: data.pitch[index],
      profile: data.profile[index],
      profileConfidence: data.profileConfidence[index],
      peak: data.peak[index],
      rms: data.rms[index],
      dominant: data.dominant[index],
    });
  }, [analysis]);

  useEffect(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const time = audio.currentTime;
        setCurrentTime(time);
        updateMetrics(time);
        const data = analysisRef.current;
        const activeFocus = focusRef.current;
        if (data?.duration && !audio.paused) {
          const index = Math.min(data.columns - 1, Math.floor(time / data.duration * data.columns));
          const likelihood = voiceLikelihood(data, index, activeFocus.speechSensitivity);
          const detectionThreshold = 0.68 - activeFocus.speechSensitivity * 0.36;
          const gate = adaptiveGateRef.current;
          const context = contextRef.current;
          if (gate && context) {
            const learnedFloor = activeFocus.noiseFloor;
            const belowNoise = learnedFloor !== null && data.rms[index] < learnedFloor * 1.5;
            const attenuation = belowNoise && likelihood < detectionThreshold ? (activeFocus.whisperRecovery ? 0.32 : 0.08) : 1;
            gate.gain.setTargetAtTime(attenuation, context.currentTime, attenuation < 1 ? 0.035 : 0.018);
          }
          if (activeFocus.voiceOnly && likelihood < detectionThreshold - 0.06 && time - lastVoiceSkipRef.current > 0.25) {
            const confirmation = Math.max(2, Math.ceil(data.columns / data.duration * 0.35));
            let quiet = true;
            for (let i = index; i < Math.min(data.columns, index + confirmation); i++) quiet &&= voiceLikelihood(data, i, activeFocus.speechSensitivity) < detectionThreshold;
            if (quiet) {
              let next = index + confirmation;
              while (next < data.columns && voiceLikelihood(data, next, activeFocus.speechSensitivity) < detectionThreshold + 0.04) next++;
              if (next < data.columns) {
                const nextTime = Math.max(time, next / data.columns * data.duration - 0.08);
                if (nextTime - time > 0.2) {
                  audio.currentTime = nextTime;
                  lastVoiceSkipRef.current = nextTime;
                }
              }
            }
          }
        }
      }
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
    const whisperRecovery = focus.whisperRecovery ? 1 : 0;
    nodes.highpass.frequency.setTargetAtTime(65 + settings.strength * 45 - whisperRecovery * 18, now, 0.03);
    nodes.low.gain.setTargetAtTime(-settings.suppression * 7, now, 0.03);
    nodes.presence.gain.setTargetAtTime(settings.clarity * 8 + whisperRecovery * 2, now, 0.03);
    nodes.articulation.gain.setTargetAtTime(whisperRecovery * (3 + settings.clarity * 5), now, 0.03);
    nodes.lowpass.frequency.setTargetAtTime(20000 - whisperRecovery * 11800, now, 0.03);
    nodes.comp.threshold.setTargetAtTime(-14 - settings.strength * 18 - whisperRecovery * 8, now, 0.03);
    nodes.comp.ratio.setTargetAtTime(2 + settings.strength * 5, now, 0.03);
    nodes.gain.gain.setTargetAtTime(Math.pow(10, ((settings.gain - 0.5) * 14 + settings.strength * 3 + whisperRecovery * 4) / 20), now, 0.03);
  }, [focus.whisperRecovery, settings]);

  const ensureGraph = useCallback(() => {
    if (contextRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const neuralDry = context.createGain(), neuralWet = context.createGain(), preprocess = context.createGain();
    const dry = context.createGain(), wet = context.createGain(), master = context.createGain();
    const highpass = context.createBiquadFilter(); highpass.type = "highpass";
    const low = context.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 230;
    const presence = context.createBiquadFilter(); presence.type = "peaking"; presence.frequency.value = 2700; presence.Q.value = 0.75;
    const articulation = context.createBiquadFilter(); articulation.type = "peaking"; articulation.frequency.value = 4600; articulation.Q.value = 0.9;
    const lowpass = context.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.frequency.value = 20000; lowpass.Q.value = 0.7;
    const comp = context.createDynamicsCompressor(); comp.attack.value = 0.008; comp.release.value = 0.18; comp.knee.value = 12;
    const gain = context.createGain(), adaptiveGate = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.08;
    source.connect(neuralDry).connect(preprocess);
    neuralWet.connect(preprocess);
    preprocess.connect(dry).connect(master);
    preprocess.connect(highpass).connect(low).connect(presence).connect(articulation).connect(lowpass).connect(comp).connect(gain).connect(adaptiveGate).connect(wet).connect(master);
    master.connect(limiter).connect(context.destination);
    dry.gain.value = 1; wet.gain.value = 0; neuralDry.gain.value = 1; neuralWet.gain.value = 0;
    master.gain.value = volumeValueRef.current;
    contextRef.current = context; sourceRef.current = source; wetGainRef.current = wet; dryGainRef.current = dry; masterGainRef.current = master;
    neuralDryRef.current = neuralDry; neuralWetRef.current = neuralWet; adaptiveGateRef.current = adaptiveGate;
    filtersRef.current = { highpass, low, presence, articulation, lowpass, comp, gain };
  }, []);

  const initRnnoise = useCallback(async () => {
    const context = contextRef.current;
    const source = sourceRef.current;
    const neuralWet = neuralWetRef.current;
    if (!context || !source || !neuralWet || rnnoiseRef.current) return;
    if (rnnoisePromiseRef.current) return rnnoisePromiseRef.current;
    const task = (async () => {
      setNeuralStatus("loading");
      setNeuralDetail("");
      try {
        const moduleUrl = "/runtime/kernel.js";
        const rnnoiseLibrary = (await import(/* webpackIgnore: true */ moduleUrl)) as RnnoiseModule;
        const base = "/runtime/";
        const wasmBinary = await rnnoiseLibrary.loadRnnoise({ url: `${base}core.wasm`, simdUrl: `${base}core-simd.wasm` });
        await context.audioWorklet.addModule(`${base}processor.js`);
        const node = new rnnoiseLibrary.RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 2 });
        source.connect(node).connect(neuralWet);
        rnnoiseRef.current = node;
        setNeuralStatus("ready");
      } catch (cause) {
        setNeuralStatus("error");
        setNeuralDetail(cause instanceof Error ? cause.message : "runtime unavailable");
      }
    })();
    rnnoisePromiseRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    const context = contextRef.current;
    const dry = neuralDryRef.current;
    const wet = neuralWetRef.current;
    if (!context || !dry || !wet) return;
    if (focus.neuralDenoise > 0 && !rnnoiseRef.current) void initRnnoise();
    const amount = rnnoiseRef.current ? focus.neuralDenoise : 0;
    dry.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), context.currentTime, 0.035);
    wet.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), context.currentTime, 0.035);
    if (amount === 0 && neuralStatus === "ready") setNeuralStatus("off");
    if (amount > 0 && neuralStatus === "off") setNeuralStatus("ready");
  }, [focus.neuralDenoise, initRnnoise, neuralStatus]);

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
      const ratio = buffer.sampleRate / 16000;
      const transcriptionAudio = new Float32Array(Math.ceil(mono.length / ratio));
      for (let i = 0; i < transcriptionAudio.length; i++) {
        const start = Math.floor(i * ratio), end = Math.min(mono.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = start; j < end; j++) sum += mono[j];
        transcriptionAudio[i] = sum / Math.max(1, end - start);
      }
      transcriptionAudioRef.current = transcriptionAudio;
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
    ensureGraph();
    if (focusRef.current.neuralDenoise > 0) void initRnnoise();
    await contextRef.current?.resume();
    if (audio.paused) await audio.play(); else audio.pause();
  }, [ensureGraph, initRnnoise]);
  const seek = useCallback((time: number) => { if (!audioRef.current) return; audioRef.current.currentTime = Math.max(0, Math.min(duration, time)); setCurrentTime(audioRef.current.currentTime); updateMetrics(audioRef.current.currentTime); }, [duration, updateMetrics]);
  const skip = useCallback((delta: number) => seek((audioRef.current?.currentTime || 0) + delta), [seek]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); contextRef.current?.close(); }, []);

  return { audioRef, fileName, duration, currentTime, playing, analysis, progress, error, metrics, neuralStatus, neuralDetail, loadFile, playPause, seek, skip,
    takeTranscriptionAudio: () => {
      const audio = transcriptionAudioRef.current;
      transcriptionAudioRef.current = null;
      return audio;
    },
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
