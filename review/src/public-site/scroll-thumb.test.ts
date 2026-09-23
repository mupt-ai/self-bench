import { expect, test } from "bun:test";
import { MIN_THUMB, scrollPerThumbPixel, scrollToCentre, thumbFor } from "./scroll-thumb";

const track = 790;
const page = (scrollTop: number, scrollHeight = 3160) => ({
  scrollTop,
  scrollHeight,
  clientHeight: track,
});

test("the thumb is the visible share of the page, at the top and at the bottom", () => {
  expect(thumbFor(page(0), track)).toEqual({ top: 0, height: track / 4 });
  const bottom = thumbFor(page(3160 - 790), track);
  expect(bottom?.top).toBeCloseTo(track - track / 4, 6);
  // Overscroll (rubber-banding) never pushes it off the track.
  expect(thumbFor(page(-80), track)?.top).toBe(0);
  expect(thumbFor(page(99999), track)?.top).toBeCloseTo(track - track / 4, 6);
});

test("a page that does not scroll has no thumb", () => {
  expect(thumbFor(page(0, 790), track)).toBeUndefined();
  expect(thumbFor(page(0, 790.4), track)).toBeUndefined();
  expect(thumbFor(page(0), 0)).toBeUndefined();
});

test("a very long page keeps a thumb big enough to grab", () => {
  const thumb = thumbFor(page(0, 200_000), track);
  expect(thumb?.height).toBe(MIN_THUMB);
  const end = thumbFor(page(200_000 - 790, 200_000), track);
  expect((end?.top ?? 0) + (end?.height ?? 0)).toBeCloseTo(track, 6);
});

test("dragging the thumb by its free travel scrolls the whole page", () => {
  for (const height of [1200, 3160, 200_000]) {
    const metrics = page(0, height);
    const thumb = thumbFor(metrics, track);
    if (!thumb) throw new Error("expected a thumb");
    expect((track - thumb.height) * scrollPerThumbPixel(metrics, track)).toBeCloseTo(
      height - 790,
      6,
    );
  }
});

test("pressing the track centres the thumb under the pointer, clamped to the ends", () => {
  const metrics = page(0);
  const at = scrollToCentre(metrics, track, track / 2);
  const thumb = thumbFor({ ...metrics, scrollTop: at }, track);
  expect((thumb?.top ?? 0) + (thumb?.height ?? 0) / 2).toBeCloseTo(track / 2, 6);
  expect(scrollToCentre(metrics, track, 0)).toBe(0);
  expect(scrollToCentre(metrics, track, track)).toBeCloseTo(3160 - 790, 6);
});
