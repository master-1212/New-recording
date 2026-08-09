"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { analysisFrameAtTime } from "@/lib/analysisClock";
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
  const fileRef = useRef<File | null>(null);
  const analysisWorkerRef = useRef<Worker | null>(null);
  const pendingSeekRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const transcriptionPromiseRef = useRef<Promise<Float32Array | null> | null>(null);
  const focusRef = useRef(focus);
  const settingsRef = useRef(settings);
  const analysisRef = useRef<AnalysisData | null>(null);
  const noiseReductionRef = useRef(0);
  const lastVoiceSkipRef = useRef(-1);
  const volumeValueRef = useRef(0.9);
  const filtersRef = useRef<{ highpass: BiquadFilterNode; low: BiquadFilterNode; presence: BiquadFilterNode; articulation: BiquadFilterNode; lowpass: BiquadFilterNode; comp: DynamicsCompressorNode; gain: GainNode } | null>(null);
  const urlRef = useRef<string | null>(null);
  const frameRef = useRef(0);
  const lastUiFrameRef = useRef(0);
  const lastReportedTimeRef = useRef(-1);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<LiveMetrics>(emptyMetrics);
  const [noiseReductionDb, setNoiseReductionDb] = useState(0);
  const [neuralStatus, setNeuralStatus] = useState<"off" | "loading" | "ready" | "error">("off");
  const [neuralDetail, setNeuralDetail] = useState("");

  useEffect(() => { focusRef.current = focus; }, [focus]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { analysisRef.current = analysis; }, [analysis]);

  const publishNoiseReduction = useCallback((value: number) => {
    if (Math.abs(noiseReductionRef.current - value) < 0.05) return;
    noiseReductionRef.current = value;
    setNoiseReductionDb(value);
  }, []);

  const updateMetrics = useCallback((time: number, data = analysis) => {
    if (!data || !data.duration) return setMetrics(emptyMetrics);
    const index = analysisFrameAtTime(data, time);
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
    const tick = (timestamp: number) => {
      const audio = audioRef.current;
      if (audio && timestamp - lastUiFrameRef.current >= 66) {
        lastUiFrameRef.current = timestamp;
        const time = audio.currentTime;
        if (Math.abs(time - lastReportedTimeRef.current) >= 0.015) {
          lastReportedTimeRef.current = time;
          setCurrentTime(time);
          updateMetrics(time);
        }
        const data = analysisRef.current;
        const activeFocus = focusRef.current;
        if (data?.duration && !audio.paused) {
          const index = analysisFrameAtTime(data, time);
          const likelihood = voiceLikelihood(data, index, activeFocus.speechSensitivity);
          const detectionThreshold = 0.68 - activeFocus.speechSensitivity * 0.36;
          const gate = adaptiveGateRef.current;
          const context = contextRef.current;
          if (gate && context) {
            const learnedFloor = activeFocus.noiseFloor;
            const profileActive = activeFocus.noiseProfileEnabled && learnedFloor !== null;
            const noiseIndex = Math.min(data.noiseFrames - 1, Math.max(0, Math.floor(time / data.duration * data.noiseFrames)));
            const currentRms = data.noiseRms[noiseIndex] || data.rms[index];
            const belowNoise = profileActive && currentRms < learnedFloor * 1.65;
            const noiseAmount = belowNoise ? Math.min(1, Math.max(0, 1 - likelihood / Math.max(0.1, detectionThreshold))) : 0;
            const whisperProtection = activeFocus.whisperRecovery ? 0.55 : 1;
            const reductionDb = noiseAmount * (8 + settingsRef.current.suppression * 18) * whisperProtection;
            const attenuation = Math.pow(10, -reductionDb / 20);
            gate.gain.setTargetAtTime(attenuation, context.currentTime, attenuation < 1 ? 0.035 : 0.018);
            publishNoiseReduction(settingsRef.current.enabled ? reductionDb : 0);
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
        } else publishNoiseReduction(0);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [publishNoiseReduction, updateMetrics]);

  useEffect(() => {
    if (focus.noiseProfileEnabled && focus.noiseFloor !== null) return;
    const gate = adaptiveGateRef.current;
    const context = contextRef.current;
    if (gate && context) gate.gain.setTargetAtTime(1, context.currentTime, 0.018);
    publishNoiseReduction(0);
  }, [focus.noiseFloor, focus.noiseProfileEnabled, publishNoiseReduction]);

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
    void task.finally(() => {
      if (rnnoisePromiseRef.current === task) rnnoisePromiseRef.current = null;
    });
    return task;
  }, []);

  useEffect(() => {
    const context = contextRef.current;
    const dry = neuralDryRef.current;
    const wet = neuralWetRef.current;
    if (!context || !dry || !wet) return;
    if (focus.neuralDenoise === 0) {
      dry.gain.setTargetAtTime(1, context.currentTime, 0.035);
      wet.gain.setTargetAtTime(0, context.currentTime, 0.035);
      const node = rnnoiseRef.current;
      if (node) {
        try { sourceRef.current?.disconnect(node); } catch { /* Already disconnected. */ }
        node.disconnect();
        node.port.close();
        rnnoiseRef.current = null;
      }
      return;
    }
    if (focus.neuralDenoise > 0 && !rnnoiseRef.current) void initRnnoise();
    const amount = rnnoiseRef.current ? focus.neuralDenoise : 0;
    dry.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), context.currentTime, 0.035);
    wet.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), context.currentTime, 0.035);
  }, [focus.neuralDenoise, initRnnoise]);

  const loadFile = useCallback(async (file: File, resumeAt = 0) => {
    const generation = ++loadGenerationRef.current;
    analysisWorkerRef.current?.terminate();
    analysisWorkerRef.current = null;
    audioRef.current?.pause();
    setPlaying(false); setError(""); setProgress(0.01); setAnalysis(null); setFileName(file.name);
    fileRef.current = file;
    pendingSeekRef.current = Math.max(0, resumeAt);
    try {
      const data = await file.arrayBuffer();
      const decodeContext = new AudioContext();
      const buffer = await decodeContext.decodeAudioData(data);
      if (generation !== loadGenerationRef.current) {
        await decodeContext.close();
        return false;
      }
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const input = buffer.getChannelData(channel);
        for (let i = 0; i < input.length; i++) mono[i] += input[i] / buffer.numberOfChannels;
      }
      const decodedDuration = buffer.duration;
      const sampleRate = buffer.sampleRate;
      await decodeContext.close();
      const worker = new Worker(new URL("../workers/analyze.worker.ts", import.meta.url), { type: "module" });
      analysisWorkerRef.current = worker;
      worker.onmessage = ({ data: message }) => {
        if (generation !== loadGenerationRef.current) return worker.terminate();
        if (message.type === "progress") setProgress(message.progress);
        if (message.type === "complete") { setAnalysis(message.analysis); setProgress(1); worker.terminate(); analysisWorkerRef.current = null; }
      };
      worker.onerror = () => { setError("The recording decoded, but spectral analysis could not finish."); worker.terminate(); analysisWorkerRef.current = null; };
      worker.postMessage({ samples: mono, sampleRate, duration: decodedDuration }, [mono.buffer]);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file); urlRef.current = url;
      if (audioRef.current) { audioRef.current.src = url; audioRef.current.load(); }
      setDuration(decodedDuration);
      setCurrentTime(Math.min(decodedDuration, pendingSeekRef.current));
      return true;
    } catch {
      if (generation !== loadGenerationRef.current) return false;
      fileRef.current = null;
      setFileName("");
      setError("This browser could not decode that audio file. Try WAV, MP3, M4A, or AAC.");
      setProgress(0);
      return false;
    }
  }, []);

  const prepareTranscriptionAudio = useCallback(async () => {
    if (transcriptionPromiseRef.current) return transcriptionPromiseRef.current;
    const file = fileRef.current;
    const generation = loadGenerationRef.current;
    if (!file) return null;
    const task = (async () => {
      const decodeContext = new AudioContext();
      try {
        const buffer = await decodeContext.decodeAudioData(await file.arrayBuffer());
        if (generation !== loadGenerationRef.current) return null;
        const targetRate = 16000;
        const ratio = buffer.sampleRate / targetRate;
        const output = new Float32Array(Math.ceil(buffer.length / ratio));
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
        for (let index = 0; index < output.length; index++) {
          const start = Math.floor(index * ratio);
          const end = Math.min(buffer.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
          let sum = 0;
          for (const channel of channels) for (let sample = start; sample < end; sample++) sum += channel[sample];
          output[index] = sum / Math.max(1, (end - start) * channels.length);
        }
        return generation === loadGenerationRef.current ? output : null;
      } finally {
        await decodeContext.close();
      }
    })();
    transcriptionPromiseRef.current = task;
    try {
      return await task;
    } finally {
      transcriptionPromiseRef.current = null;
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
  const getCurrentTime = useCallback(() => audioRef.current?.currentTime ?? 0, []);
  const setRate = useCallback((value: number) => {
    if (!audioRef.current) return;
    audioRef.current.preservesPitch = true;
    audioRef.current.playbackRate = Math.max(0.5, Math.min(2, value));
  }, []);
  const setVolume = useCallback((value: number) => {
    const safeValue = Math.max(0, Math.min(5, value));
    volumeValueRef.current = safeValue;
    const context = contextRef.current;
    if (context && masterGainRef.current) masterGainRef.current.gain.setTargetAtTime(safeValue, context.currentTime, 0.015);
  }, []);
  const setLoop = useCallback((value: boolean) => {
    if (audioRef.current) audioRef.current.loop = value;
  }, []);

  useEffect(() => () => {
    analysisWorkerRef.current?.terminate();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    contextRef.current?.close();
  }, []);

  return { audioRef, fileName, duration, currentTime, playing, analysis, progress, error, metrics, noiseReductionDb, neuralStatus, neuralDetail, loadFile, playPause, seek, skip,
    prepareTranscriptionAudio,
    getCurrentTime,
    setRate,
    setVolume,
    setLoop,
    events: {
      onPlay: () => setPlaying(true),
      onPause: () => { setPlaying(false); setCurrentTime(audioRef.current?.currentTime ?? 0); },
      onEnded: () => setPlaying(false),
      onLoadedMetadata: () => {
        const audio = audioRef.current;
        if (!audio) return;
        const target = Math.min(Number.isFinite(audio.duration) ? audio.duration : duration, pendingSeekRef.current);
        audio.currentTime = target;
        setCurrentTime(target);
        pendingSeekRef.current = 0;
      },
      onDurationChange: () => setDuration(audioRef.current?.duration || duration),
    }
  };
}
