import { select } from "./effects/marks";

/**
 * The page's scrolling. The window itself scrolls, with the header and footer pinned over it,
 * so the browser's own scrolling applies in full: on a Mac its rubber-band overscroll, driven
 * by the trackpad's real finger and momentum phases, which no page can reproduce (Chrome only
 * rubber-bands the window's scroll, not a scrolling element inside the page). The content
 * sits in the page between them (`scrollRoot` in marks.ts); what shows of it is the band
 * between the header's bottom edge and the footer's top edge.
 */
export interface ScrollArea {
  /** The page's content (the element marked `scrollRoot`). */
  content: HTMLElement;
  /** The visible band, in viewport coordinates: below the header, above the footer. */
  view(): DOMRect;
  /** How far the page is scrolled, and scrolling it (at once, never smoothly). */
  top(): number;
  scrollTo(top: number): void;
  /** How far the page can scroll. */
  range(): number;
}

function view(): DOMRect {
  const header = document.querySelector(select.siteEdge("top"))?.getBoundingClientRect();
  const footer = document.querySelector(select.siteEdge("bottom"))?.getBoundingClientRect();
  const top = header?.bottom ?? 0;
  // On compact screens the footer is not pinned: it closes the page, and may be off screen.
  const bottom = Math.min(footer?.top ?? window.innerHeight, window.innerHeight);
  return new DOMRect(0, top, document.documentElement.clientWidth, Math.max(0, bottom - top));
}

/** The page's scrolling, or nothing before the layout has rendered. */
export function scrollArea(): ScrollArea | undefined {
  const content = document.querySelector<HTMLElement>(select.scrollRoot);
  if (!content) return undefined;
  const root = document.documentElement;
  return {
    content,
    view,
    top: () => window.scrollY,
    scrollTo: (top) => window.scrollTo({ top, behavior: "instant" }),
    range: () => Math.max(0, root.scrollHeight - root.clientHeight),
  };
}
