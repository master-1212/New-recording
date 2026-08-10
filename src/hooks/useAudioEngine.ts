"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { analysisFrameAtTime } from "@/lib/analysisClock";
import { computeAdaptiveFrame, computeDspParameters, voiceLikelihood } from "@/lib/dsp";
import type { AnalysisData, EnhanceSettings, FocusSettings, LiveMetrics } from "@/types/audio";

const emptyMetrics: LiveMetrics = { speech: 0, whisper: 0, noise: 0, clarity: 0, pitch: 0, profile: 0, profileConfidence: 0, peak: 0, rms: 0, dominant: 0 };

type FilterNodes = {
  highpass: BiquadFilterNode;
  low: BiquadFilterNode;
  hum50: BiquadFilterNode;
  hum100: BiquadFilterNode;
  mud: BiquadFilterNode;
  intelligibility: BiquadFilterNode;
  presence: BiquadFilterNode;
  articulation: BiquadFilterNode;
  hiss: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  gain: GainNode;
};

function applyFilterSettings(context: AudioContext, nodes: FilterNodes, settings: EnhanceSettings, focus: FocusSettings) {
  const now = context.currentTime;
  const parameters = computeDspParameters(settings, focus);
  nodes.highpass.frequency.setTargetAtTime(parameters.highpassHz, now, 0.025);
  nodes.low.gain.setTargetAtTime(parameters.lowShelfDb, now, 0.025);
  nodes.hum50.gain.setTargetAtTime(parameters.hum50Db, now, 0.025);
  nodes.hum100.gain.setTargetAtTime(parameters.hum100Db, now, 0.025);
  nodes.mud.gain.setTargetAtTime(parameters.mudDb, now, 0.025);
  nodes.intelligibility.gain.setTargetAtTime(parameters.intelligibilityDb, now, 0.025);
  nodes.presence.gain.setTargetAtTime(parameters.presenceDb, now, 0.025);
  nodes.articulation.gain.setTargetAtTime(parameters.articulationDb, now, 0.025);
  nodes.hiss.gain.setTargetAtTime(parameters.hissShelfDb, now, 0.025);
  nodes.lowpass.frequency.setTargetAtTime(parameters.lowpassHz, now, 0.025);
  nodes.comp.threshold.setTargetAtTime(parameters.compressorThresholdDb, now, 0.025);
  nodes.comp.ratio.setTargetAtTime(parameters.compressorRatio, now, 0.025);
  nodes.gain.gain.setTargetAtTime(Math.pow(10, parameters.makeupDb / 20), now, 0.025);
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
  const rnnoiseConnectedRef = useRef(false);
  const rnnoisePromiseRef = useRef<Promise<void> | null>(null);
  const adaptiveGateRef = useRef<GainNode | null>(null);
  const adaptiveVoiceGainRef = useRef<GainNode | null>(null);
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
  const filtersRef = useRef<FilterNodes | null>(null);
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
      noise: data.noise[index],
      clarity: data.clarity[index],
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
          const likelihood = voiceLikelihood(data.speech[index], data.whisper[index], activeFocus.speechSensitivity);
          const threshold = 0.68 - activeFocus.speechSensitivity * 0.36;
          const gate = adaptiveGateRef.current;
          const voiceGain = adaptiveVoiceGainRef.current;
          const context = contextRef.current;
          if (gate && voiceGain && context) {
            const noiseIndex = Math.min(data.noiseFrames - 1, Math.max(0, Math.floor(time / data.duration * data.noiseFrames)));
            const currentRms = data.noiseRms[noiseIndex] || data.rms[index];
            const adaptive = computeAdaptiveFrame({
              speech: data.speech[index],
              whisper: data.whisper[index],
              noise: data.noise[index],
              clarity: data.clarity[index],
              rms: currentRms,
            }, settingsRef.current, activeFocus);
            gate.gain.setTargetAtTime(adaptive.gateGain, context.currentTime, adaptive.gateGain < 1 ? 0.045 : 0.02);
            voiceGain.gain.setTargetAtTime(adaptive.voiceGain, context.currentTime, adaptive.voiceGain > 1 ? 0.055 : 0.025);
            publishNoiseReduction(adaptive.reductionDb);
          }
          if (activeFocus.voiceOnly && likelihood < threshold - 0.06 && time - lastVoiceSkipRef.current > 0.25) {
            const confirmation = Math.max(2, Math.ceil(data.columns / data.duration * 0.35));
            let quiet = true;
            for (let i = index; i < Math.min(data.columns, index + confirmation); i++) {
              quiet &&= voiceLikelihood(data.speech[i], data.whisper[i], activeFocus.speechSensitivity) < threshold;
            }
            if (quiet) {
              let next = index + confirmation;
              while (next < data.columns && voiceLikelihood(data.speech[next], data.whisper[next], activeFocus.speechSensitivity) < threshold + 0.04) next++;
              if (next < data.columns) {
                const nextTime = Math.max(time, next / data.columns * data.duration - 0.08);
                if (nextTime - time > 0.2) {
                  audio.currentTime = nextTime;
                  lastVoiceSkipRef.current = nextTime;
                }
              }
            }
          }
        } else {
          const context = contextRef.current;
          if (context) {
            adaptiveGateRef.current?.gain.setTargetAtTime(1, context.currentTime, 0.02);
            adaptiveVoiceGainRef.current?.gain.setTargetAtTime(1, context.currentTime, 0.02);
          }
          publishNoiseReduction(0);
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [publishNoiseReduction, updateMetrics]);

  useEffect(() => {
    const nodes = filtersRef.current;
    const context = contextRef.current;
    if (!nodes || !context || !wetGainRef.current || !dryGainRef.current) return;
    const now = context.currentTime;
    const active = settings.enabled ? 1 : 0;
    wetGainRef.current.gain.setTargetAtTime(active, now, 0.015);
    dryGainRef.current.gain.setTargetAtTime(1 - active, now, 0.015);
    applyFilterSettings(context, nodes, settings, focus);
    if (!settings.enabled) {
      adaptiveGateRef.current?.gain.setTargetAtTime(1, now, 0.015);
      adaptiveVoiceGainRef.current?.gain.setTargetAtTime(1, now, 0.015);
      publishNoiseReduction(0);
    }
  }, [focus, publishNoiseReduction, settings]);

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
    const hum50 = context.createBiquadFilter(); hum50.type = "peaking"; hum50.frequency.value = 50; hum50.Q.value = 12;
    const hum100 = context.createBiquadFilter(); hum100.type = "peaking"; hum100.frequency.value = 100; hum100.Q.value = 10;
    const mud = context.createBiquadFilter(); mud.type = "peaking"; mud.frequency.value = 430; mud.Q.value = 0.9;
    const intelligibility = context.createBiquadFilter(); intelligibility.type = "peaking"; intelligibility.frequency.value = 1550; intelligibility.Q.value = 0.72;
    const presence = context.createBiquadFilter(); presence.type = "peaking"; presence.frequency.value = 2700; presence.Q.value = 0.75;
    const articulation = context.createBiquadFilter(); articulation.type = "peaking"; articulation.frequency.value = 4600; articulation.Q.value = 0.9;
    const hiss = context.createBiquadFilter(); hiss.type = "highshelf"; hiss.frequency.value = 7200;
    const lowpass = context.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.frequency.value = 20000; lowpass.Q.value = 0.7;
    const comp = context.createDynamicsCompressor(); comp.attack.value = 0.008; comp.release.value = 0.18; comp.knee.value = 12;
    const gain = context.createGain(), adaptiveVoiceGain = context.createGain(), adaptiveGate = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.08;
    // Original/A receives the media element directly. Neural denoising and all
    // EQ/dynamics live exclusively on the Enhanced/B branch.
    source.connect(dry).connect(master);
    source.connect(neuralDry).connect(preprocess);
    neuralWet.connect(preprocess);
    preprocess.connect(highpass).connect(low).connect(hum50).connect(hum100).connect(mud).connect(intelligibility).connect(presence).connect(articulation).connect(hiss).connect(lowpass).connect(comp).connect(gain).connect(adaptiveVoiceGain).connect(adaptiveGate).connect(wet).connect(master);
    master.connect(limiter).connect(context.destination);
    dry.gain.value = settingsRef.current.enabled ? 0 : 1;
    wet.gain.value = settingsRef.current.enabled ? 1 : 0;
    neuralDry.gain.value = 1; neuralWet.gain.value = 0;
    adaptiveVoiceGain.gain.value = 1; adaptiveGate.gain.value = 1;
    master.gain.value = volumeValueRef.current;
    contextRef.current = context; sourceRef.current = source; wetGainRef.current = wet; dryGainRef.current = dry; masterGainRef.current = master;
    neuralDryRef.current = neuralDry; neuralWetRef.current = neuralWet; adaptiveGateRef.current = adaptiveGate; adaptiveVoiceGainRef.current = adaptiveVoiceGain;
    const filters = { highpass, low, hum50, hum100, mud, intelligibility, presence, articulation, hiss, lowpass, comp, gain };
    filtersRef.current = filters;
    applyFilterSettings(context, filters, settingsRef.current, focusRef.current);
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
        node.connect(neuralWet);
        rnnoiseRef.current = node;
        if (settingsRef.current.enabled && focusRef.current.neuralDenoise > 0) {
          source.connect(node);
          rnnoiseConnectedRef.current = true;
          const amount = focusRef.current.neuralDenoise;
          neuralDryRef.current?.gain.setTargetAtTime(1 - amount, context.currentTime, 0.035);
          neuralWet.gain.setTargetAtTime(amount, context.currentTime, 0.035);
        }
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
        if (rnnoiseConnectedRef.current) {
          try { sourceRef.current?.disconnect(node); } catch { /* Already disconnected. */ }
        }
        rnnoiseConnectedRef.current = false;
        node.disconnect();
        node.port.close();
        rnnoiseRef.current = null;
      }
      return;
    }
    if (!settings.enabled) {
      dry.gain.setTargetAtTime(1, context.currentTime, 0.035);
      wet.gain.setTargetAtTime(0, context.currentTime, 0.035);
      if (rnnoiseRef.current && rnnoiseConnectedRef.current) {
        try { sourceRef.current?.disconnect(rnnoiseRef.current); } catch { /* Already disconnected. */ }
        rnnoiseConnectedRef.current = false;
      }
      return;
    }
    if (!rnnoiseRef.current) void initRnnoise();
    if (rnnoiseRef.current && !rnnoiseConnectedRef.current) {
      sourceRef.current?.connect(rnnoiseRef.current);
      rnnoiseConnectedRef.current = true;
    }
    const amount = rnnoiseRef.current ? focus.neuralDenoise : 0;
    // Linear crossfade avoids the +3 dB correlated-signal boost produced by
    // equal-power mixing, which previously raised background noise.
    dry.gain.setTargetAtTime(1 - amount, context.currentTime, 0.035);
    wet.gain.setTargetAtTime(amount, context.currentTime, 0.035);
  }, [focus.neuralDenoise, initRnnoise, settings.enabled]);

  const loadFile = useCallback(async (file: File, resumeAt = 0) => {
    const generation = ++loadGenerationRef.current;
    analysisWorkerRef.current?.terminate();
    analysisWorkerRef.current = null;
    audioRef.current?.pause();
    setPlaying(false); setError(""); setProgress(0.01); setAnalysis(null); setFileName(file.name);
    fileRef.current = file;
    pendingSeekRef.current = Math.max(0, resumeAt);
    try {
      let encodedAudio = await file.arrayBuffer();
      const decodeContext = new AudioContext();
      const buffer = await decodeContext.decodeAudioData(encodedAudio);
      encodedAudio = new ArrayBuffer(0);
      if (generation !== loadGenerationRef.current) {
        await decodeContext.close();
        return false;
      }
      // The media element handles full-quality playback. Analysis needs only a
      // speech-band copy, so cap it at 12 kHz instead of retaining another
      // full-rate 30–60 minute PCM allocation on memory-constrained iPads.
      const analysisSampleRate = Math.min(12_000, buffer.sampleRate);
      const analysisLength = Math.max(1, Math.ceil(buffer.duration * analysisSampleRate));
      const mono = new Float32Array(analysisLength);
      const ratio = buffer.sampleRate / analysisSampleRate;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
      for (let index = 0; index < analysisLength; index++) {
        const position = Math.min(buffer.length - 1, index * ratio);
        const before = Math.floor(position);
        const after = Math.min(buffer.length - 1, before + 1);
        const fraction = position - before;
        let mixed = 0;
        for (const channel of channels) mixed += channel[before] * (1 - fraction) + channel[after] * fraction;
        mono[index] = mixed / channels.length;
      }
      const decodedDuration = buffer.duration;
      await decodeContext.close();
      const worker = new Worker(new URL("../workers/analyze.worker.ts", import.meta.url), { type: "module" });
      analysisWorkerRef.current = worker;
      worker.onmessage = ({ data: message }) => {
        if (generation !== loadGenerationRef.current) return worker.terminate();
        if (message.type === "progress") setProgress(message.progress);
        if (message.type === "complete") { setAnalysis(message.analysis); setProgress(1); worker.terminate(); analysisWorkerRef.current = null; }
      };
      worker.onerror = () => { setError("The recording decoded, but spectral analysis could not finish."); worker.terminate(); analysisWorkerRef.current = null; };
      worker.postMessage({ samples: mono, sampleRate: analysisSampleRate, duration: decodedDuration }, [mono.buffer]);
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
    if (settingsRef.current.enabled && focusRef.current.neuralDenoise > 0) void initRnnoise();
    await contextRef.current?.resume();
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setError("Playback was blocked. Tap Play again after confirming the browser allows audio.");
      }
    } else audio.pause();
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
    rnnoiseRef.current?.port.close();
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
