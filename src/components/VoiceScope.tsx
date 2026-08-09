"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AudioLines, BrainCircuit, Captions, ChevronRight, Ear, Focus, Gauge, Info, Languages, LockKeyhole, Pause, Play, Repeat2, RotateCcw, ScanLine, SlidersHorizontal, Sparkles, Upload, Volume2, Waves } from "lucide-react";
import { Spectrogram3D } from "./Spectrogram3D";
import { Overview, WindowWaveform } from "./Overview";
import { KnobSlider } from "./KnobSlider";
import { VoiceProfilePanel } from "./VoiceProfilePanel";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { db, formatTime } from "@/lib/format";
import { getVisibleTimeRange } from "@/lib/timeWindow";
import type { EnhanceSettings, FocusSettings, TranscriptLanguage, TranscriptWord } from "@/types/audio";

export function VoiceScope() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<EnhanceSettings>({ enabled: false, strength: 0.58, clarity: 0.62, suppression: 0.48, gain: 0.55 });
  const [windowSeconds, setWindowSeconds] = useState(30);
  const [depth, setDepth] = useState(0.72);
  const [rate, setRateValue] = useState(1);
  const [volume, setVolumeValue] = useState(0.9);
  const [loop, setLoopValue] = useState(false);
  const [focus, setFocus] = useState<FocusSettings>({ voiceOnly: false, neuralDenoise: 0, noiseFloor: null, noiseProfileEnabled: false, speechSensitivity: 0.62, whisperRecovery: false });
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false);
  const [transcriptLanguage, setTranscriptLanguage] = useState<TranscriptLanguage>("auto");
  const [transcribedLanguage, setTranscribedLanguage] = useState<TranscriptLanguage | null>(null);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [transcriptStatus, setTranscriptStatus] = useState("Off");
  const [transcriptProgress, setTranscriptProgress] = useState(0);
  const [transcriptWords, setTranscriptWords] = useState<TranscriptWord[]>([]);
  const [noiseHint, setNoiseHint] = useState("Use a quiet 5-second region");
  const [noiseConfidence, setNoiseConfidence] = useState(0);
  const transcriptWorkerRef = useRef<Worker | null>(null);
  const transcriptionAudioCacheRef = useRef<Float32Array | null>(null);
  const activeTranscriptLanguageRef = useRef<TranscriptLanguage>("auto");
  const engine = useAudioEngine(settings, focus);
  const setSetting = <K extends keyof EnhanceSettings>(key: K, value: EnhanceSettings[K]) => setSettings((old) => ({ ...old, [key]: value }));
  const ready = Boolean(engine.fileName);
  const detectionThreshold = 0.68 - focus.speechSensitivity * 0.36;
  const liveVoiceLikelihood = Math.min(1, Math.max(engine.metrics.speech, engine.metrics.whisper * (0.78 + focus.speechSensitivity * 0.3)));
  const whisperPresent = engine.metrics.whisper >= detectionThreshold && engine.metrics.whisper > engine.metrics.speech * 0.88;

  useEffect(() => () => transcriptWorkerRef.current?.terminate(), []);

  const applySpeechFocus = () => {
    setSettings({ enabled: true, strength: 0.84, clarity: 0.82, suppression: 0.76, gain: 0.64 });
    setFocus((old) => ({ ...old, neuralDenoise: Math.max(old.neuralDenoise, 0.7), whisperRecovery: false }));
  };

  const applyWhisperRecovery = () => {
    setSettings({ enabled: true, strength: 0.94, clarity: 0.94, suppression: 0.42, gain: 0.78 });
    setFocus((old) => ({ ...old, neuralDenoise: Math.min(Math.max(old.neuralDenoise, 0.3), 0.5), speechSensitivity: 0.88, whisperRecovery: true }));
  };

  const learnNoiseProfile = () => {
    const data = engine.analysis;
    if (!data?.duration || !data.noiseFrames) return;
    const range = getVisibleTimeRange(engine.currentTime, data.duration, Math.min(5, data.duration));
    const start = Math.max(0, Math.floor(range.start / data.duration * data.noiseFrames));
    const end = Math.min(data.noiseFrames, Math.ceil(range.end / data.duration * data.noiseFrames));
    const candidates: number[] = [];
    for (let frame = start; frame < end; frame++) {
      const time = (frame + 0.5) / data.noiseFrames * data.duration;
      const column = Math.min(data.columns - 1, Math.floor(time / data.duration * data.columns));
      const voiced = data.pitch[column] > 0 && data.speech[column] > 0.45;
      const strongWhisper = data.whisper[column] >= 0.62;
      if (!voiced && !strongWhisper && data.noiseRms[frame] > 0) candidates.push(data.noiseRms[frame]);
    }
    const expected = Math.max(1, end - start);
    if (candidates.length < Math.max(4, Math.ceil(expected * 0.35))) {
      setNoiseHint("Rejected · speech/whisper dominates this region");
      setNoiseConfidence(0);
      return;
    }
    candidates.sort((a, b) => a - b);
    const learned = candidates[Math.floor(candidates.length * 0.65)];
    const low = candidates[Math.floor(candidates.length * 0.2)];
    const high = candidates[Math.floor(candidates.length * 0.85)];
    const coverage = Math.min(1, candidates.length / Math.max(1, expected * 0.7));
    const spread = (high - low) / Math.max(learned, 1e-6);
    const confidence = Math.round(100 * coverage * (1 - Math.min(0.55, spread * 0.28)));
    setFocus((old) => ({ ...old, noiseFloor: learned, noiseProfileEnabled: true }));
    setSetting("enabled", true);
    setNoiseConfidence(confidence);
    setNoiseHint(`Active · ${db(learned)} · ${confidence}% confidence`);
  };

  const setNoiseProfileEnabled = (enabled: boolean) => {
    if (enabled) setSetting("enabled", true);
    setFocus((old) => ({ ...old, noiseProfileEnabled: enabled && old.noiseFloor !== null }));
    if (focus.noiseFloor !== null) setNoiseHint(`${enabled ? "Active" : "Learned · paused"} · ${db(focus.noiseFloor)} · ${noiseConfidence}% confidence`);
  };

  const resetNoiseProfile = () => {
    setFocus((old) => ({ ...old, noiseFloor: null, noiseProfileEnabled: false }));
    setNoiseConfidence(0);
    setNoiseHint("Use a quiet 5-second region");
  };

  const createTranscriptWorker = () => {
    const worker = new Worker(new URL("../workers/transcribe.worker.ts", import.meta.url));
    transcriptWorkerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<{ type: string; status?: string; progress?: number; words?: TranscriptWord[]; error?: string; audio?: Float32Array }>) => {
      if (data.type === "status") {
        setTranscriptStatus(data.status ?? "Working locally…");
        setTranscriptProgress(data.progress ?? 0);
      }
      if (data.type === "complete") {
        transcriptionAudioCacheRef.current = data.audio ?? null;
        setTranscriptWords(data.words ?? []);
        setTranscribedLanguage(activeTranscriptLanguageRef.current);
        setTranscriptStatus(data.words?.length ? `Complete · ${data.words.length} timed words` : "Complete · no clear speech detected");
        setTranscriptProgress(1);
        setTranscriptBusy(false);
        worker.terminate();
        transcriptWorkerRef.current = null;
      }
      if (data.type === "error") {
        transcriptionAudioCacheRef.current = data.audio ?? null;
        setTranscriptStatus(`Unavailable: ${data.error ?? "model could not load"}`);
        setTranscriptProgress(0);
        setTranscriptBusy(false);
        worker.terminate();
        transcriptWorkerRef.current = null;
      }
    };
    worker.onerror = () => {
      setTranscriptStatus("Unavailable: this browser blocked the local model worker. Reload the recording to retry.");
      setTranscriptProgress(0);
      setTranscriptBusy(false);
      worker.terminate();
      transcriptWorkerRef.current = null;
    };
    return worker;
  };

  const startTranscription = (language = transcriptLanguage) => {
    if (!ready) return;
    if (transcriptBusy) return;
    if (transcribedLanguage === language) {
      setTranscriptionEnabled(true);
      setTranscriptStatus("Complete · cached for this session");
      return;
    }
    setTranscriptionEnabled(true);
    setTranscriptBusy(true);
    setTranscriptWords([]);
    setTranscribedLanguage(null);
    setTranscriptStatus("Preparing local Whisper…");
    setTranscriptProgress(0.01);
    activeTranscriptLanguageRef.current = language;
    const audio = transcriptionAudioCacheRef.current ?? engine.takeTranscriptionAudio();
    if (!audio) {
      setTranscriptStatus("Reload the recording to retry transcription.");
      setTranscriptBusy(false);
      return;
    }
    transcriptionAudioCacheRef.current = null;
    const worker = createTranscriptWorker();
    worker.postMessage({ audio, language }, [audio.buffer]);
  };

  const loadRecording = (file: File) => {
    transcriptWorkerRef.current?.terminate();
    transcriptWorkerRef.current = null;
    transcriptionAudioCacheRef.current = null;
    setTranscriptionEnabled(false);
    setTranscriptBusy(false);
    setTranscriptStatus("Off");
    setTranscriptProgress(0);
    setTranscriptWords([]);
    setTranscribedLanguage(null);
    setFocus((old) => ({ ...old, noiseFloor: null, noiseProfileEnabled: false }));
    setNoiseConfidence(0);
    setNoiseHint("Use a quiet 5-second region");
    void engine.loadFile(file);
  };

  return <main>
    <audio ref={engine.audioRef} {...engine.events}/>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><AudioLines/></div><div><h1>VoiceScope <em>3D</em></h1><p>LOCAL AUDIO INTELLIGENCE</p></div></div>
      <div className="privacy"><LockKeyhole/><span><b>Private session</b>Processing stays on this device</span></div>
      <input ref={inputRef} type="file" accept="audio/*,.m4a,.aac,.mp3,.wav" hidden onChange={(e) => e.target.files?.[0] && loadRecording(e.target.files[0])}/>
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
          <div className="vad-row"><span>VOICE + WHISPER ACTIVITY</span><div className="vad-track">{engine.analysis && Array.from({length: 80}, (_, i) => { const idx = Math.floor(i / 80 * engine.analysis!.columns); const likelihood = Math.max(engine.analysis!.speech[idx], engine.analysis!.whisper[idx] * .9); return <i key={i} style={{ opacity: likelihood >= detectionThreshold ? .3 + likelihood * .7 : .04 }}/>; })}</div></div>
        </div>

        <section className="transport">
          <div className="time-readout"><b>{formatTime(engine.currentTime)}</b><span>/ {formatTime(engine.duration)}</span></div>
          <div className="transport-buttons"><button aria-label="Back ten seconds" onClick={() => engine.skip(-10)}><RotateCcw/><span>10</span></button><button className="play" aria-label={engine.playing ? "Pause" : "Play"} onClick={engine.playPause} disabled={!ready}>{engine.playing ? <Pause/> : <Play/>}</button><button aria-label="Forward ten seconds" onClick={() => engine.skip(10)}><RotateCcw className="forward"/><span>10</span></button></div>
          <label className="rate"><span>SPEED</span><select value={rate} onChange={(e) => { const v = Number(e.target.value); setRateValue(v); engine.setRate(v); }}><option value="0.5">.5×</option><option value="0.75">.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
          <button className={loop ? "icon-button active" : "icon-button"} onClick={() => { setLoopValue(!loop); engine.setLoop(!loop); }} aria-label="Loop"><Repeat2/></button>
          <label className={volume > 1 ? "volume boosted" : "volume"} title="Master gain is protected by a limiter"><Volume2/><span>{Math.round(volume * 100)}%</span><input aria-label="Master volume" type="range" min="0" max="5" step=".05" value={volume} onChange={(e) => { const v = Number(e.target.value); setVolumeValue(v); engine.setVolume(v); }}/></label>
        </section>
        <VoiceProfilePanel analysis={engine.analysis} currentTime={engine.currentTime} windowSeconds={windowSeconds} onSeek={engine.seek}/>
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
          <button className={focus.whisperRecovery ? "focus-preset whisper-preset active" : "focus-preset whisper-preset"} onClick={applyWhisperRecovery}><Ear/><span><b>Whisper Recovery preset</b><small>Preserves and lifts faint breathy speech</small></span></button>
          <div className="focus-tools">
            <button onClick={learnNoiseProfile} disabled={!engine.analysis}><ScanLine/><span><b>Learn noise profile</b><small>{noiseHint}</small></span></button>
            <label className="feature-toggle"><span><b>Use learned profile</b><small>{focus.noiseFloor === null ? "Learn a quiet region first" : !focus.noiseProfileEnabled ? `Ready · ${noiseConfidence}% confidence` : !settings.enabled ? "Paused in Original/A" : engine.noiseReductionDb > 0.1 ? `Reducing ${engine.noiseReductionDb.toFixed(1)} dB now` : `Active · monitoring · ${noiseConfidence}% confidence`}</small></span><button role="switch" aria-label="Use learned noise profile" aria-checked={focus.noiseProfileEnabled} className={focus.noiseProfileEnabled ? "toggle on" : "toggle"} onClick={() => setNoiseProfileEnabled(!focus.noiseProfileEnabled)} disabled={focus.noiseFloor === null}><i/></button></label>
            {focus.noiseFloor !== null ? <button className="noise-reset" onClick={resetNoiseProfile}><RotateCcw/><span><b>Reset noise profile</b><small>Forget the learned threshold</small></span></button> : null}
            <label className="feature-toggle"><span><b>Voice-only playback</b><small>Skips detected non-speech</small></span><button role="switch" aria-checked={focus.voiceOnly} className={focus.voiceOnly ? "toggle on" : "toggle"} onClick={() => setFocus((old) => ({ ...old, voiceOnly: !old.voiceOnly }))} disabled={!ready}><i/></button></label>
          </div>
          <label className="neural-slider"><span><BrainCircuit/><b>Local neural denoising</b><output>{Math.round(focus.neuralDenoise * 100)}%</output></span><input type="range" min="0" max="1" step=".05" value={focus.neuralDenoise} onChange={(e) => setFocus((old) => ({ ...old, neuralDenoise: Number(e.target.value) }))}/><small>{engine.neuralStatus === "loading" ? "Loading RNNoise locally…" : engine.neuralStatus === "error" ? `RNNoise unavailable: ${engine.neuralDetail}` : engine.neuralStatus === "ready" ? "RNNoise active · audio stays on device" : focus.neuralDenoise ? "Ready to load when playback starts" : "Off"}</small></label>
          <label className="neural-slider sensitivity-slider"><span><Activity/><b>Speech / whisper sensitivity</b><output>{Math.round(focus.speechSensitivity * 100)}%</output></span><input type="range" min="0" max="1" step=".05" value={focus.speechSensitivity} onChange={(e) => setFocus((old) => ({ ...old, speechSensitivity: Number(e.target.value) }))}/><small>Higher values preserve fainter candidates but may include more background sound.</small></label>
        </div>

        <div className="inspector-title transcript-title"><Captions/><span>LOCAL TRANSCRIPT</span></div>
        <div className="transcript-card">
          <label className="transcript-language"><Languages/><span><b>Spoken language</b><small>Choose a language for muffled audio</small></span><select value={transcriptLanguage} disabled={transcriptBusy} onChange={(event) => { const language = event.target.value as TranscriptLanguage; setTranscriptLanguage(language); if (transcriptionEnabled) startTranscription(language); }}><option value="auto">Auto detect</option><option value="en">English</option><option value="hi">हिन्दी · Hindi</option><option value="mr">मराठी · Marathi</option></select></label>
          <div className="feature-toggle"><span><b>Whisper transcription</b><small>English · Hindi · Marathi · word timestamps</small></span><button role="switch" aria-checked={transcriptionEnabled} className={transcriptionEnabled ? "toggle on" : "toggle"} onClick={() => transcriptionEnabled ? setTranscriptionEnabled(false) : startTranscription()} disabled={!ready}><i/></button></div>
          {transcriptionEnabled && <>
            <div className="transcript-progress"><i style={{ width: `${transcriptProgress * 100}%` }}/></div>
            <p className="transcript-status">{transcriptStatus}</p>
            <div className="transcript-words" aria-live="polite">{transcriptWords.length ? transcriptWords.map((word, index) => <button key={`${word.start}-${index}`} className={engine.currentTime >= word.start && engine.currentTime <= word.end ? "current" : ""} onClick={() => engine.seek(word.start)} title={`${formatTime(word.start)}–${formatTime(word.end)}`}>{word.text}</button>) : <span>Enable after loading audio. The model downloads once and is cached by your browser.</span>}</div>
            <p className="diarization-note">Speaker labels are withheld: this build does not yet have a reliable local speaker-embedding model, so it will not guess who spoke.</p>
          </>}
        </div>

        <div className="inspector-title metrics-title"><Gauge/><span>LIVE SIGNAL</span></div>
        <div className="voice-status"><div className={liveVoiceLikelihood >= detectionThreshold ? "pulse speaking" : "pulse"}><Activity/></div><div><span>CURRENT DETECTION</span><b>{whisperPresent ? "WHISPER-LIKE SPEECH" : liveVoiceLikelihood >= detectionThreshold ? "VOICE PRESENT" : ready ? "AMBIENT / SILENCE" : "NO SIGNAL"}</b></div></div>
        <div className="probability"><span><b>Speech likelihood</b><strong>{Math.round(engine.metrics.speech * 100)}%</strong></span><div><i style={{width: `${engine.metrics.speech * 100}%`}}/></div></div>
        <div className="probability whisper-probability"><span><b>Whisper likelihood</b><strong>{Math.round(engine.metrics.whisper * 100)}%</strong></span><div><i style={{width: `${engine.metrics.whisper * 100}%`}}/></div></div>
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
