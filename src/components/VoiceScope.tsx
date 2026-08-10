"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AudioLines, BrainCircuit, Captions, ChevronRight, Ear, Focus, Gauge, Info, KeyRound, Languages, LockKeyhole, Pause, Play, Repeat2, RotateCcw, ScanLine, ShieldCheck, SlidersHorizontal, Sparkles, Upload, Volume2, Waves } from "lucide-react";
import { Spectrogram3D } from "./Spectrogram3D";
import { Overview, WindowWaveform } from "./Overview";
import { KnobSlider } from "./KnobSlider";
import { VoiceProfilePanel } from "./VoiceProfilePanel";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { analysisFrameAtTime } from "@/lib/analysisClock";
import { db, formatTime } from "@/lib/format";
import { getVisibleTimeRange } from "@/lib/timeWindow";
import { forgetRecording, inspectRecovery, persistEncryptedRecording, recoverEncryptedRecording, savePlaybackSnapshot } from "@/lib/audioSession";
import type { RecoveryMetadata } from "@/lib/audioSession";
import type { EnhanceSettings, FocusSettings, TranscriptLanguage, TranscriptWord } from "@/types/audio";

export function VoiceScope() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<EnhanceSettings>({
    enabled: false,
    strength: 0.58,
    clarity: 0.62,
    suppression: 0.48,
    gain: 0.55,
    deMuffle: 0.5,
    humRemoval: 0.25,
    hissReduction: 0.4,
    whisperLift: 0.45,
  });
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
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<"sensitive" | "encrypted">("sensitive");
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  const [pendingRecovery, setPendingRecovery] = useState<RecoveryMetadata | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const transcriptWorkerRef = useRef<Worker | null>(null);
  const activeTranscriptLanguageRef = useRef<TranscriptLanguage>("auto");
  const transcriptionRequestRef = useRef(0);
  const activeRecordingIdRef = useRef("");
  const restoreStartedRef = useRef(false);
  const engine = useAudioEngine(settings, focus);
  const loadAudioFile = engine.loadFile;
  const getAudioCurrentTime = engine.getCurrentTime;
  const restoreRate = engine.setRate;
  const restoreVolume = engine.setVolume;
  const restoreLoop = engine.setLoop;
  const setSetting = <K extends keyof EnhanceSettings>(key: K, value: EnhanceSettings[K]) => setSettings((old) => ({ ...old, [key]: value }));
  const ready = Boolean(engine.fileName);
  const detectionThreshold = 0.68 - focus.speechSensitivity * 0.36;
  const liveVoiceLikelihood = Math.min(1, Math.max(engine.metrics.speech, engine.metrics.whisper * (0.78 + focus.speechSensitivity * 0.3)));
  const whisperPresent = engine.metrics.whisper >= detectionThreshold && engine.metrics.whisper > engine.metrics.speech * 0.88;

  useEffect(() => () => {
    transcriptionRequestRef.current++;
    transcriptWorkerRef.current?.terminate();
  }, []);

  const applySpeechFocus = () => {
    setSettings({ enabled: true, strength: 0.78, clarity: 0.82, suppression: 0.74, gain: 0.6, deMuffle: 0.78, humRemoval: 0.45, hissReduction: 0.62, whisperLift: 0.52 });
    setFocus((old) => ({ ...old, neuralDenoise: Math.max(old.neuralDenoise, 0.7), whisperRecovery: false }));
  };

  const applyWhisperRecovery = () => {
    if (focus.whisperRecovery) {
      setFocus((old) => ({ ...old, whisperRecovery: false }));
      return;
    }
    setSettings({ enabled: true, strength: 0.72, clarity: 0.8, suppression: 0.7, gain: 0.62, deMuffle: 0.82, humRemoval: 0.5, hissReduction: 0.72, whisperLift: 0.88 });
    setFocus((old) => ({ ...old, neuralDenoise: Math.min(Math.max(old.neuralDenoise, 0.3), 0.45), speechSensitivity: 0.86, whisperRecovery: true }));
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
      const column = analysisFrameAtTime(data, time);
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
    const worker = new Worker(new URL("../workers/transcribe.worker.ts", import.meta.url), { type: "module" });
    transcriptWorkerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<{ type: string; status?: string; progress?: number; words?: TranscriptWord[]; error?: string }>) => {
      if (data.type === "status") {
        setTranscriptStatus(data.status ?? "Working locally…");
        setTranscriptProgress(data.progress ?? 0);
      }
      if (data.type === "complete") {
        setTranscriptWords(data.words ?? []);
        setTranscribedLanguage(activeTranscriptLanguageRef.current);
        setTranscriptStatus(data.words?.length ? `Complete · ${data.words.length} timed words` : "Complete · no clear speech detected");
        setTranscriptProgress(1);
        setTranscriptBusy(false);
        worker.terminate();
        transcriptWorkerRef.current = null;
      }
      if (data.type === "error") {
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

  const startTranscription = async (language = transcriptLanguage) => {
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
    setTranscriptStatus("Preparing a temporary 16 kHz speech copy…");
    setTranscriptProgress(0.01);
    activeTranscriptLanguageRef.current = language;
    const request = ++transcriptionRequestRef.current;
    const audio = await engine.prepareTranscriptionAudio();
    if (request !== transcriptionRequestRef.current) return;
    if (!audio) {
      setTranscriptStatus("The recording changed before transcription could start. Try again.");
      setTranscriptBusy(false);
      return;
    }
    setTranscriptStatus("Preparing local Whisper…");
    const worker = createTranscriptWorker();
    worker.postMessage({ audio, language }, [audio.buffer]);
  };

  const stopTranscription = () => {
    transcriptionRequestRef.current++;
    transcriptWorkerRef.current?.terminate();
    transcriptWorkerRef.current = null;
    setTranscriptionEnabled(false);
    setTranscriptBusy(false);
    setTranscriptProgress(0);
    setTranscriptStatus("Off");
  };

  const loadRecording = async (file: File) => {
    transcriptionRequestRef.current++;
    transcriptWorkerRef.current?.terminate();
    transcriptWorkerRef.current = null;
    setTranscriptionEnabled(false);
    setTranscriptBusy(false);
    setTranscriptStatus("Off");
    setTranscriptProgress(0);
    setTranscriptWords([]);
    setTranscribedLanguage(null);
    setFocus((old) => ({ ...old, noiseFloor: null, noiseProfileEnabled: false }));
    setNoiseConfidence(0);
    setNoiseHint("Use a quiet 5-second region");
    setRecoveryMessage(recoveryMode === "encrypted" ? "Preparing an encrypted recovery copy on this device…" : "Sensitive Session · no recording copy will be retained");
    setRecoveryWarning(false);
    const loaded = await engine.loadFile(file);
    if (!loaded) {
      setRecoveryMessage("");
      return;
    }
    if (recoveryMode === "sensitive") {
      await forgetRecording().catch(() => undefined);
      activeRecordingIdRef.current = "";
      setRecoveryAvailable(false);
      setRecoveryMessage("Sensitive Session active · reload requires the original recording");
      return;
    }
    if (recoveryPassphrase.length < 12) {
      await forgetRecording().catch(() => undefined);
      activeRecordingIdRef.current = "";
      setRecoveryAvailable(false);
      setRecoveryWarning(true);
      setRecoveryMessage("Encrypted recovery was not saved · use a passphrase of at least 12 characters before loading audio");
      return;
    }
    try {
      const id = await persistEncryptedRecording(file, recoveryPassphrase);
      activeRecordingIdRef.current = id;
      setRecoveryPassphrase("");
      setRecoveryAvailable(true);
      setRecoveryMessage("AES-256-GCM recovery active · passphrase required after reload · expires in 24 hours");
    } catch {
      activeRecordingIdRef.current = "";
      setRecoveryAvailable(false);
      setRecoveryWarning(true);
      setRecoveryMessage("Encrypted recovery is unavailable · keep the original recording nearby");
    }
  };

  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void (async () => {
      try {
        const metadata = await inspectRecovery();
        if (!metadata) return;
        setPendingRecovery(metadata);
        setRecoveryMode("encrypted");
        setRecoveryAvailable(true);
        setRecoveryMessage(`Encrypted recovery found for ${metadata.name} · enter its passphrase to unlock`);
      } catch {
        setRecoveryWarning(true);
        setRecoveryMessage("Recovery storage is unavailable · load the original recording");
      }
    })();
  }, [loadAudioFile, restoreLoop, restoreRate, restoreVolume]);

  const unlockRecovery = async () => {
    if (recoveryPassphrase.length < 12 || unlockBusy) return;
    setUnlockBusy(true);
    setRecoveryWarning(false);
    setRecoveryMessage("Decrypting the saved recording locally…");
    try {
      const recovered = await recoverEncryptedRecording(recoveryPassphrase);
      if (!recovered) {
        setPendingRecovery(null);
        setRecoveryAvailable(false);
        setRecoveryMessage("No valid recovery copy remains");
        return;
      }
      activeRecordingIdRef.current = recovered.recordingId;
      const snapshot = recovered.snapshot;
      const loaded = await loadAudioFile(recovered.file, snapshot?.currentTime ?? 0);
      if (!loaded) throw new Error("decode failed");
      if (snapshot) {
        setRateValue(snapshot.rate);
        setVolumeValue(snapshot.volume);
        setLoopValue(snapshot.loop);
        restoreRate(snapshot.rate);
        restoreVolume(snapshot.volume);
        restoreLoop(snapshot.loop);
      }
      setPendingRecovery(null);
      setRecoveryPassphrase("");
      setRecoveryAvailable(true);
      setRecoveryMessage(snapshot?.currentTime ? `Encrypted session restored at ${formatTime(snapshot.currentTime)}` : "Encrypted recording restored locally");
    } catch {
      setRecoveryWarning(true);
      setRecoveryMessage("Unlock failed · check the passphrase; the encrypted copy was not deleted");
    } finally {
      setUnlockBusy(false);
    }
  };

  useEffect(() => {
    if (!ready) return;
    const save = () => {
      const id = activeRecordingIdRef.current;
      if (!id) return;
      savePlaybackSnapshot({
        recordingId: id,
        currentTime: getAudioCurrentTime(),
        rate,
        volume,
        loop,
        savedAt: Date.now(),
      });
    };
    const interval = window.setInterval(save, 3000);
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") save(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", save);
    };
  }, [getAudioCurrentTime, loop, rate, ready, volume]);

  const forgetRecovery = async () => {
    try {
      await forgetRecording();
      activeRecordingIdRef.current = "";
      setPendingRecovery(null);
      setRecoveryPassphrase("");
      setRecoveryAvailable(false);
      setRecoveryWarning(true);
      setRecoveryMessage("Recovery copy removed · a reload will require the original recording");
    } catch {
      setRecoveryWarning(true);
      setRecoveryMessage("The browser could not remove its recovery copy");
    }
  };

  return <main>
    <audio ref={engine.audioRef} {...engine.events}/>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><AudioLines/></div><div><h1>VoiceScope <em>3D</em></h1><p>LOCAL AUDIO INTELLIGENCE</p></div></div>
      <div className="privacy"><LockKeyhole/><span><b>Private session</b>Processing stays on this device</span></div>
      <input ref={inputRef} type="file" accept="audio/*,.m4a,.aac,.mp3,.wav" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadRecording(file); }}/>
      <button className="upload-button" onClick={() => inputRef.current?.click()}><Upload/> {ready ? "Replace audio" : "Load audio"}</button>
    </header>

    <div className="workspace">
      <section className="main-panel">
        <div className="panel-heading">
          <div><span className="eyebrow"><Waves/> SPECTRAL TERRAIN</span><h2>{engine.fileName || "No recording loaded"}</h2></div>
          <div className="analysis-state"><i className={engine.analysis ? "live" : ""}/>{engine.analysis ? "ANALYSIS READY" : engine.progress ? `ANALYZING ${Math.round(engine.progress * 100)}%` : "AWAITING SIGNAL"}</div>
        </div>
        <section className="session-security" aria-label="Recording recovery security">
          <div className="session-security-title"><ShieldCheck/><span><b>Session storage</b><small>Choose before loading a recording</small></span></div>
          <div className="session-mode" role="group" aria-label="Session storage mode">
            <button aria-pressed={recoveryMode === "sensitive"} className={recoveryMode === "sensitive" ? "selected" : ""} disabled={ready || Boolean(pendingRecovery)} onClick={() => setRecoveryMode("sensitive")}>Sensitive · retain nothing</button>
            <button aria-pressed={recoveryMode === "encrypted"} className={recoveryMode === "encrypted" ? "selected" : ""} disabled={ready || Boolean(pendingRecovery)} onClick={() => setRecoveryMode("encrypted")}>Encrypted recovery · 24 h</button>
          </div>
          {recoveryMode === "encrypted" && (!ready || pendingRecovery) ? <div className="recovery-key"><KeyRound/><label htmlFor="recovery-passphrase"><b>{pendingRecovery ? `Unlock ${pendingRecovery.name}` : "Recovery passphrase"}</b><small>At least 12 characters · never stored or uploaded</small></label><input id="recovery-passphrase" type="password" minLength={12} autoComplete="new-password" value={recoveryPassphrase} onChange={(event) => setRecoveryPassphrase(event.target.value)}/>{pendingRecovery ? <button disabled={unlockBusy || recoveryPassphrase.length < 12} onClick={() => void unlockRecovery()}>{unlockBusy ? "Unlocking…" : "Unlock"}</button> : null}</div> : null}
        </section>
        {recoveryMessage ? <div className={recoveryWarning ? "session-recovery warning" : "session-recovery"}><span><LockKeyhole/><b>{recoveryMessage}</b></span>{recoveryAvailable ? <button onClick={() => void forgetRecovery()}>Forget recovery copy</button> : null}</div> : null}
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
          <div className="overview-labels"><span>FULL RECORDING · COARSE NAVIGATION HEATMAP + WAVEFORM</span><span>{formatTime(engine.duration)}</span></div>
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
          <div className="enhance-header"><div className="enhance-icon"><Sparkles/></div><div><b>Voice Enhance</b><span>Adaptive speech clarity</span></div><button role="switch" aria-label="Voice Enhance" aria-checked={settings.enabled} className={settings.enabled ? "toggle on" : "toggle"} onClick={() => setSetting("enabled", !settings.enabled)}><i/></button></div>
          <div className="ab-control"><button className={!settings.enabled ? "selected" : ""} onClick={() => setSetting("enabled", false)}>A · ORIGINAL</button><button className={settings.enabled ? "selected" : ""} onClick={() => setSetting("enabled", true)}>B · ENHANCED</button></div>
          <KnobSlider label="Enhance strength" value={settings.strength} onChange={(v) => setSetting("strength", v)}/>
          <KnobSlider label="Clarity / presence" value={settings.clarity} onChange={(v) => setSetting("clarity", v)}/>
          <KnobSlider label="Noise suppression" value={settings.suppression} onChange={(v) => setSetting("suppression", v)}/>
          <KnobSlider label="Voice gain" value={settings.gain} onChange={(v) => setSetting("gain", v)}/>
          <KnobSlider label="De-muffle" value={settings.deMuffle} onChange={(v) => setSetting("deMuffle", v)}/>
          <KnobSlider label="50 Hz hum removal" value={settings.humRemoval} onChange={(v) => setSetting("humRemoval", v)}/>
          <KnobSlider label="Hiss / sibilance control" value={settings.hissReduction} onChange={(v) => setSetting("hissReduction", v)}/>
          <KnobSlider label="Adaptive whisper lift" value={settings.whisperLift} onChange={(v) => setSetting("whisperLift", v)}/>
          <div className="chain"><span>HPF</span><ChevronRight/><span>HUM</span><ChevronRight/><span>DE-MUFFLE</span><ChevronRight/><span>EXPAND</span><ChevronRight/><span>LIMIT</span></div>
          <button className="focus-preset" onClick={applySpeechFocus}><Focus/><span><b>Speech Focus preset</b><small>Strong clarity + RNNoise</small></span></button>
          <button aria-pressed={focus.whisperRecovery} className={focus.whisperRecovery ? "focus-preset whisper-preset active" : "focus-preset whisper-preset"} onClick={applyWhisperRecovery}><Ear/><span><b>Whisper Recovery {focus.whisperRecovery ? "on" : "preset"}</b><small>Voice-gated lift without broad noise amplification</small></span></button>
          <div className="focus-tools">
            <button onClick={learnNoiseProfile} disabled={!engine.analysis}><ScanLine/><span><b>Learn noise profile</b><small>{noiseHint}</small></span></button>
            <label className="feature-toggle"><span><b>Use learned profile</b><small>{focus.noiseFloor === null ? "Learn a quiet region first" : !focus.noiseProfileEnabled ? `Ready · ${noiseConfidence}% confidence` : !settings.enabled ? "Paused in Original/A" : engine.noiseReductionDb > 0.1 ? `Reducing ${engine.noiseReductionDb.toFixed(1)} dB now` : `Active · monitoring · ${noiseConfidence}% confidence`}</small></span><button role="switch" aria-label="Use learned noise profile" aria-checked={focus.noiseProfileEnabled} className={focus.noiseProfileEnabled ? "toggle on" : "toggle"} onClick={() => setNoiseProfileEnabled(!focus.noiseProfileEnabled)} disabled={focus.noiseFloor === null}><i/></button></label>
            {focus.noiseFloor !== null ? <button className="noise-reset" onClick={resetNoiseProfile}><RotateCcw/><span><b>Reset noise profile</b><small>Forget the learned threshold</small></span></button> : null}
            <label className="feature-toggle"><span><b>Voice-only playback</b><small>Skips detected non-speech</small></span><button role="switch" aria-label="Voice-only playback" aria-checked={focus.voiceOnly} className={focus.voiceOnly ? "toggle on" : "toggle"} onClick={() => setFocus((old) => ({ ...old, voiceOnly: !old.voiceOnly }))} disabled={!ready}><i/></button></label>
          </div>
          <label className="neural-slider"><span><BrainCircuit/><b>Local neural denoising</b><output>{Math.round(focus.neuralDenoise * 100)}%</output></span><input type="range" min="0" max="1" step=".05" value={focus.neuralDenoise} onChange={(e) => setFocus((old) => ({ ...old, neuralDenoise: Number(e.target.value) }))}/><small>{focus.neuralDenoise === 0 ? "Off" : !settings.enabled ? "Paused in Original/A" : engine.neuralStatus === "loading" ? "Loading RNNoise locally…" : engine.neuralStatus === "error" ? `RNNoise unavailable: ${engine.neuralDetail}` : engine.neuralStatus === "ready" ? "RNNoise active · audio stays on device" : "Ready to load when playback starts"}</small></label>
          <label className="neural-slider sensitivity-slider"><span><Activity/><b>Speech / whisper sensitivity</b><output>{Math.round(focus.speechSensitivity * 100)}%</output></span><input type="range" min="0" max="1" step=".05" value={focus.speechSensitivity} onChange={(e) => setFocus((old) => ({ ...old, speechSensitivity: Number(e.target.value) }))}/><small>Higher values preserve fainter candidates but may include more background sound.</small></label>
        </div>

        <div className="inspector-title transcript-title"><Captions/><span>LOCAL TRANSCRIPT</span></div>
        <div className="transcript-card">
          <label className="transcript-language"><Languages/><span><b>Spoken language</b><small>Choose a language for muffled audio</small></span><select value={transcriptLanguage} disabled={transcriptBusy} onChange={(event) => { const language = event.target.value as TranscriptLanguage; setTranscriptLanguage(language); if (transcriptionEnabled) void startTranscription(language); }}><option value="auto">Auto detect</option><option value="en">English</option><option value="hi">हिन्दी · Hindi</option><option value="mr">मराठी · Marathi</option></select></label>
          <div className="feature-toggle"><span><b>Whisper transcription</b><small>English · Hindi · Marathi · word timestamps</small></span><button role="switch" aria-label="Whisper transcription" aria-checked={transcriptionEnabled} className={transcriptionEnabled ? "toggle on" : "toggle"} onClick={() => { if (transcriptionEnabled) stopTranscription(); else void startTranscription(); }} disabled={!ready}><i/></button></div>
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
        <div className="probability noise-probability"><span><b>Background-noise likelihood</b><strong>{Math.round(engine.metrics.noise * 100)}%</strong></span><div><i style={{width: `${engine.metrics.noise * 100}%`}}/></div></div>
        <div className="metric-grid">
          <div><span>DOMINANT</span><b>{engine.metrics.dominant >= 1000 ? `${(engine.metrics.dominant / 1000).toFixed(2)} kHz` : `${Math.round(engine.metrics.dominant)} Hz`}</b></div>
          <div><span>PEAK LEVEL</span><b>{db(engine.metrics.peak)}</b></div>
          <div><span>RMS LEVEL</span><b>{db(engine.metrics.rms)}</b></div>
          <div><span>POSITION</span><b>{formatTime(engine.currentTime)}</b></div>
          <div><span>SPEECH CLARITY</span><b>{Math.round(engine.metrics.clarity * 100)}%</b></div>
          <div><span>LIVE REDUCTION</span><b>{engine.noiseReductionDb.toFixed(1)} dB</b></div>
        </div>
        <div className="privacy-note"><LockKeyhole/><p><b>Local by design</b>Audio processing is performed locally in your browser in Version 1. Your recording is not uploaded to a server.</p></div>
      </aside>
    </div>
    <footer><span><i/> WEB AUDIO ENGINE</span><span><i/> GPU ACCELERATED</span><span><i/> PRIVATE &amp; LOCAL</span><p>VoiceScope 3D · Version 1.0</p></footer>
  </main>;
}
