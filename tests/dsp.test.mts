import assert from "node:assert/strict";
import test from "node:test";
import { computeAdaptiveFrame, computeDspParameters, detectionThreshold, voiceLikelihood } from "../src/lib/dsp.ts";

const settings = {
  enabled: true,
  strength: 0.72,
  clarity: 0.8,
  suppression: 0.7,
  gain: 0.62,
  deMuffle: 0.8,
  humRemoval: 0.5,
  hissReduction: 0.7,
  whisperLift: 0.85,
};

const focus = {
  noiseFloor: null,
  noiseProfileEnabled: false,
  speechSensitivity: 0.86,
  whisperRecovery: true,
};

test("sensitivity lowers the detection threshold without exceeding bounds", () => {
  assert.equal(detectionThreshold(0), 0.68);
  assert.ok(Math.abs(detectionThreshold(1) - 0.32) < 1e-12);
  assert.ok(voiceLikelihood(0.2, 0.8, 1) > voiceLikelihood(0.2, 0.8, 0));
});

test("Whisper Recovery does not add broad unconditional makeup gain", () => {
  const parameters = computeDspParameters(settings, focus);
  assert.ok(parameters.makeupDb < 3.5, `unexpected ${parameters.makeupDb.toFixed(2)} dB makeup`);
  assert.ok(parameters.lowpassHz >= 13000, "speech consonants should not be cut at the old 8.2 kHz limit");
  assert.ok(parameters.compressorRatio < 5, "whispers should not be crushed by the old high-ratio compressor");
});

test("background receives attenuation and no adaptive voice lift", () => {
  const result = computeAdaptiveFrame({ speech: 0.05, whisper: 0.08, noise: 0.92, clarity: 0.1, rms: 0.01 }, settings, focus);
  assert.ok(result.reductionDb >= 4);
  assert.equal(result.voiceLiftDb, 0);
  assert.equal(result.voiceGain, 1);
});

test("credible whisper receives lift while suppression is protected", () => {
  const result = computeAdaptiveFrame({ speech: 0.35, whisper: 0.82, noise: 0.4, clarity: 0.72, rms: 0.012 }, settings, focus);
  assert.ok(result.voiceLiftDb > 2);
  assert.ok(result.reductionDb < 1.5);
});

test("learned noise profile increases attenuation only below its floor band", () => {
  const activeFocus = { ...focus, noiseFloor: 0.02, noiseProfileEnabled: true };
  const quietNoise = computeAdaptiveFrame({ speech: 0.03, whisper: 0.04, noise: 0.55, clarity: 0.1, rms: 0.012 }, settings, activeFocus);
  const louderSignal = computeAdaptiveFrame({ speech: 0.03, whisper: 0.04, noise: 0.55, clarity: 0.1, rms: 0.06 }, settings, activeFocus);
  assert.ok(quietNoise.reductionDb > louderSignal.reductionDb);
});

test("Original/A bypass disables every adaptive gain change", () => {
  const result = computeAdaptiveFrame(
    { speech: 0.9, whisper: 0.9, noise: 0.9, clarity: 0.9, rms: 0.001 },
    { ...settings, enabled: false },
    { ...focus, noiseFloor: 0.02, noiseProfileEnabled: true },
  );
  assert.deepEqual(result, { likelihood: 0, reductionDb: 0, gateGain: 1, voiceLiftDb: 0, voiceGain: 1 });
});

test("adaptive control math remains negligible over a long UI session", () => {
  const started = performance.now();
  let checksum = 0;
  // More than two hours of 15 Hz UI/DSP control updates.
  for (let index = 0; index < 120_000; index++) {
    const phase = index % 100 / 100;
    const result = computeAdaptiveFrame({ speech: phase, whisper: 1 - phase, noise: 0.7, clarity: 0.45, rms: 0.012 }, settings, focus);
    checksum += result.gateGain + result.voiceGain;
  }
  assert.ok(checksum > 0);
  assert.ok(performance.now() - started < 2_000, "adaptive update math is too slow for long-session playback");
});
