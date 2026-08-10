export type AnalysisData = {
  duration: number;
  columns: number;
  bands: number;
  sampleRate: number;
  totalSamples: number;
  waveform: Float32Array;
  overviewWaveform: Float32Array;
  spectral: Uint8Array;
  rms: Float32Array;
  peak: Float32Array;
  speech: Float32Array;
  whisper: Float32Array;
  noise: Float32Array;
  clarity: Float32Array;
  pitch: Float32Array;
  profile: Float32Array;
  profileConfidence: Float32Array;
  noiseFrames: number;
  noiseRms: Float32Array;
  dominant: Float32Array;
};

export type EnhanceSettings = {
  enabled: boolean;
  strength: number;
  clarity: number;
  suppression: number;
  gain: number;
  deMuffle: number;
  humRemoval: number;
  hissReduction: number;
  whisperLift: number;
};

export type FocusSettings = {
  voiceOnly: boolean;
  neuralDenoise: number;
  noiseFloor: number | null;
  noiseProfileEnabled: boolean;
  speechSensitivity: number;
  whisperRecovery: boolean;
};

export type TranscriptLanguage = "auto" | "en" | "hi" | "mr";

export type TranscriptWord = {
  text: string;
  start: number;
  end: number;
};

export type LiveMetrics = {
  speech: number;
  whisper: number;
  noise: number;
  clarity: number;
  pitch: number;
  profile: number;
  profileConfidence: number;
  peak: number;
  rms: number;
  dominant: number;
};
