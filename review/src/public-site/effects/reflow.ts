/**
 * Smooth re-wrapping for a flying paragraph (the description). A paragraph wraps differently
 * on the card and on the repository page, so a copy laid out for one end jumps at the other.
 * Instead the paragraph re-wraps early in the flight: words that stay on their line slide along
 * it, and words that move to another line (or are clipped by the line clamp at one end) fade
 * out where they were and fade in where they land, so no word travels across another. A
 * clamped end shows its ellipsis throughout, exactly where the browser draws it. Once the
 * words have settled they swap for the exact copy underneath, so the final swap is unchanged.
 */

/** Share of the flight over which words find their new lines; they swap for the copy then. */
export const REWRAP_SHARE = 0.38;
const ELLIPSIS = "\u2026";

interface Word {
  text: string;
  x: number;
  y: number;
  shown: boolean;
}

interface Layout {
  words: Word[];
  /** Where a line-clamped paragraph draws its ellipsis. */
  ellipsis?: { x: number; y: number };
}

/**
 * Each word of `element`'s text with its offset from the element's top-left corner, as the
 * browser draws it: a line-clamped paragraph cuts its last shown line back, character by
 * character (spaces included), until an ellipsis fits after it.
 */
function layoutOf(element: HTMLElement): Layout {
  const box = element.getBoundingClientRect();
  const words: Word[] = [];
  const spots: { node: Node; start: number; end: number }[] = [];
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
      spots.push({ node, start: match.index, end: match.index + match[0].length });
    }
  }
  const last = words.findLastIndex((word) => word.shown);
  const lastWord = words[last];
  const lastSpot = spots[last];
  if (!lastWord || !lastSpot || last === words.length - 1) return { words };

  // The last shown line, within the same text node.
  let lineStart = lastSpot.start;
  for (let index = last - 1; index >= 0; index--) {
    const word = words[index];
    const spot = spots[index];
    if (!word || !spot || spot.node !== lastSpot.node || Math.abs(word.y - lastWord.y) > 2) break;
    lineStart = spot.start;
  }
  const style = getComputedStyle(element);
  const right =
    box.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return { words };
  context.font = style.font;
  if (style.letterSpacing !== "normal") context.letterSpacing = style.letterSpacing;
  const ellipsisWidth = context.measureText(ELLIPSIS).width;
  const rightOf = (end: number) => {
    range.setStart(lastSpot.node, lineStart);
    range.setEnd(lastSpot.node, end);
    return range.getBoundingClientRect().right;
  };
  let end = lastSpot.end;
  while (end > lineStart && rightOf(end) + ellipsisWidth > right + 0.01) end--;
  // The cut takes characters off the last words, or whole words.
  for (let index = last; index >= 0; index--) {
    const word = words[index];
    const spot = spots[index];
    if (!word || !spot || spot.node !== lastSpot.node || spot.start < lineStart) break;
    if (spot.start >= end) word.shown = false;
    else if (spot.end > end) word.text = word.text.slice(0, end - spot.start);
  }
  return { words, ellipsis: { x: rightOf(end) - box.left, y: lastWord.y } };
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
  const from = layoutOf(source);
  const to = layoutOf(copy);
  if (!from.words.length || from.words.length !== to.words.length) return;
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
    return (word: { y: number }) =>
      tops.findIndex((top) => Math.abs(top - Math.round(word.y)) <= 2);
  };
  const fromLine = lineOf(from.words);
  const toLine = lineOf(to.words);
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
  // One piece of text (a word, or the ellipsis) from its spot at the start to its spot at the
  // end; either side may be missing (clipped by the line clamp).
  const move = (
    start: { text: string; x: number; y: number } | undefined,
    end: { text: string; x: number; y: number } | undefined,
  ) => {
    if (start && end && start.text === end.text && fromLine(start) === toLine(end)) {
      // Staying on its line: it slides along it, which never crosses another word. It waits
      // a moment first, so the words leaving the line are mostly gone before it arrives.
      // Its old spot is in the flyer's unscaled space: the flyer starts scaled by `scale`.
      place(end.text, end.x, end.y).animate(
        [
          { transform: `translate(${start.x / scale - end.x}px, ${start.y / scale - end.y}px)` },
          { transform: "none" },
        ],
        phase(0.15, 1),
      );
      return;
    }
    // Changing lines (or being clipped at one end): it fades out where it was and fades in
    // where it lands, instead of travelling across the paragraph.
    if (start)
      place(start.text, start.x / scale, start.y / scale).animate(
        [{ opacity: 1 }, { opacity: 0 }],
        phase(0, 0.32, "ease-out"),
      );
    if (end)
      place(end.text, end.x, end.y).animate(
        [{ opacity: 0 }, { opacity: 1 }],
        phase(0.36, 1, "ease-in"),
      );
  };
  for (const [index, word] of to.words.entries()) {
    const start = from.words[index];
    move(start?.shown ? start : undefined, word.shown ? word : undefined);
  }
  const ellipsis = (spot: Layout["ellipsis"]) => spot && { text: ELLIPSIS, ...spot };
  move(ellipsis(from.ellipsis), ellipsis(to.ellipsis));
  copy.parentElement?.append(layer);
  // Once the words have settled they sit exactly on the copy, so they swap in a single frame.
  // A cross-fade would dip: two layers at half opacity add up to less than one, and the text
  // would flicker.
  const handover = { duration: 0, delay: timing.delay + rewrapMs, fill: "both" as const };
  copy.animate([{ opacity: 0 }, { opacity: 1 }], handover);
  layer.animate([{ opacity: 1 }, { opacity: 0 }], handover);
}
