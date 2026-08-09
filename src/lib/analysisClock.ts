export type AnalysisClock = {
  duration: number;
  columns: number;
  sampleRate: number;
  totalSamples: number;
};

export type AnalysisFrame = {
  index: number;
  startSample: number;
  centerSample: number;
  endSample: number;
  startTime: number;
  centerTime: number;
  endTime: number;
};

function safeFrameIndex(clock: AnalysisClock, index: number) {
  return Math.min(Math.max(0, clock.columns - 1), Math.max(0, Math.floor(index)));
}

export function analysisDuration(clock: AnalysisClock) {
  return clock.sampleRate > 0 && clock.totalSamples > 0
    ? clock.totalSamples / clock.sampleRate
    : Math.max(0, clock.duration);
}

export function analysisFrameAtTime(clock: AnalysisClock, time: number) {
  if (!clock.columns || !clock.totalSamples || !clock.sampleRate) return 0;
  const sample = Math.min(clock.totalSamples - 1, Math.max(0, Math.floor(time * clock.sampleRate)));
  return safeFrameIndex(clock, Math.floor(sample / clock.totalSamples * clock.columns));
}

export function analysisFrame(clock: AnalysisClock, index: number): AnalysisFrame {
  const safeIndex = safeFrameIndex(clock, index);
  const startSample = Math.floor(safeIndex / clock.columns * clock.totalSamples);
  const endSample = Math.max(startSample + 1, Math.floor((safeIndex + 1) / clock.columns * clock.totalSamples));
  const centerSample = Math.floor((startSample + endSample) / 2);
  return {
    index: safeIndex,
    startSample,
    centerSample,
    endSample,
    startTime: startSample / clock.sampleRate,
    centerTime: centerSample / clock.sampleRate,
    endTime: endSample / clock.sampleRate,
  };
}

export function analysisFrameDuration(clock: AnalysisClock) {
  return analysisDuration(clock) / Math.max(1, clock.columns);
}

export function visibleAnalysisFrames(clock: AnalysisClock, startTime: number, endTime: number) {
  const first = analysisFrameAtTime(clock, startTime);
  const endProbe = Math.max(startTime, endTime - 1 / Math.max(1, clock.sampleRate));
  const last = analysisFrameAtTime(clock, endProbe);
  return { first, last };
}
