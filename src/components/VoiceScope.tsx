"use client";

import { useRef, useState } from "react";
import { Activity, AudioLines, ChevronRight, Gauge, Info, LockKeyhole, Pause, Play, Repeat2, RotateCcw, SlidersHorizontal, Sparkles, Upload, Volume2, Waves } from "lucide-react";
import { Spectrogram3D } from "./Spectrogram3D";
import { Overview } from "./Overview";
import { KnobSlider } from "./KnobSlider";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { db, formatTime } from "@/lib/format";
import type { EnhanceSettings } from "@/types/audio";

export function VoiceScope() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<EnhanceSettings>({ enabled: false, strength: 0.58, clarity: 0.62, suppression: 0.48, gain: 0.55 });
  const [windowSeconds, setWindowSeconds] = useState(30);
  const [depth, setDepth] = useState(0.72);
  const [rate, setRateValue] = useState(1);
  const [volume, setVolumeValue] = useState(0.9);
  const [loop, setLoopValue] = useState(false);
  const engine = useAudioEngine(settings);
  const setSetting = <K extends keyof EnhanceSettings>(key: K, value: EnhanceSettings[K]) => setSettings((old) => ({ ...old, [key]: value }));
  const ready = Boolean(engine.fileName);

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

        <div className="overview-wrap">
          <div className="overview-labels"><span>FULL RECORDING · HEATMAP + WAVEFORM</span><span>{formatTime(engine.duration)}</span></div>
          <Overview analysis={engine.analysis} currentTime={engine.currentTime} duration={engine.duration} onSeek={engine.seek}/>
          <div className="vad-row"><span>VOICE ACTIVITY</span><div className="vad-track">{engine.analysis && Array.from({length: 80}, (_, i) => { const idx = Math.floor(i / 80 * engine.analysis!.columns); return <i key={i} style={{ opacity: engine.analysis!.speech[idx] > .5 ? .3 + engine.analysis!.speech[idx] * .7 : .04 }}/>; })}</div></div>
        </div>

        <section className="transport">
          <div className="time-readout"><b>{formatTime(engine.currentTime)}</b><span>/ {formatTime(engine.duration)}</span></div>
          <div className="transport-buttons"><button aria-label="Back ten seconds" onClick={() => engine.skip(-10)}><RotateCcw/><span>10</span></button><button className="play" aria-label={engine.playing ? "Pause" : "Play"} onClick={engine.playPause} disabled={!ready}>{engine.playing ? <Pause/> : <Play/>}</button><button aria-label="Forward ten seconds" onClick={() => engine.skip(10)}><RotateCcw className="forward"/><span>10</span></button></div>
          <label className="rate"><span>SPEED</span><select value={rate} onChange={(e) => { const v = Number(e.target.value); setRateValue(v); engine.setRate(v); }}><option>.75×</option><option value="1">1×</option><option>1.25×</option><option>1.5×</option><option>2×</option></select></label>
          <button className={loop ? "icon-button active" : "icon-button"} onClick={() => { setLoopValue(!loop); engine.setLoop(!loop); }} aria-label="Loop"><Repeat2/></button>
          <label className="volume"><Volume2/><input type="range" min="0" max="1" step=".02" value={volume} onChange={(e) => { const v = Number(e.target.value); setVolumeValue(v); engine.setVolume(v); }}/></label>
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
