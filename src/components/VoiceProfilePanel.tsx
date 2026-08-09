"use client";

import { useMemo, useState } from "react";
import { AudioWaveform, Info, UsersRound } from "lucide-react";
import { formatTime } from "@/lib/format";
import { getVisibleTimeRange } from "@/lib/timeWindow";
import type { AnalysisData } from "@/types/audio";

type ProfileKind = "lower" | "higher" | "uncertain" | "none";

type ProfileSample = {
  kind: ProfileKind;
  label: string;
  pitch: number;
  confidence: number;
};

const PROFILE_COLUMNS = 96;

function classifyProfile(pitch: number, profile: number, confidence: number, speech: number): ProfileSample {
  if (speech < 0.42 || pitch <= 0) return { kind: "none", label: "No stable voiced pitch", pitch: 0, confidence: 0 };
  if (confidence < 0.34 || Math.abs(profile) < 0.28) return { kind: "uncertain", label: "Overlapping / uncertain range", pitch, confidence };
  return profile < 0
    ? { kind: "lower", label: "Lower / masculine-range", pitch, confidence }
    : { kind: "higher", label: "Higher / feminine-range", pitch, confidence };
}

function profileAt(analysis: AnalysisData | null, time: number) {
  if (!analysis?.duration) return classifyProfile(0, 0, 0, 0);
  const index = Math.min(analysis.columns - 1, Math.max(0, Math.floor(time / analysis.duration * analysis.columns)));
  return classifyProfile(analysis.pitch[index], analysis.profile[index], analysis.profileConfidence[index], analysis.speech[index]);
}

export function VoiceProfilePanel({ analysis, currentTime, windowSeconds, onSeek }: { analysis: AnalysisData | null; currentTime: number; windowSeconds: number; onSeek: (time: number) => void }) {
  const [enabled, setEnabled] = useState(false);
  const range = getVisibleTimeRange(currentTime, analysis?.duration ?? 0, windowSeconds);
  const current = profileAt(analysis, currentTime);
  const startColumn = analysis?.duration ? Math.floor(range.start / analysis.duration * analysis.columns) : 0;
  const endColumn = analysis?.duration ? Math.max(startColumn + 1, Math.ceil(range.end / analysis.duration * analysis.columns)) : 0;
  const counts = useMemo(() => {
    const result = { lower: 0, higher: 0, uncertain: 0, voiced: 0 };
    if (!analysis) return result;
    for (let index = 0; index < analysis.columns; index++) {
      if (analysis.speech[index] < 0.42) continue;
      const sample = classifyProfile(analysis.pitch[index], analysis.profile[index], analysis.profileConfidence[index], analysis.speech[index]);
      if (sample.kind === "none") continue;
      result.voiced++;
      if (sample.kind === "lower") result.lower++;
      else if (sample.kind === "higher") result.higher++;
      else result.uncertain++;
    }
    return result;
  }, [analysis]);
  const timeline = useMemo(() => Array.from({ length: PROFILE_COLUMNS }, (_, slot) => {
    if (!analysis || endColumn <= startColumn) return { kind: "none" as ProfileKind, confidence: 0 };
    const start = Math.floor(startColumn + slot / PROFILE_COLUMNS * (endColumn - startColumn));
    const end = Math.max(start + 1, Math.floor(startColumn + (slot + 1) / PROFILE_COLUMNS * (endColumn - startColumn)));
    let weightedProfile = 0, weight = 0, strongestConfidence = 0, pitchSum = 0, pitchCount = 0, speech = 0;
    for (let index = start; index < Math.min(end, analysis.columns); index++) {
      const sample = classifyProfile(analysis.pitch[index], analysis.profile[index], analysis.profileConfidence[index], analysis.speech[index]);
      if (sample.kind === "none") continue;
      const sampleWeight = Math.max(0.08, sample.confidence) * analysis.speech[index];
      weightedProfile += analysis.profile[index] * sampleWeight;
      weight += sampleWeight;
      strongestConfidence = Math.max(strongestConfidence, sample.confidence);
      pitchSum += sample.pitch;
      pitchCount++;
      speech = Math.max(speech, analysis.speech[index]);
    }
    const profile = weight ? weightedProfile / weight : 0;
    const sample = classifyProfile(pitchCount ? pitchSum / pitchCount : 0, profile, strongestConfidence, speech);
    return { kind: sample.kind, confidence: sample.confidence };
  }), [analysis, endColumn, startColumn]);
  const timelineColumns = useMemo(() => timeline.map((segment, index) => <i
    key={index}
    className={segment.kind}
    style={{ opacity: segment.kind === "none" ? 0.18 : 0.35 + segment.confidence * 0.65 }}
  />), [timeline]);
  const percentage = (count: number) => counts.voiced ? Math.round(count / counts.voiced * 100) : 0;

  return <section className="profile-landscape" aria-label="Independent acoustic voice profile analysis">
    <div className="profile-landscape-head">
      <div className="profile-icon"><AudioWaveform/></div>
      <span><b><UsersRound/> Voice Profile Classification</b><small>Independent local pitch analysis · synchronized visible window</small></span>
      <button role="switch" aria-label="Enable voice profile classification" aria-checked={enabled} className={enabled ? "toggle on" : "toggle"} onClick={() => setEnabled((active) => !active)} disabled={!analysis}><i/></button>
    </div>
    {enabled ? <div className="profile-landscape-body">
      <div className={`profile-current ${current.kind}`}>
        <span>CURRENT ACOUSTIC ESTIMATE</span>
        <b>{current.label}</b>
        <div><output>{current.pitch ? `${Math.round(current.pitch)} Hz` : "— Hz"}</output><output>{current.confidence ? `${Math.round(current.confidence * 100)}% confidence` : "Insufficient periodicity"}</output></div>
      </div>
      <div className="profile-window">
        <div className="profile-window-labels"><span>VISIBLE {windowSeconds}s PROFILE WINDOW</span><span>{formatTime(range.start)} – {formatTime(range.end)}</span></div>
        <button type="button" className="profile-timeline" aria-label="Synchronized voice profile timeline. Tap to seek." onPointerDown={(event) => {
          if (!range.span) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek(range.start + (event.clientX - rect.left) / rect.width * range.span);
        }} onKeyDown={(event) => {
          if (!analysis?.duration) return;
          if (event.key === "ArrowLeft") onSeek(Math.max(0, currentTime - 5));
          else if (event.key === "ArrowRight") onSeek(Math.min(analysis.duration, currentTime + 5));
          else if (event.key === "Home") onSeek(0);
          else if (event.key === "End") onSeek(analysis.duration);
          else return;
          event.preventDefault();
        }}>
          {timelineColumns}
          <span className="profile-cursor" style={{ left: `${range.cursorRatio * 100}%` }}/>
        </button>
        <div className="profile-legend"><span className="lower">Lower</span><span className="higher">Higher</span><span className="uncertain">Uncertain</span></div>
      </div>
      <div className="profile-summary">
        <div className="lower"><span>LOWER</span><b>{percentage(counts.lower)}%</b></div>
        <div className="higher"><span>HIGHER</span><b>{percentage(counts.higher)}%</b></div>
        <div className="uncertain"><span>UNCERTAIN</span><b>{percentage(counts.uncertain)}%</b></div>
      </div>
      <p className="profile-caveat"><Info/>Acoustic pitch presentation only—not gender identity. Vocal ranges overlap, and whispers may have no measurable pitch.</p>
    </div> : <p className="profile-off">Enable after analysis to reveal the voice-profile strip beneath transport.</p>}
  </section>;
}
