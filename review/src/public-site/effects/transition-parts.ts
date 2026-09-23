import type { Origin } from "./burn";
import { type Box, FLIGHT_EASING, type FlightPath, flightKeyframes } from "./flight-path";
import { unmarkFlightTo } from "./marks";
import { reflowWords } from "./reflow";
import { currentTransition, newTransition, onCancel, stillRunning } from "./transition-run";

/** How long to wait for the next page to render the elements a transition needs. */
const WAIT_MS = 600;

/** The smallest rectangle around every element's box. */
export function union(elements: Element[]): Box {
  const rects = elements.map((element) => element.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

/** Converts a viewport box to coordinates inside `frame` (the frozen sheet's). */
export function inside(frame: DOMRect, box: Box): Origin {
  return {
    left: box.left - frame.left,
    top: box.top - frame.top,
    right: box.left + box.width - frame.left,
    bottom: box.top + box.height - frame.top,
  };
}

/** Where a part sits and how big its text is. */
export function measure(element: HTMLElement) {
  return {
    rect: element.getBoundingClientRect(),
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize) || 1,
  };
}

/**
 * A static copy of the scrolling area at its current scroll, laid exactly over it: the sheet
 * of paper the transitions burn. Its content sits in one inner element, which can be masked
 * apart separately from the paper behind it. See `beginWithSheet` for starting a transition.
 */
function paperFrom(scroller: HTMLElement, layout: HTMLElement): HTMLElement {
  const box = scroller.getBoundingClientRect();
  const sheet = document.createElement("div");
  sheet.setAttribute("aria-hidden", "true");
  sheet.setAttribute("inert", "");
  Object.assign(sheet.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    overflow: "hidden",
    scrollbarGutter: "stable both-edges",
    background: "var(--background)",
    pointerEvents: "none",
    // Above the page content and its cover, below the ruler lines.
    zIndex: "5",
  });
  const inner = document.createElement("div");
  inner.style.transform = `translateY(${-scroller.scrollTop}px)`;
  for (const child of scroller.children) inner.append(child.cloneNode(true));
  sheet.append(inner);
  layout.append(sheet);
  return sheet;
}

/**
 * Starts a transition over a frozen copy of the page. The copy is taken first, so a page caught
 * mid-transition (say, half assembled) is frozen exactly as it looks; then whatever the previous
 * transition is still doing is cancelled; then the new sheet is registered to go if this
 * transition is cancelled in turn.
 */
export function beginWithSheet(scroller: HTMLElement, layout: HTMLElement): HTMLElement {
  const sheet = paperFrom(scroller, layout);
  newTransition();
  onCancel(() => sheet.remove());
  return sheet;
}

/**
 * Calls back with whichever of `keys` `find` returns, once every one of `required` is there
 * (or after a timeout), so a transition can wait for the next page to render. Optional keys
 * (a description the page may not have) never hold it up.
 */
export function whenFound(
  keys: string[],
  find: (key: string) => HTMLElement | null | undefined,
  ready: (found: Map<string, HTMLElement>) => void,
  required: string[] = keys,
): void {
  const start = performance.now();
  const run = currentTransition();
  const wait = () => {
    if (!stillRunning(run)) return;
    const found = new Map(
      keys.flatMap((key) => {
        const element = find(key);
        return element ? [[key, element] as const] : [];
      }),
    );
    const missing = required.some((key) => !found.has(key));
    if (missing && performance.now() - start < WAIT_MS) requestAnimationFrame(wait);
    else ready(found);
  };
  requestAnimationFrame(wait);
}

/**
 * Flies a copy of `target` along `path` onto the target, which stays hidden until the caller
 * swaps them. The copy ends exactly on the target, so the hand-over is seamless. It can hold
 * its starting spot for `pace.delay` first, fade in on the way (for parts hidden at the
 * start), fly above or below the burning sheet, and re-wrap a paragraph from the layout of
 * `rewrapFrom` on the way. Resolves with the copy once it has landed.
 */
export function fly(
  path: FlightPath,
  target: HTMLElement,
  layout: HTMLElement,
  pace: { duration: number; delay: number },
  options: { fadeIn: boolean; aboveSheet: boolean; rewrapFrom?: HTMLElement | null },
): Promise<HTMLElement> {
  const { to } = path;
  const flyer = document.createElement("div");
  flyer.setAttribute("aria-hidden", "true");
  Object.assign(flyer.style, {
    position: "fixed",
    left: `${to.left}px`,
    top: `${to.top}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
    transformOrigin: "0 0",
    pointerEvents: "none",
    zIndex: options.aboveSheet ? "6" : "4",
  });
  const copy = target.cloneNode(true) as HTMLElement;
  unmarkFlightTo(copy);
  // Laid out exactly as the original: a flex item is laid out as a block, but a copy on its
  // own would be inline, putting its text on a different baseline and nudging it at the swap.
  const style = getComputedStyle(target);
  Object.assign(copy.style, {
    display: style.display,
    // Inherited text settings (a card's star count takes its monospace font from its parent)
    // are carried over too, or the copy would change font at the swap.
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
    boxSizing: "border-box",
    width: `${to.width}px`,
    height: `${to.height}px`,
    margin: "0",
  });
  flyer.append(copy);
  layout.append(flyer);
  target.style.visibility = "hidden";
  // A paragraph that wraps differently at the two ends re-wraps word by word on the way.
  if (options.rewrapFrom) reflowWords(copy, options.rewrapFrom, path.scale, pace);
  // Stays registered after landing: the copy is only swapped for the real part later, and a
  // quick back in between must still remove it. Removing it twice is harmless.
  onCancel(() => {
    flyer.remove();
    target.style.visibility = "";
  });
  // Holds its starting spot through the delay (fill "backwards"), then flies.
  const flight = flyer.animate(flightKeyframes(path, options.fadeIn), {
    duration: pace.duration,
    delay: pace.delay,
    fill: "backwards",
    easing: FLIGHT_EASING,
  });
  // A cancelled flight rejects `finished`; the cancel handler has already cleaned up.
  return flight.finished.then(
    () => flyer,
    () => flyer,
  );
}
