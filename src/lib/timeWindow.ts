export type VisibleTimeRange = {
  start: number;
  end: number;
  span: number;
  cursorRatio: number;
};

export function getVisibleTimeRange(currentTime: number, duration: number, requestedSpan: number): VisibleTimeRange {
  const safeDuration = Math.max(0, duration);
  const span = Math.min(safeDuration, Math.max(0, requestedSpan));
  if (!span) return { start: 0, end: 0, span: 0, cursorRatio: 0 };

  const playhead = Math.min(safeDuration, Math.max(0, currentTime));
  const start = Math.min(Math.max(0, safeDuration - span), Math.max(0, playhead - span / 2));
  const end = start + span;

  return {
    start,
    end,
    span,
    cursorRatio: Math.min(1, Math.max(0, (playhead - start) / span)),
  };
}
