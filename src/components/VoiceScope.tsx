"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AudioLines, BrainCircuit, Captions, ChevronRight, Focus, Gauge, Info, LockKeyhole, Pause, Play, Repeat2, RotateCcw, ScanLine, SlidersHorizontal, Sparkles, Upload, Volume2, Waves } from "lucide-react";
import { Spectrogram3D } from "./Spectrogram3D";
import { Overview, WindowWaveform } from "./Overview";
import { KnobSlider } from "./KnobSlider";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { db, formatTime } from "@/lib/format";
import type { EnhanceSettings, FocusSettings, TranscriptWord } from "@/types/audio";

export function VoiceScope() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<EnhanceSettings>({ enabled: false, strength: 0.58, clarity: 0.62, suppression: 0.48, gain: 0.55 });
  const [windowSeconds, setWindowSeconds] = useState(30);
  const [depth, setDepth] = useState(0.72);
  const [rate, setRateValue] = useState(1);
  const [volume, setVolumeValue] = useState(0.9);
  const [loop, setLoopValue] = useState(false);
  const [focus, setFocus] = useState<FocusSettings>({ voiceOnly: false, neuralDenoise: 0, noiseFloor: null });
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false);
  const [transcriptStatus, setTranscriptStatus] = useState("Off");
  const [transcriptProgress, setTranscriptProgress] = useState(0);
  const [transcriptWords, setTranscriptWords] = useState<TranscriptWord[]>([]);
  const [noiseHint, setNoiseHint] = useState("Use a quiet 5-second region");
  const transcriptWorkerRef = useRef<Worker | null>(null);
  const engine = useAudioEngine(settings, focus);
  const setSetting = <K extends keyof EnhanceSettings>(key: K, value: EnhanceSettings[K]) => setSettings((old) => ({ ...old, [key]: value }));
  const ready = Boolean(engine.fileName);

  useEffect(() => () => transcriptWorkerRef.current?.terminate(), []);

  const applySpeechFocus = () => {
    setSettings({ enabled: true, strength: 0.84, clarity: 0.82, suppression: 0.76, gain: 0.64 });
    setFocus((old) => ({ ...old, neuralDenoise: Math.max(old.neuralDenoise, 0.7) }));
  };

  const learnNoiseProfile = () => {
    const data = engine.analysis;
    if (!data?.duration) return;
    const center = Math.floor(engine.currentTime / data.duration * data.columns);
    const radius = Math.max(3, Math.floor(data.columns / data.duration * 2.5));
    const candidates: number[] = [];
    for (let i = Math.max(0, center - radius); i <= Math.min(data.columns - 1, center + radius); i++) {
      if (data.speech[i] < 0.4 && data.rms[i] > 0) candidates.push(data.rms[i]);
    }
    if (!candidates.length) {
      setNoiseHint("Move to a quieter moment and retry");
      return;
    }
    candidates.sort((a, b) => a - b);
    const learned = candidates[Math.floor(candidates.length * 0.7)];
    setFocus((old) => ({ ...old, noiseFloor: learned }));
    setNoiseHint(`Learned · ${db(learned)}`);
  };

  const startTranscription = () => {
    if (!ready) return;
    if (transcriptWords.length) {
      setTranscriptionEnabled(true);
      setTranscriptStatus("Complete · cached for this session");
      return;
    }
    const audio = engine.takeTranscriptionAudio();
    if (!audio) {
      setTranscriptionEnabled(true);
      setTranscriptStatus("Reload the recording to retry transcription.");
      return;
    }
    setTranscriptionEnabled(true);
    setTranscriptStatus("Preparing local Whisper…");
    setTranscriptProgress(0.01);
    const worker = new Worker(new URL("../workers/transcribe.worker.ts", import.meta.url));
    transcriptWorkerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<{ type: string; status?: string; progress?: number; words?: TranscriptWord[]; error?: string }>) => {
      if (data.type === "status") {
        setTranscriptStatus(data.status ?? "Working locally…");
        setTranscriptProgress(data.progress ?? 0);
      }
      if (data.type === "complete") {
        setTranscriptWords(data.words ?? []);
        setTranscriptStatus(data.words?.length ? `Complete · ${data.words.length} timed words` : "Complete · no clear speech detected");
        setTranscriptProgress(1);
        worker.terminate();
      }
      if (data.type === "error") {
        setTranscriptStatus(`Unavailable: ${data.error ?? "model could not load"}`);
        setTranscriptProgress(0);
        worker.terminate();
      }
    };
    worker.onerror = () => {
      setTranscriptStatus("Unavailable: this browser blocked the local model worker.");
      setTranscriptProgress(0);
      worker.terminate();
    };
    worker.postMessage({ audio }, [audio.buffer]);
  };

  return <main>
    <audio ref={engine.audioRef} {...engine.events}/>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><AudioLines/></div><div><h1>VoiceScope <em>3D</em></h1><p>LOCAL AUDIO INTELLIGENCE</p></div></div>
      <div className="privacy"><LockKeyhole/><span><b>Private session</b>Processing stays on this device</span></div>
      <input ref={inputRef} type="file" accept="audio/*,.m4a,.aac,.mp3,.wav" hidden onChange={(e) => e.target.files?.[0] && engine.loadFile(e.target.files[0])}/>
      <button className="upload-button" onClick={() => inputRef.current?.click()}><Upload/> {ready ? "Replace audio" : "Load audio"}</button>
    </header>

    <div className="workspace">
      <section className="main-panel">
        <div className="panel-heading">
          <div><span className="eyebrow"><Waves/> SPECTRAL TERRAIN</span><h2>{engine.fileName || "No recording loaded"}</h2></div>
          <div className="analysis-state"><i className={engine.analysis ? "live" : ""}/>{engine.analysis ? "ANALYSIS READY" : engine.progress ? `ANALYZING ${Math.round(engine.progress * 100)}%` : "AWAITING SIGNAL"}</div>
        </div>
        {engine.error && <div className="error"><Info/>{engine.error}</div>}
        <Spectrogram3D analysis={engine.analysis} currentTime={engine.currentTime} windowSeconds={windowSeconds} depth={depth}/>
        <div className="visual-controls">
          <label><span>VISIBLE WINDOW <b>{windowSeconds}s</b></span><input type="range" min="10" max="120" step="5" value={windowSeconds} onChange={(e) => setWindowSeconds(Number(e.target.value))}/></label>
          <label><span>RELIEF DEPTH <b>{Math.round(depth * 100)}%</b></span><input type="range" min="0.2" max="1.5" step="0.05" value={depth} onChange={(e) => setDepth(Number(e.target.value))}/></label>
        </div>

        <div className="window-waveform-wrap">
          <div className="overview-labels"><span>VISIBLE WINDOW · WAVEFORM DETAIL</span><span>{windowSeconds}s</span></div>
          <WindowWaveform analysis={engine.analysis} currentTime={engine.currentTime} duration={engine.duration} windowSeconds={windowSeconds} onSeek={engine.seek}/>
        </div>

        <div className="overview-wrap">
          <div className="overview-labels"><span>FULL RECORDING · HEATMAP + WAVEFORM</span><span>{formatTime(engine.duration)}</span></div>
          <Overview analysis={engine.analysis} currentTime={engine.currentTime} duration={engine.duration} onSeek={engine.seek}/>
          <div className="vad-row"><span>VOICE ACTIVITY</span><div className="vad-track">{engine.analysis && Array.from({length: 80}, (_, i) => { const idx = Math.floor(i / 80 * engine.analysis!.columns); return <i key={i} style={{ opacity: engine.analysis!.speech[idx] > .5 ? .3 + engine.analysis!.speech[idx] * .7 : .04 }}/>; })}</div></div>
        </div>

        <section className="transport">
          <div className="time-readout"><b>{formatTime(engine.currentTime)}</b><span>/ {formatTime(engine.duration)}</span></div>
          <div className="transport-buttons"><button aria-label="Back ten seconds" onClick={() => engine.skip(-10)}><RotateCcw/><span>10</span></button><button className="play" aria-label={engine.playing ? "Pause" : "Play"} onClick={engine.playPause} disabled={!ready}>{engine.playing ? <Pause/> : <Play/>}</button><button aria-label="Forward ten seconds" onClick={() => engine.skip(10)}><RotateCcw className="forward"/><span>10</span></button></div>
          <label className="rate"><span>SPEED</span><select value={rate} onChange={(e) => { const v = Number(e.target.value); setRateValue(v); engine.setRate(v); }}><option value="0.5">.5×</option><option value="0.75">.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
          <button className={loop ? "icon-button active" : "icon-button"} onClick={() => { setLoopValue(!loop); engine.setLoop(!loop); }} aria-label="Loop"><Repeat2/></button>
          <label className={volume > 1 ? "volume boosted" : "volume"} title="Master gain is protected by a limiter"><Volume2/><span>{Math.round(volume * 100)}%</span><input aria-label="Master volume" type="range" min="0" max="5" step=".05" value={volume} onChange={(e) => { const v = Number(e.target.value); setVolumeValue(v); engine.setVolume(v); }}/></label>
        </section>
      </section>

      <aside className="inspector">
        <div className="inspector-title"><SlidersHorizontal/><span>VOICE PROCESSOR</span></div>
        <div className="enhance-card">
          <div className="enhance-header"><div className="enhance-icon"><Sparkles/></div><div><b>Voice Enhance</b><span>Adaptive speech clarity</span></div><button role="switch" aria-checked={settings.enabled} className={settings.enabled ? "toggle on" : "toggle"} onClick={() => setSetting("enabled", !settings.enabled)}><i/></button></div>
          <div className="ab-control"><button className={!settings.enabled ? "selected" : ""} onClick={() => setSetting("enabled", false)}>A · ORIGINAL</button><button className={settings.enabled ? "selected" : ""} onClick={() => setSetting("enabled", true)}>B · ENHANCED</button></div>
          <KnobSlider label="Enhance strength" value={settings.strength} onChange={(v) => setSetting("strength", v)}/>
          <KnobSlider label="Clarity / presence" value={settings.clarity} onChange={(v) => setSetting("clarity", v)}/>
          <KnobSlider label="Noise suppression" value={settings.suppression} onChange={(v) => setSetting("suppression", v)}/>
          <KnobSlider label="Voice gain" value={settings.gain} onChange={(v) => setSetting("gain", v)}/>
          <div className="chain"><span>HPF</span><ChevronRight/><span>EQ</span><ChevronRight/><span>COMP</span><ChevronRight/><span>LIMIT</span></div>
          <button className="focus-preset" onClick={applySpeechFocus}><Focus/><span><b>Speech Focus preset</b><small>Strong clarity + RNNoise</small></span></button>
          <div className="focus-tools">
            <button onClick={learnNoiseProfile} disabled={!engine.analysis}><ScanLine/><span><b>Learn noise profile</b><small>{noiseHint}</small></span></button>
            <label className="feature-toggle"><span><b>Voice-only playback</b><small>Skips detected non-speech</small></span><button role="switch" aria-checked={focus.voiceOnly} className={focus.voiceOnly ? "toggle on" : "toggle"} onClick={() => setFocus((old) => ({ ...old, voiceOnly: !old.voiceOnly }))} disabled={!ready}><i/></button></label>
          </div>
          <label className="neural-slider"><span><BrainCircuit/><b>Local neural denoising</b><output>{Math.round(focus.neuralDenoise * 100)}%</output></span><input type="range" min="0" max="1" step=".05" value={focus.neuralDenoise} onChange={(e) => setFocus((old) => ({ ...old, neuralDenoise: Number(e.target.value) }))}/><small>{engine.neuralStatus === "loading" ? "Loading RNNoise locally…" : engine.neuralStatus === "error" ? `RNNoise unavailable: ${engine.neuralDetail}` : engine.neuralStatus === "ready" ? "RNNoise active · audio stays on device" : focus.neuralDenoise ? "Ready to load when playback starts" : "Off"}</small></label>
        </div>

        <div className="inspector-title transcript-title"><Captions/><span>LOCAL TRANSCRIPT</span></div>
        <div className="transcript-card">
          <div className="feature-toggle"><span><b>Whisper transcription</b><small>English · word timestamps</small></span><button role="switch" aria-checked={transcriptionEnabled} className={transcriptionEnabled ? "toggle on" : "toggle"} onClick={() => transcriptionEnabled ? setTranscriptionEnabled(false) : startTranscription()} disabled={!ready}><i/></button></div>
          {transcriptionEnabled && <>
            <div className="transcript-progress"><i style={{ width: `${transcriptProgress * 100}%` }}/></div>
            <p className="transcript-status">{transcriptStatus}</p>
            <div className="transcript-words" aria-live="polite">{transcriptWords.length ? transcriptWords.map((word, index) => <button key={`${word.start}-${index}`} className={engine.currentTime >= word.start && engine.currentTime <= word.end ? "current" : ""} onClick={() => engine.seek(word.start)} title={`${formatTime(word.start)}–${formatTime(word.end)}`}>{word.text}</button>) : <span>Enable after loading audio. The model downloads once and is cached by your browser.</span>}</div>
            <p className="diarization-note">Speaker labels are withheld: this build does not yet have a reliable local speaker-embedding model, so it will not guess who spoke.</p>
          </>}
        </div>

        <div className="inspector-title metrics-title"><Gauge/><span>LIVE SIGNAL</span></div>
        <div className="voice-status"><div className={engine.metrics.speech > .5 ? "pulse speaking" : "pulse"}><Activity/></div><div><span>CURRENT DETECTION</span><b>{engine.metrics.speech > .5 ? "VOICE PRESENT" : ready ? "AMBIENT / SILENCE" : "NO SIGNAL"}</b></div></div>
        <div className="probability"><span><b>Speech likelihood</b><strong>{Math.round(engine.metrics.speech * 100)}%</strong></span><div><i style={{width: `${engine.metrics.speech * 100}%`}}/></div></div>
        <div className="metric-grid">
          <div><span>DOMINANT</span><b>{engine.metrics.dominant >= 1000 ? `${(engine.metrics.dominant / 1000).toFixed(2)} kHz` : `${Math.round(engine.metrics.dominant)} Hz`}</b></div>
          <div><span>PEAK LEVEL</span><b>{db(engine.metrics.peak)}</b></div>
          <div><span>RMS LEVEL</span><b>{db(engine.metrics.rms)}</b></div>
          <div><span>POSITION</span><b>{formatTime(engine.currentTime)}</b></div>
        </div>
        <div className="privacy-note"><LockKeyhole/><p><b>Local by design</b>Audio processing is performed locally in your browser in Version 1. Your recording is not uploaded to a server.</p></div>
      </aside>
    </div>
    <footer><span><i/> WEB AUDIO ENGINE</span><span><i/> GPU ACCELERATED</span><span><i/> PRIVATE &amp; LOCAL</span><p>VoiceScope 3D · Version 1.0</p></footer>
  </main>;
}
