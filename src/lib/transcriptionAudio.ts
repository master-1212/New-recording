import type { TranscriptionPreprocess } from "@/types/audio";

const FFT_SIZE = 512;
const HOP_SIZE = 128;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function spectralSubtractionGain(signalAmplitude: number, noiseDb: number, frequency: number, amount: number) {
  const signalPower = Math.max(1e-14, signalAmplitude * signalAmplitude);
  const noiseAmplitude = Math.pow(10, noiseDb / 20);
  const subtraction = 1 + clamp(amount) * 2.2;
  const speechFloor = frequency >= 100 && frequency <= 6_500 ? 0.18 : frequency < 80 ? 0.06 : 0.1;
  const residualPower = Math.max(signalPower - subtraction * noiseAmplitude * noiseAmplitude, signalPower * speechFloor * speechFloor);
  return Math.sqrt(residualPower / signalPower);
}

function noiseAtFrequency(profile: Float32Array, frequency: number, minimumFrequency: number, maximumFrequency: number) {
  if (!profile.length) return -90;
  const clamped = Math.max(minimumFrequency, Math.min(maximumFrequency, frequency));
  const ratio = Math.log(clamped / minimumFrequency) / Math.log(maximumFrequency / minimumFrequency);
  const position = clamp(ratio) * (profile.length - 1);
  const before = Math.floor(position);
  const after = Math.min(profile.length - 1, before + 1);
  const fraction = position - before;
  return profile[before] * (1 - fraction) + profile[after] * fraction;
}

function fft(real: Float32Array, imaginary: Float32Array, inverse = false) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index++) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let width = 2; width <= length; width <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < length; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < width / 2; index++) {
        const left = offset + index;
        const right = left + width / 2;
        const rightReal = real[right] * twiddleReal - imaginary[right] * twiddleImaginary;
        const rightImaginary = real[right] * twiddleImaginary + imaginary[right] * twiddleReal;
        real[right] = real[left] - rightReal;
        imaginary[right] = imaginary[left] - rightImaginary;
        real[left] += rightReal;
        imaginary[left] += rightImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index++) real[index] /= length;
}

function highpassInPlace(audio: Float32Array, sampleRate: number, cutoff = 72) {
  const timeConstant = 1 / (2 * Math.PI * cutoff);
  const interval = 1 / sampleRate;
  const coefficient = timeConstant / (timeConstant + interval);
  let previousInput = audio[0] || 0;
  let previousOutput = 0;
  for (let index = 0; index < audio.length; index++) {
    const input = audio[index];
    const output = coefficient * (previousOutput + input - previousInput);
    audio[index] = output;
    previousInput = input;
    previousOutput = output;
  }
}

function activityAt(config: TranscriptionPreprocess, time: number) {
  if (!config.activity?.length || !config.duration) return 0;
  const index = Math.max(0, Math.min(config.activity.length - 1, Math.floor(time / config.duration * config.activity.length)));
  return clamp(config.activity[index]);
}

function subtractSpectrumInPlace(audio: Float32Array, config: TranscriptionPreprocess, onProgress?: (progress: number) => void) {
  const profile = config.noiseSpectrum;
  if (!profile?.length) return;
  const history = new Float32Array(FFT_SIZE);
  const overlap = new Float32Array(FFT_SIZE);
  const normalization = new Float32Array(FFT_SIZE);
  const real = new Float32Array(FFT_SIZE);
  const imaginary = new Float32Array(FFT_SIZE);
  const gains = new Float32Array(FFT_SIZE / 2 + 1);
  const priorGains = new Float32Array(FFT_SIZE / 2 + 1).fill(1);
  const window = new Float32Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index++) window[index] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * index / (FFT_SIZE - 1)));
  const totalBlocks = Math.ceil((audio.length + FFT_SIZE - HOP_SIZE) / HOP_SIZE);
  let block = 0;
  for (let readStart = 0; readStart < audio.length + FFT_SIZE - HOP_SIZE; readStart += HOP_SIZE) {
    history.copyWithin(0, HOP_SIZE);
    history.fill(0, FFT_SIZE - HOP_SIZE);
    for (let index = 0; index < HOP_SIZE && readStart + index < audio.length; index++) history[FFT_SIZE - HOP_SIZE + index] = audio[readStart + index];
    for (let index = 0; index < FFT_SIZE; index++) {
      real[index] = history[index] * window[index];
      imaginary[index] = 0;
    }
    fft(real, imaginary);
    const frameStart = readStart - (FFT_SIZE - HOP_SIZE);
    const voiceActivity = activityAt(config, (frameStart + FFT_SIZE / 2) / config.sampleRate);
    for (let bin = 0; bin <= FFT_SIZE / 2; bin++) {
      const frequency = bin * config.sampleRate / FFT_SIZE;
      const amplitude = Math.hypot(real[bin], imaginary[bin]) / FFT_SIZE;
      const noiseDb = noiseAtFrequency(profile, frequency, config.noiseSpectrumMinHz, config.noiseSpectrumMaxHz);
      let gain = spectralSubtractionGain(amplitude, noiseDb, frequency, config.suppression);
      if (frequency >= 180 && frequency <= 650) gain *= 1 - config.deMuffle * 0.16;
      if (frequency >= 1_000 && frequency <= 4_800) gain *= 1 + voiceActivity * config.clarity * 0.22;
      const temporal = gain < priorGains[bin] ? 0.58 : 0.16;
      gains[bin] = priorGains[bin] + (gain - priorGains[bin]) * temporal;
    }
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const smoothed = (gains[bin - 1] + gains[bin] * 2 + gains[bin + 1]) / 4;
      priorGains[bin] = smoothed;
      real[bin] *= smoothed;
      imaginary[bin] *= smoothed;
      real[FFT_SIZE - bin] *= smoothed;
      imaginary[FFT_SIZE - bin] *= smoothed;
    }
    real[0] *= gains[0]; imaginary[0] *= gains[0];
    real[FFT_SIZE / 2] *= gains[FFT_SIZE / 2]; imaginary[FFT_SIZE / 2] *= gains[FFT_SIZE / 2];
    fft(real, imaginary, true);
    for (let index = 0; index < FFT_SIZE; index++) {
      overlap[index] += real[index] * window[index];
      normalization[index] += window[index] * window[index];
    }
    const writeStart = frameStart;
    if (writeStart >= 0) {
      for (let index = 0; index < HOP_SIZE && writeStart + index < audio.length; index++) {
        audio[writeStart + index] = overlap[index] / Math.max(1e-6, normalization[index]);
      }
    }
    overlap.copyWithin(0, HOP_SIZE); overlap.fill(0, FFT_SIZE - HOP_SIZE);
    normalization.copyWithin(0, HOP_SIZE); normalization.fill(0, FFT_SIZE - HOP_SIZE);
    block++;
    if (block % 160 === 0) onProgress?.(Math.min(0.88, block / totalBlocks * 0.88));
  }
}

function liftDetectedSpeechInPlace(audio: Float32Array, config: TranscriptionPreprocess) {
  if (!config.activity?.length) return;
  let smoothedGain = 1;
  const attack = 1 - Math.exp(-1 / (config.sampleRate * 0.045));
  const release = 1 - Math.exp(-1 / (config.sampleRate * 0.16));
  for (let index = 0; index < audio.length; index++) {
    const activity = activityAt(config, index / config.sampleRate);
    const credibleVoice = clamp((activity - 0.28) / 0.62);
    const maximumLiftDb = config.whisperRecovery ? config.whisperLift * 4.5 : config.whisperLift * 2;
    const target = Math.pow(10, maximumLiftDb * credibleVoice / 20);
    smoothedGain += (target - smoothedGain) * (target > smoothedGain ? attack : release);
    audio[index] = Math.max(-0.98, Math.min(0.98, audio[index] * smoothedGain));
  }
}

export function preprocessTranscriptionAudio(audio: Float32Array, config: TranscriptionPreprocess, onProgress?: (progress: number) => void) {
  if (!config.enabled || !audio.length) return audio;
  highpassInPlace(audio, config.sampleRate);
  subtractSpectrumInPlace(audio, config, onProgress);
  liftDetectedSpeechInPlace(audio, config);
  onProgress?.(1);
  return audio;
}

