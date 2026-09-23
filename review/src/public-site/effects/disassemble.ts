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
const MASK_SCALE = 0.5;
const FADE_MS = 200;

/**
 * Takes the frozen page on `sheet` apart from the bottom up: the reverse of the assembly.
 * Each block with something in it shrinks away, a ragged frontier climbing toward
 * `keepAbove` (a viewport y); everything above that line stays. Lines marked to fade (the
 * "Run by" line) fade out whole instead, over `fadeMs`. Resolves when only the kept part is left; the sheet
 * itself (the paper) is untouched, for the fire to burn afterwards.
 */
export function disassemble(
  sheet: HTMLElement,
  keepAbove: number,
  fadeMs = FADE_MS,
): Promise<void> {
  const inner = sheet.firstElementChild;
  if (!(inner instanceof HTMLElement)) return Promise.resolve();
  const frame = sheet.getBoundingClientRect();
  const box = inner.getBoundingClientRect();
  const keep = Math.max(frame.top, Math.min(keepAbove, frame.bottom));
  const width = Math.ceil(frame.width);
  const height = Math.ceil(frame.height);
  const mask = document.createElement("canvas");
  mask.width = Math.ceil(width * MASK_SCALE);
  mask.height = Math.ceil(height * MASK_SCALE);
  const context = mask.getContext("2d");
  if (!context || width <= 0 || height <= 0) return Promise.resolve();
  context.scale(MASK_SCALE, MASK_SCALE);
  context.fillStyle = "#000";

  const fading = [...inner.querySelectorAll<HTMLElement>(select.revealFade)];
  for (const element of fading) {
    element.style.transition = `opacity ${fadeMs}ms ease-in`;
    void element.offsetHeight;
    element.style.opacity = "0";
  }
  // Fading lines keep their area open so their fade shows, wherever they sit.
  const open = fading.map((element) => element.getBoundingClientRect());

  const rects = visibleRects(inner, select.revealFade);
  const pieces: { x: number; y: number; at: number }[] = [];
  for (let y = keep - frame.top; y < height; y += TILE) {
    for (let x = 0; x < width; x += TILE) {
      const left = frame.left + x;
      const upper = frame.top + y;
      const filled = rects.some(
        (rect) =>
          rect.left < left + TILE &&
          rect.right > left &&
          rect.top < upper + TILE &&
          rect.bottom > upper,
      );
      if (!filled) continue;
      // Bottom first: depth 0 at the keep line, 1 at the bottom of the view.
      const depth = (upper - keep) / Math.max(1, frame.bottom - keep);
      pieces.push({ x, y, at: (1 - depth) * SWEEP_MS + Math.random() * JITTER_MS });
    }
  }
  const last = Math.max(fadeMs, ...pieces.map((piece) => piece.at + PLACE_MS));
  inner.style.setProperty("mask-size", `${width}px ${height}px`);
  inner.style.setProperty("mask-position", `${frame.left - box.left}px ${frame.top - box.top}px`);
  inner.style.setProperty("mask-repeat", "no-repeat");

  const run = currentTransition();
  return new Promise((resolve) => {
    const begin = performance.now();
    const frameStep = (now: number) => {
      if (!stillRunning(run)) return;
      const elapsed = now - begin;
      context.clearRect(0, 0, width, height);
      context.fillRect(0, 0, width, keep - frame.top);
      for (const rect of open)
        context.fillRect(rect.left - frame.left, rect.top - frame.top, rect.width, rect.height);
      for (const piece of pieces) {
        const t = (elapsed - piece.at) / PLACE_MS;
        if (t >= 1) continue;
        // Shrinks toward its centre, slowly at first and then quickly away.
        const side = t <= 0 ? TILE : TILE * (1 - t * t);
        const inset = (TILE - side) / 2;
        context.fillRect(piece.x + inset, piece.y + inset, side, side);
      }
      inner.style.setProperty("mask-image", `url(${mask.toDataURL()})`);
      if (elapsed < last) requestAnimationFrame(frameStep);
      else resolve();
    };
    requestAnimationFrame(frameStep);
  });
}
