import { visibleRects } from "./assemble-reveal";
import { select } from "./marks";
import { currentTransition, stillRunning } from "./transition-run";

/** Size of one block, in CSS pixels; matches the assembly so the two read as a pair. */
const TILE = 10;
/** Time for the frontier to climb from the bottom of the view to the keep line. */
const SWEEP_MS = 300;
const JITTER_MS = 70;
/** How long one block takes to shrink away. */
const PLACE_MS = 110;
const FADE_MS = 200;
/**
 * Spread of the start times for blocks that go first: those of anything the `first` area
 * cuts through. With `PLACE_MS` they are gone in about 150ms, as the paper over that area is.
 */
const FIRST_JITTER_MS = 40;
/** How close to the `first` area a line may sit and still go first: text hugging its edge. */
const FIRST_MARGIN = 16;

/**
 * Takes the frozen page on `sheet` apart from the bottom up: the reverse of the assembly.
 * Each block with something in it shrinks away, a ragged frontier climbing toward
 * `keepAbove` (a viewport y); everything above that line stays. Lines marked to fade (the
 * "Run by" line) fade out whole instead, over `fadeMs`. Resolves when only the kept part is left; the sheet
 * itself (the paper) is untouched, for the fire to burn afterwards.
 *
 * `first` (a viewport box) is an area about to show through the paper, such as the card the
 * title returns to. Every line or panel it cuts through, or that hugs its edge, goes first and
 * whole, so none is left standing against it while the rest of the page comes apart.
 *
 * The blocks go by drawing the paper over them, on a canvas above the copy: the paper is one
 * plain colour, and the copy itself is never redrawn. (Masking or clipping the copy instead
 * made WebKit redraw the whole page every frame.)
 */
export function disassemble(
  sheet: HTMLElement,
  keepAbove: number,
  fadeMs = FADE_MS,
  first?: { left: number; top: number; width: number; height: number },
): Promise<void> {
  const inner = sheet.firstElementChild;
  if (!(inner instanceof HTMLElement)) return Promise.resolve();
  const frame = sheet.getBoundingClientRect();
  const keep = Math.max(frame.top, Math.min(keepAbove, frame.bottom));
  const width = Math.ceil(frame.width);
  const height = Math.ceil(frame.height);
  const scale = window.devicePixelRatio || 1;
  const cover = document.createElement("canvas");
  cover.width = Math.round(width * scale);
  cover.height = Math.round(height * scale);
  const context = cover.getContext("2d");
  if (!context || width <= 0 || height <= 0) return Promise.resolve();
  Object.assign(cover.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${width}px`,
    height: `${height}px`,
  });
  context.fillStyle = getComputedStyle(sheet).backgroundColor;
  inner.after(cover);
  // Leaves the copy showing through a rectangle of the sheet, on whole device pixels so that
  // neighbouring blocks meet without a seam.
  const pixel = (value: number) => Math.round(value * scale);
  const uncover = (left: number, top: number, across: number, down: number) =>
    context.clearRect(
      pixel(left),
      pixel(top),
      pixel(left + across) - pixel(left),
      pixel(top + down) - pixel(top),
    );

  const fading = [...inner.querySelectorAll<HTMLElement>(select.revealFade)];
  for (const element of fading) {
    element.style.transition = `opacity ${fadeMs}ms ease-in`;
    void element.offsetHeight;
    element.style.opacity = "0";
  }
  // Fading lines keep their area open so their fade shows, wherever they sit.
  const open = fading.map((element) => element.getBoundingClientRect());

  const rects = visibleRects(inner, select.revealFade);
  const overlaps = (
    rect: { left: number; right: number; top: number; bottom: number },
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) => rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
  const cut = first
    ? rects.filter((rect) =>
        overlaps(
          rect,
          first.left - FIRST_MARGIN,
          first.top - FIRST_MARGIN,
          first.left + first.width + FIRST_MARGIN,
          first.top + first.height + FIRST_MARGIN,
        ),
      )
    : [];
  const pieces: { x: number; y: number; at: number }[] = [];
  for (let y = keep - frame.top; y < height; y += TILE) {
    for (let x = 0; x < width; x += TILE) {
      const left = frame.left + x;
      const upper = frame.top + y;
      const touches = (rect: DOMRect) => overlaps(rect, left, upper, left + TILE, upper + TILE);
      if (!rects.some(touches)) continue;
      if (cut.some(touches)) {
        pieces.push({ x, y, at: Math.random() * FIRST_JITTER_MS });
        continue;
      }
      // Bottom first: depth 0 at the keep line, 1 at the bottom of the view.
      const depth = (upper - keep) / Math.max(1, frame.bottom - keep);
      pieces.push({ x, y, at: (1 - depth) * SWEEP_MS + Math.random() * JITTER_MS });
    }
  }
  const last = Math.max(fadeMs, ...pieces.map((piece) => piece.at + PLACE_MS));

  const run = currentTransition();
  return new Promise((resolve) => {
    const begin = performance.now();
    const frameStep = (now: number) => {
      if (!stillRunning(run)) return;
      const elapsed = now - begin;
      context.fillRect(0, 0, cover.width, cover.height);
      uncover(0, 0, width, keep - frame.top);
      for (const rect of open)
        uncover(rect.left - frame.left, rect.top - frame.top, rect.width, rect.height);
      for (const piece of pieces) {
        const t = (elapsed - piece.at) / PLACE_MS;
        if (t >= 1) continue;
        // Shrinks toward its centre, slowly at first and then quickly away.
        const side = t <= 0 ? TILE : TILE * (1 - t * t);
        const inset = (TILE - side) / 2;
        uncover(piece.x + inset, piece.y + inset, side, side);
      }
      if (elapsed < last) requestAnimationFrame(frameStep);
      else resolve();
    };
    requestAnimationFrame(frameStep);
  });
}
