"use client";

import { useMemo, useState } from "react";
import { AudioWaveform, Info, UsersRound } from "lucide-react";
import type { AnalysisData } from "@/types/audio";

type ProfileKind = "lower" | "higher" | "uncertain" | "none";

type ProfileSample = {
  kind: ProfileKind;
  label: string;
  pitch: number;
  confidence: number;
};

const PROFILE_COLUMNS = 84;

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

export function VoiceProfilePanel({ analysis, currentTime, onSeek }: { analysis: AnalysisData | null; currentTime: number; onSeek: (time: number) => void }) {
  const [enabled, setEnabled] = useState(false);
  const current = profileAt(analysis, currentTime);
  const summary = useMemo(() => {
    const counts = { lower: 0, higher: 0, uncertain: 0, voiced: 0 };
    const timeline = Array.from({ length: PROFILE_COLUMNS }, (_, slot) => {
      if (!analysis) return { kind: "none" as ProfileKind, confidence: 0 };
      const start = Math.floor(slot / PROFILE_COLUMNS * analysis.columns);
      const end = Math.max(start + 1, Math.floor((slot + 1) / PROFILE_COLUMNS * analysis.columns));
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
    });

    if (analysis) {
      for (let index = 0; index < analysis.columns; index++) {
        if (analysis.speech[index] < 0.42) continue;
        const sample = classifyProfile(analysis.pitch[index], analysis.profile[index], analysis.profileConfidence[index], analysis.speech[index]);
        if (sample.kind === "none") continue;
        counts.voiced++;
        if (sample.kind === "lower") counts.lower++;
        else if (sample.kind === "higher") counts.higher++;
        else counts.uncertain++;
      }
    }
    return { counts, timeline };
  }, [analysis]);
  const percentage = (count: number) => summary.counts.voiced ? Math.round(count / summary.counts.voiced * 100) : 0;
  const timelineColumns = useMemo(() => summary.timeline.map((segment, index) => <i
    key={index}
    className={segment.kind}
    style={{ opacity: segment.kind === "none" ? 0.18 : 0.35 + segment.confidence * 0.65 }}
  />), [summary.timeline]);

  return <>
    <div className="inspector-title profile-title"><UsersRound/><span>VOICE PROFILE ANALYSIS</span></div>
    <section className="profile-card" aria-label="Independent acoustic voice profile analysis">
      <div className="profile-switch-row">
        <div className="profile-icon"><AudioWaveform/></div>
        <span><b>Voice profile classification</b><small>Independent local pitch analysis</small></span>
        <button role="switch" aria-label="Enable voice profile classification" aria-checked={enabled} className={enabled ? "toggle on" : "toggle"} onClick={() => setEnabled((active) => !active)} disabled={!analysis}><i/></button>
      </div>
      {enabled ? <>
        <div className={`profile-current ${current.kind}`}>
          <span>CURRENT ACOUSTIC ESTIMATE</span>
          <b>{current.label}</b>
          <div><output>{current.pitch ? `${Math.round(current.pitch)} Hz` : "— Hz"}</output><output>{current.confidence ? `${Math.round(current.confidence * 100)}% confidence` : "Insufficient periodicity"}</output></div>
        </div>
        <div className="profile-summary">
          <div className="lower"><span>LOWER RANGE</span><b>{percentage(summary.counts.lower)}%</b></div>
          <div className="higher"><span>HIGHER RANGE</span><b>{percentage(summary.counts.higher)}%</b></div>
          <div className="uncertain"><span>UNCERTAIN</span><b>{percentage(summary.counts.uncertain)}%</b></div>
        </div>
        <button type="button" className="profile-timeline" aria-label="Voice profile timeline. Tap to seek." onPointerDown={(event) => {
          if (!analysis?.duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek((event.clientX - rect.left) / rect.width * analysis.duration);
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
          <span className="profile-cursor" style={{ left: `${analysis?.duration ? currentTime / analysis.duration * 100 : 0}%` }}/>
        </button>
        <div className="profile-legend"><span className="lower">Lower</span><span className="higher">Higher</span><span className="uncertain">Uncertain</span></div>
        <p className="profile-caveat"><Info/>This estimates vocal pitch presentation, not gender identity. Vocal ranges overlap, and whispers may not contain a measurable pitch.</p>
      </> : <p className="profile-off">Load a recording, then enable this module to view its independent acoustic profile timeline.</p>}
    </section>
  </>;
}
