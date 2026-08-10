import assert from "node:assert/strict";
import test from "node:test";
import { analysisFrame, analysisFrameAtTime, visibleAnalysisFrames } from "../src/lib/analysisClock.ts";
import { getVisibleTimeRange } from "../src/lib/timeWindow.ts";

const clock = { duration: 3600, columns: 12_000, sampleRate: 12_000, totalSamples: 43_200_000 };

test("waveform, spectrogram, and cursor share the same canonical frame clock", () => {
  for (const time of [0, 0.25, 29.9, 1800, 3599.99, 3600]) {
    const index = analysisFrameAtTime(clock, time);
    const frame = analysisFrame(clock, index);
    assert.ok(index >= 0 && index < clock.columns);
    assert.ok(frame.startTime <= Math.min(time, clock.duration));
    assert.ok(frame.endTime >= Math.min(time, clock.duration - 1 / clock.sampleRate));
  }
});

test("visible window clamps consistently at recording boundaries", () => {
  assert.deepEqual(getVisibleTimeRange(0, 100, 30), { start: 0, end: 30, span: 30, cursorRatio: 0 });
  assert.deepEqual(getVisibleTimeRange(50, 100, 30), { start: 35, end: 65, span: 30, cursorRatio: 0.5 });
  assert.deepEqual(getVisibleTimeRange(100, 100, 30), { start: 70, end: 100, span: 30, cursorRatio: 1 });
  assert.deepEqual(getVisibleTimeRange(4, 6, 30), { start: 0, end: 6, span: 6, cursorRatio: 4 / 6 });
});

test("visible frame sampling remains bounded for a 60-minute recording", () => {
  const range = getVisibleTimeRange(1800, 3600, 120);
  const frames = visibleAnalysisFrames(clock, range.start, range.end);
  assert.ok(frames.first >= 0);
  assert.ok(frames.last < clock.columns);
  assert.ok(frames.last - frames.first <= 402);
});
