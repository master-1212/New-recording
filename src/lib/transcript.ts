import type { TranscriptWord } from "@/types/audio";

export type TranscriptSegment = {
  startSample: number;
  endSample: number;
  startTime: number;
  endTime: number;
  keepFrom: number;
  keepTo: number;
};

export function createAdaptiveLanguageSegments(totalSamples: number, sampleRate: number, segmentSeconds = 18, overlapSeconds = 2): TranscriptSegment[] {
  if (totalSamples <= 0 || sampleRate <= 0) return [];
  const duration = totalSamples / sampleRate;
  const length = Math.max(6, segmentSeconds);
  const overlap = Math.min(Math.max(0, overlapSeconds), length / 3);
  if (duration <= length) return [{ startSample: 0, endSample: totalSamples, startTime: 0, endTime: duration, keepFrom: 0, keepTo: duration }];
  const step = length - overlap;
  const segments: TranscriptSegment[] = [];
  for (let startTime = 0; startTime < duration; startTime += step) {
    const endTime = Math.min(duration, startTime + length);
    const first = segments.length === 0;
    const last = endTime >= duration;
    segments.push({
      startSample: Math.floor(startTime * sampleRate),
      endSample: Math.min(totalSamples, Math.ceil(endTime * sampleRate)),
      startTime,
      endTime,
      keepFrom: first ? startTime : startTime + overlap / 2,
      keepTo: last ? endTime : endTime - overlap / 2,
    });
    if (last) break;
  }
  return segments;
}

export function mergeSegmentWords(existing: TranscriptWord[], chunks: Array<{ text: string; timestamp: [number, number | null] }>, segment: TranscriptSegment) {
  const merged = existing.slice();
  for (const chunk of chunks) {
    const localStart = chunk.timestamp[0];
    if (!Number.isFinite(localStart)) continue;
    const localEnd = Number.isFinite(chunk.timestamp[1]) ? (chunk.timestamp[1] as number) : localStart;
    const start = Math.max(segment.startTime, segment.startTime + localStart);
    const end = Math.min(segment.endTime, Math.max(start, segment.startTime + localEnd));
    const center = (start + end) / 2;
    if (center < segment.keepFrom || center > segment.keepTo) continue;
    const text = chunk.text;
    const prior = merged.at(-1);
    if (prior && prior.text.trim().toLocaleLowerCase() === text.trim().toLocaleLowerCase() && Math.abs(prior.start - start) < 0.5) continue;
    merged.push({ text, start, end });
  }
  return merged;
}

