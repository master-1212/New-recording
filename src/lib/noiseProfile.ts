import type { AnalysisData } from "@/types/audio";

const SPECTRAL_DB_FLOOR = -90;
const SPECTRAL_DB_RANGE = 78;

export type NoiseFingerprint = {
  spectrumDb: Float32Array;
  floor: number;
  confidence: number;
  sampleCount: number;
};

export function spectralByteToDb(value: number) {
  return SPECTRAL_DB_FLOOR + Math.max(0, Math.min(255, value)) / 255 * SPECTRAL_DB_RANGE;
}

export function estimateNoiseFingerprint(
  data: Pick<AnalysisData, "bands" | "columns" | "spectral" | "rms" | "speech" | "whisper">,
  firstColumn = 0,
  lastColumn = data.columns,
): NoiseFingerprint | null {
  const first = Math.max(0, Math.min(data.columns - 1, Math.floor(firstColumn)));
  const last = Math.max(first + 1, Math.min(data.columns, Math.ceil(lastColumn)));
  const levels: number[] = [];
  for (let column = first; column < last; column++) if (data.rms[column] > 0) levels.push(data.rms[column]);
  if (levels.length < 4) return null;
  levels.sort((a, b) => a - b);
  const quietLimit = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.6))];
  let candidates: number[] = [];
  for (let column = first; column < last; column++) {
    if (data.rms[column] <= quietLimit * 1.35 && data.speech[column] < 0.48 && data.whisper[column] < 0.58) candidates.push(column);
  }

  let usedQuietFallback = false;
  if (candidates.length < Math.min(4, last - first)) {
    candidates = Array.from({ length: last - first }, (_, index) => first + index)
      .filter((column) => data.speech[column] < 0.62 && data.whisper[column] < 0.68)
      .sort((a, b) => data.rms[a] - data.rms[b])
      .slice(0, Math.max(4, Math.ceil((last - first) * 0.25)));
  }
  // Very muffled broadband noise can look speech-like to a lightweight VAD.
  // In that case use only the quietest frames and lower confidence rather than
  // returning an unusable empty profile. Silence is still rejected above.
  if (candidates.length < 4) {
    usedQuietFallback = true;
    candidates = Array.from({ length: last - first }, (_, index) => first + index)
      .filter((column) => Number.isFinite(data.rms[column]) && data.rms[column] > 0)
      .sort((a, b) => data.rms[a] - data.rms[b])
      .slice(0, Math.max(4, Math.ceil((last - first) * 0.18)));
  }
  if (candidates.length < 4) return null;

  const histograms = new Uint32Array(data.bands * 256);
  for (const column of candidates) {
    const offset = column * data.bands;
    for (let band = 0; band < data.bands; band++) histograms[band * 256 + data.spectral[offset + band]]++;
  }
  const spectrumDb = new Float32Array(data.bands);
  const spreads: number[] = [];
  for (let band = 0; band < data.bands; band++) {
    const base = band * 256;
    const percentile = (fraction: number) => {
      const target = Math.max(1, Math.ceil(candidates.length * fraction));
      let count = 0;
      for (let value = 0; value < 256; value++) {
        count += histograms[base + value];
        if (count >= target) return value;
      }
      return 255;
    };
    const low = percentile(0.2);
    const learned = percentile(0.7);
    const high = percentile(0.85);
    spectrumDb[band] = spectralByteToDb(learned);
    spreads.push(spectralByteToDb(high) - spectralByteToDb(low));
  }

  const candidateLevels = candidates.map((column) => data.rms[column]).sort((a, b) => a - b);
  const floor = candidateLevels[Math.min(candidateLevels.length - 1, Math.floor(candidateLevels.length * 0.65))];
  spreads.sort((a, b) => a - b);
  const typicalSpreadDb = spreads[Math.floor(spreads.length * 0.6)] ?? 18;
  const coverage = Math.min(1, candidates.length / Math.max(4, (last - first) * 0.45));
  const stability = 1 - Math.min(0.65, Math.max(0, typicalSpreadDb - 3) / 28);
  if (!Number.isFinite(floor) || floor <= 0) return null;
  const confidence = Math.max(1, Math.round(100 * coverage * stability * (usedQuietFallback ? 0.48 : 1)));
  return { spectrumDb, floor, confidence, sampleCount: candidates.length };
}
