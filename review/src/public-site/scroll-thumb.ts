/**
 * The scroll thumb drawn on the right ruler line in place of the browser's scrollbar: its
 * length is the visible share of the page, its position how far the page is scrolled.
 */

/** Shortest the thumb gets on a very long page, so it stays easy to see and to grab. */
export const MIN_THUMB = 28;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The thumb within a track `track` pixels tall, or nothing when the page does not scroll. */
export function thumbFor(
  { scrollTop, scrollHeight, clientHeight }: ScrollMetrics,
  track: number,
): { top: number; height: number } | undefined {
  const range = scrollHeight - clientHeight;
  if (range < 1 || track <= 0) return undefined;
  const height = Math.min(track, Math.max(MIN_THUMB, (clientHeight / scrollHeight) * track));
  const scrolled = Math.min(range, Math.max(0, scrollTop)) / range;
  return { top: scrolled * (track - height), height };
}

/** How many pixels the page scrolls per pixel the thumb is dragged. */
export function scrollPerThumbPixel(metrics: ScrollMetrics, track: number): number {
  const thumb = thumbFor(metrics, track);
  if (!thumb || track - thumb.height <= 0) return 0;
  return (metrics.scrollHeight - metrics.clientHeight) / (track - thumb.height);
}

/** The scroll offset that centres the thumb on `y`, a point along the track. */
export function scrollToCentre(metrics: ScrollMetrics, track: number, y: number): number {
  const thumb = thumbFor(metrics, track);
  if (!thumb) return 0;
  const range = metrics.scrollHeight - metrics.clientHeight;
  const free = track - thumb.height;
  if (free <= 0) return 0;
  return (Math.min(free, Math.max(0, y - thumb.height / 2)) / free) * range;
}
