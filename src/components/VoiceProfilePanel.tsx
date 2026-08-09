"use client";

import { useMemo, useState } from "react";
import { AudioWaveform, Info, UsersRound } from "lucide-react";
import { analysisFrameAtTime, analysisFrameDuration } from "@/lib/analysisClock";
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
  const index = analysisFrameAtTime(analysis, time);
  return classifyProfile(analysis.pitch[index], analysis.profile[index], analysis.profileConfidence[index], analysis.speech[index]);
}

export function VoiceProfilePanel({ analysis, currentTime, windowSeconds, onSeek }: { analysis: AnalysisData | null; currentTime: number; windowSeconds: number; onSeek: (time: number) => void }) {
  const [enabled, setEnabled] = useState(false);
  const range = getVisibleTimeRange(currentTime, analysis?.duration ?? 0, windowSeconds);
  const current = profileAt(analysis, currentTime);
  const sampleSignature = analysis ? Array.from({ length: PROFILE_COLUMNS }, (_, slot) => analysisFrameAtTime(
    analysis,
    range.start + range.span * slot / (PROFILE_COLUMNS - 1),
  )).join(",") : "";
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
  const timeline = useMemo(() => {
    if (!analysis) return Array.from({ length: PROFILE_COLUMNS }, () => ({ kind: "none" as ProfileKind, confidence: 0 }));
    return sampleSignature.split(",").map((value) => {
      const index = Number(value);
      const sample = classifyProfile(analysis.pitch[index], analysis.profile[index], analysis.profileConfidence[index], analysis.speech[index]);
      return { kind: sample.kind, confidence: sample.confidence };
    });
  }, [analysis, sampleSignature]);
  const timelineColumns = useMemo(() => timeline.map((segment, index) => <i
    key={index}
    className={segment.kind}
    style={{ opacity: segment.kind === "none" ? 0.18 : 0.35 + segment.confidence * 0.65 }}
  />), [timeline]);
  const percentage = (count: number) => counts.voiced ? Math.round(count / counts.voiced * 100) : 0;
  const resolution = analysis ? analysisFrameDuration(analysis) : 0;
  const resolutionLabel = resolution < 1 ? `${Math.round(resolution * 1000)} ms` : `${resolution.toFixed(2)} s`;

  return <section className="profile-landscape" aria-label="Independent acoustic voice profile analysis">
    <div className="profile-landscape-head">
      <div className="profile-icon"><AudioWaveform/></div>
      <span><b><UsersRound/> Voice Profile Classification</b><small>Canonical centered frames · synchronized window · {analysis ? resolutionLabel : "awaiting analysis"} resolution</small></span>
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
