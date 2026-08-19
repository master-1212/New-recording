import assert from "node:assert/strict";
import test from "node:test";
import { estimateNoiseFingerprint, spectralByteToDb } from "../src/lib/noiseProfile.ts";
import { createAdaptiveLanguageSegments, mergeSegmentWords } from "../src/lib/transcript.ts";
import { preprocessTranscriptionAudio, spectralSubtractionGain } from "../src/lib/transcriptionAudio.ts";

test("noise learning produces a per-band fingerprint and excludes obvious speech", () => {
  const columns = 24;
  const bands = 4;
  const spectral = new Uint8Array(columns * bands);
  const rms = new Float32Array(columns);
  const speech = new Float32Array(columns);
  const whisper = new Float32Array(columns);
  for (let column = 0; column < columns; column++) {
    const voiced = column >= 18;
    rms[column] = voiced ? 0.2 : 0.012 + column % 3 * 0.0005;
    speech[column] = voiced ? 0.92 : 0.08;
    whisper[column] = voiced ? 0.7 : 0.12;
    for (let band = 0; band < bands; band++) spectral[column * bands + band] = voiced ? 230 : 55 + band * 18 + column % 2;
  }
  const profile = estimateNoiseFingerprint({ columns, bands, spectral, rms, speech, whisper });
  assert.ok(profile);
  assert.equal(profile.spectrumDb.length, bands);
  assert.ok(Math.abs(profile.spectrumDb[0] - spectralByteToDb(56)) < 0.5);
  assert.ok(profile.spectrumDb[3] > profile.spectrumDb[0]);
  assert.ok(profile.floor < 0.02, "speech frames contaminated the learned noise floor");
  assert.ok(profile.confidence > 50);
});

test("noise learning falls back to quiet frames when broadband noise confuses VAD", () => {
  const columns = 20;
  const bands = 6;
  const spectral = new Uint8Array(columns * bands).fill(64);
  const rms = Float32Array.from({ length: columns }, (_, index) => 0.01 + index * 0.0002);
  const speech = new Float32Array(columns).fill(0.9);
  const whisper = new Float32Array(columns).fill(0.8);
  const profile = estimateNoiseFingerprint({ columns, bands, spectral, rms, speech, whisper });
  assert.ok(profile);
  assert.ok(Number.isFinite(profile.floor) && profile.floor > 0);
  assert.ok(profile.confidence > 0 && profile.confidence < 50);
  assert.ok(profile.spectrumDb.every(Number.isFinite));
});

test("spectral subtraction suppresses noise-like bins but preserves strong speech bins", () => {
  const noiseAmplitude = Math.pow(10, -52 / 20);
  const nearFloor = spectralSubtractionGain(noiseAmplitude * 1.1, -52, 1_800, 0.85);
  const speechAboveFloor = spectralSubtractionGain(noiseAmplitude * 8, -52, 1_800, 0.85);
  assert.ok(nearFloor < 0.3);
  assert.ok(speechAboveFloor > 0.95);
});

test("transcription cleanup reduces the learned background before conditional voice lift", () => {
  const sampleRate = 16_000;
  const audio = new Float32Array(sampleRate * 2);
  let seed = 17;
  for (let index = 0; index < audio.length; index++) {
    seed = seed * 16807 % 2147483647;
    const noise = (seed / 2147483647 * 2 - 1) * 0.02;
    const voice = index >= sampleRate ? Math.sin(2 * Math.PI * 190 * index / sampleRate) * 0.08 : 0;
    audio[index] = noise + voice;
  }
  const beforeNoise = rms(audio, 0, sampleRate);
  const beforeVoice = rms(audio, sampleRate, audio.length);
  preprocessTranscriptionAudio(audio, {
    enabled: true,
    sampleRate,
    duration: 2,
    suppression: 0.85,
    clarity: 0.7,
    deMuffle: 0.6,
    whisperLift: 0.75,
    whisperRecovery: true,
    noiseSpectrum: new Float32Array(72).fill(-58),
    noiseSpectrumMinHz: 45,
    noiseSpectrumMaxHz: 5_800,
    activity: new Float32Array([0.05, 0.05, 0.05, 0.05, 0.9, 0.9, 0.9, 0.9]),
  });
  const afterNoise = rms(audio, 0, sampleRate);
  const afterVoice = rms(audio, sampleRate, audio.length);
  assert.ok(afterNoise < beforeNoise * 0.85, `background was not reduced: ${beforeNoise} -> ${afterNoise}`);
  assert.ok(afterVoice > afterNoise * 2.5, "speech did not remain separated from the cleaned background");
  assert.ok(afterVoice < beforeVoice * 1.8, "cleanup became broad amplification");
});

test("adaptive multilingual segmentation re-detects language and owns overlap words once", () => {
  const segments = createAdaptiveLanguageSegments(40 * 16_000, 16_000, 18, 2);
  assert.equal(segments.length, 3);
  let words = mergeSegmentWords([], [{ text: " hello", timestamp: [16.8, 17.2] }], segments[0]);
  words = mergeSegmentWords(words, [{ text: " hello", timestamp: [0.8, 1.2] }, { text: " नमस्ते", timestamp: [2, 2.5] }], segments[1]);
  assert.equal(words.filter((word) => word.text.trim() === "hello").length, 1);
  assert.equal(words.at(-1)?.text.trim(), "नमस्ते");
  assert.ok(words.at(-1)!.start >= 18);
});

function rms(audio: Float32Array, start: number, end: number) {
  let sum = 0;
  for (let index = start; index < end; index++) sum += audio[index] * audio[index];
  return Math.sqrt(sum / Math.max(1, end - start));
}
