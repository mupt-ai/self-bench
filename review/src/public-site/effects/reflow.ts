/**
 * Smooth re-wrapping for a flying paragraph (the description). A paragraph wraps differently
 * on the card and on the repository page, so a copy laid out for one end jumps at the other.
 * Instead the paragraph re-wraps early in the flight: words that stay on their line slide along
 * it, and words that move to another line (or are clipped by the line clamp at one end) fade
 * out where they were and fade in where they land, so no word travels across another. Just
 * before landing the words swap for the exact copy underneath, so the final swap is unchanged.
 */

/** Share of the flight over which words find their new lines. */
export const REWRAP_SHARE = 0.55;
/** Share of the flight at which the words hand over to the exact copy (settled by then). */
const HANDOVER_AT = 0.88;

interface Word {
  text: string;
  x: number;
  y: number;
  shown: boolean;
}

/** Each word of `element`'s text with its offset from the element's top-left corner. */
function wordsOf(element: HTMLElement): Word[] {
  const box = element.getBoundingClientRect();
  const words: Word[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const match of text.matchAll(/\S+/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      words.push({
        text: match[0],
        x: rect.left - box.left,
        y: rect.top - box.top,
        // A clamped paragraph still lays out its hidden lines, below its visible box.
        shown: rect.width > 0 && rect.bottom <= box.bottom + 1,
      });
    }
  }
  return words;
}

/**
 * Lays moving words over `copy` (an exact copy of the landing paragraph, inside a flyer that
 * starts scaled by `scale`), moving from where the words sit in `source`, and hides the copy
 * until the handover. `timing` is the flight's.
 */
export function reflowWords(
  copy: HTMLElement,
  source: HTMLElement,
  scale: number,
  timing: { duration: number; delay: number },
): void {
  const from = wordsOf(source);
  const to = wordsOf(copy);
  if (!from.length || from.length !== to.length) return;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  const style = getComputedStyle(copy);
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    font: style.font,
    color: style.color,
    // Word boxes are measured by their glyphs, so the words are set without extra leading.
    lineHeight: "normal",
    letterSpacing: style.letterSpacing,
    whiteSpace: "pre",
  });
  // The words' lines at each end, by their vertical position.
  const lineOf = (words: Word[]) => {
    const tops = [...new Set(words.map((word) => Math.round(word.y)))].sort((a, b) => a - b);
    return (word: Word) => tops.findIndex((top) => Math.abs(top - Math.round(word.y)) <= 2);
  };
  const fromLine = lineOf(from);
  const toLine = lineOf(to);
  const rewrapMs = timing.duration * REWRAP_SHARE;
  const phase = (start: number, end: number, easing = "ease-in-out") => ({
    delay: timing.delay + rewrapMs * start,
    duration: rewrapMs * (end - start),
    easing,
    fill: "both" as const,
  });
  const place = (text: string, x: number, y: number) => {
    const span = document.createElement("span");
    span.textContent = text;
    Object.assign(span.style, { position: "absolute", left: `${x}px`, top: `${y}px` });
    layer.append(span);
    return span;
  };
  for (const [index, word] of to.entries()) {
    const start = from[index];
    if (!start || (!start.shown && !word.shown)) continue;
    // Its old spot, in the flyer's unscaled space: the flyer starts scaled by `scale`.
    const oldX = start.x / scale;
    const oldY = start.y / scale;
    if (start.shown && word.shown && fromLine(start) === toLine(word)) {
      // Staying on its line: it slides along it, which never crosses another word. It waits
      // a moment first, so the words leaving the line are mostly gone before it arrives.
      place(word.text, word.x, word.y).animate(
        [{ transform: `translate(${oldX - word.x}px, ${oldY - word.y}px)` }, { transform: "none" }],
        phase(0.2, 1),
      );
      continue;
    }
    // Changing lines (or being clipped at one end): it fades out where it was and fades in
    // where it lands, instead of travelling across the paragraph.
    if (start.shown)
      place(word.text, oldX, oldY).animate(
        [{ opacity: 1 }, { opacity: 0 }],
        phase(0, 0.35, "ease-out"),
      );
    if (word.shown)
      place(word.text, word.x, word.y).animate(
        [{ opacity: 0 }, { opacity: 1 }],
        phase(0.4, 1, "ease-in"),
      );
  }
  copy.parentElement?.append(layer);
  // By now the words sit exactly on the copy, so they swap in a single frame. A cross-fade
  // would dip: two layers at half opacity add up to less than one, and the text would flicker.
  const handover = {
    duration: 0,
    delay: timing.delay + timing.duration * HANDOVER_AT,
    fill: "both" as const,
  };
  copy.animate([{ opacity: 0 }, { opacity: 1 }], handover);
  layer.animate([{ opacity: 1 }, { opacity: 0 }], handover);
}
