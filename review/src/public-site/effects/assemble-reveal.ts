import type { ScrollArea } from "../scroll-area";
import { advanceFrontier } from "./assembly-pace";
import { clipRects, HIDDEN } from "./clip";
import { select } from "./marks";
import { currentTransition, onCancel, stillRunning } from "./transition-run";

/** Size of one building block, in CSS pixels. */
const TILE = 10;
/** Time the assembly frontier takes to cross one view height at its base pace. */
const SWEEP_MS = 540;
/** Random lag per block, as a distance behind the frontier, so the frontier is ragged. */
const JITTER_PX = 170;
/** Extra drawn above and below the view, so fast scrolling never shows an undrawn edge. */
const MARGIN_ABOVE = 200;
const MARGIN_BELOW = 500;
/** How long one block takes to drop in and click into place. */
const PLACE_MS = 170;
/** How long lines marked to fade (the "Run by" line) take to fade in as the assembly starts. */
const FADE_MS = 220;

export interface AssembleReveal {
  /**
   * Assembles the page below `from` (a viewport y; everything above it shows at once) block by
   * block; resolves once the page is whole.
   */
  reveal(from: number): Promise<void>;
}

const transparent = (color: string) => color === "rgba(0, 0, 0, 0)" || color === "transparent";

/**
 * Rectangles of everything visible in `root`: text blocks, images, charts, and panels.
 * Elements matching `skip` (and what is inside them) are left out.
 */
export function visibleRects(root: Element, skip?: string, rects: DOMRect[] = []): DOMRect[] {
  for (const child of root.children) {
    if (skip && child.matches(skip)) continue;
    const style = getComputedStyle(child);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const boxed = style.borderTopWidth !== "0px" || !transparent(style.backgroundColor);
    const leaf =
      child.tagName === "svg" ||
      child.tagName === "IMG" ||
      [...child.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim());
    if (boxed || child.tagName === "svg" || child.tagName === "IMG")
      rects.push(child.getBoundingClientRect());
    else if (leaf) {
      // Text counts only where its lines actually run, not across its whole block.
      const range = document.createRange();
      range.selectNodeContents(child);
      rects.push(...range.getClientRects());
    }
    if (!leaf) visibleRects(child, skip, rects);
  }
  return rects;
}

/** Slight overshoot as a block clicks into place. */
const settle = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/**
 * Hides `content`, then builds it back block by block. The page is cut into small squares; a
 * ragged frontier creeps down from the start line, and each square with something in it pops
 * in as its own piece of the real page, growing from its centre and clicking into place with a
 * slight overshoot. Blank space is left blank, so only the page's actual parts are assembled.
 * Only the part on screen (the scroll area's visible band) takes part.
 */
export function assembleForReveal(content: HTMLElement, area: ScrollArea): AssembleReveal {
  const run = currentTransition();
  content.style.setProperty("clip-path", HIDDEN);
  let fading: HTMLElement[] = [];
  const clear = () => {
    content.style.removeProperty("clip-path");
    for (const element of fading)
      for (const name of ["opacity", "transition"]) element.style.removeProperty(name);
  };
  // A later transition (a quick back) must not leave this page's content hidden.
  const finished = onCancel(clear);

  return {
    reveal(from) {
      if (!stillRunning(run)) return Promise.resolve();
      const page = content.getBoundingClientRect();
      const view = area.view();
      const width = Math.ceil(page.width);
      const height = Math.ceil(view.height + MARGIN_ABOVE + MARGIN_BELOW);
      if (width <= 0) {
        clear();
        finished();
        return Promise.resolve();
      }

      // Parts marked to fade (not assemble) sit above the start line; they fade in as it starts.
      fading = [...content.querySelectorAll<HTMLElement>(select.revealFade)];
      for (const element of fading) {
        element.style.transition = "none";
        element.style.opacity = "0";
        // Make the hidden state register before animating away from it; otherwise the browser
        // sees both changes in one frame and the line just appears.
        void element.offsetHeight;
        element.style.transition = `opacity ${FADE_MS}ms ease-out`;
        element.style.opacity = "1";
      }

      // Everything is in the content's own coordinates (0 at its top), so scrolling moves the
      // view over the pieces rather than the pieces themselves. Pieces cover the whole page.
      const startLine = from - page.top;
      const rects = visibleRects(content).map((rect) => ({
        left: rect.left - page.left,
        right: rect.right - page.left,
        top: rect.top - page.top,
        bottom: rect.bottom - page.top,
      }));
      const pieces: { x: number; y: number; lag: number; startedAt: number }[] = [];
      // Tiles sit on a fixed grid from the page's top.
      for (let y = Math.max(0, Math.floor(startLine / TILE) * TILE); y < page.height; y += TILE) {
        for (let x = 0; x < width; x += TILE) {
          const filled = rects.some(
            (rect) =>
              rect.left < x + TILE && rect.right > x && rect.top < y + TILE && rect.bottom > y,
          );
          if (filled) pieces.push({ x, y, lag: Math.random() * JITTER_PX, startedAt: -1 });
        }
      }

      return new Promise((resolve) => {
        // The frontier creeps down at its own pace (even across the view, then speeding up
        // below it) and, on top of that, moves with the page whenever the visitor scrolls, so
        // scrolling never outruns the assembly.
        const shape = {
          base: view.height / SWEEP_MS,
          fold: view.bottom - page.top,
          view: view.height,
        };
        let frontier = startLine;
        let last = performance.now();
        let scrolled = area.top();
        const frame = (now: number) => {
          if (!stillRunning(run)) return;
          frontier = advanceFrontier(frontier, Math.min(now - last, 50), shape);
          frontier += Math.max(0, area.top() - scrolled);
          last = now;
          scrolled = area.top();
          // The band drawn: the view and a margin around it, in the content's own pixels.
          const region = area.view().top - content.getBoundingClientRect().top - MARGIN_ABOVE;
          const shown = clipRects();
          // Everything above the first piece still moving is whole: the title, and every row
          // already in place, drawn as one solid area rather than as tiles.
          let solid = page.height;
          for (const piece of pieces)
            if (piece.startedAt < 0 || now - piece.startedAt < PLACE_MS)
              solid = Math.min(solid, piece.y);
          shown.add(0, 0, width, Math.max(startLine, solid));
          let waiting = false;
          for (const piece of pieces) {
            if (piece.startedAt < 0) {
              if (frontier < piece.y + piece.lag) {
                waiting = true;
                continue;
              }
              piece.startedAt = now;
            }
            const t = (now - piece.startedAt) / PLACE_MS;
            if (t < 1) waiting = true;
            if (piece.y < region - TILE || piece.y > region + height) continue;
            // The piece grows from its centre and settles with a slight overshoot.
            const side = t >= 1 ? TILE : TILE * Math.min(1.1, settle(t));
            const inset = (TILE - side) / 2;
            shown.add(piece.x + inset, piece.y + inset, side, side);
          }
          content.style.setProperty("clip-path", shown.css());
          if (waiting) requestAnimationFrame(frame);
          else {
            clear();
            finished();
            resolve();
          }
        };
        requestAnimationFrame(frame);
      });
    },
  };
}
