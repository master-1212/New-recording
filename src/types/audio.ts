export type AnalysisData = {
  duration: number;
  columns: number;
  bands: number;
  waveform: Float32Array;
  spectral: Uint8Array;
  rms: Float32Array;
  peak: Float32Array;
  speech: Float32Array;
  dominant: Float32Array;
};

export type EnhanceSettings = {
  enabled: boolean;
  strength: number;
  clarity: number;
  suppression: number;
  gain: number;
};

export type LiveMetrics = {
  speech: number;
  peak: number;
  rms: number;
  dominant: number;
};
