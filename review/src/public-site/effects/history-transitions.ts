import { repositoryOf, saveHomeNow } from "../home-view";
import { touchInput } from "../mobile/device";
import { scrollArea } from "../scroll-area";
import { lineOf, select } from "./marks";
import { returnHome } from "./page-return";
import { openFromCard, transitionsOn } from "./page-reveal";

/** The path the page is showing, kept current by the layout (`notePath`). */
let shown = typeof window === "undefined" ? "/" : window.location.pathname;

export function notePath(path: string): void {
  shown = path;
}

/**
 * Plays page transitions for the browser's back and forward buttons. Only two kinds of step
 * animate: a repository page back to the home page (the return), and the home page forward to
 * a repository page (the opening, from its card if on screen). Steps between repository pages
 * stay instant.
 *
 * Must be installed before the router, so it runs while the old page is still on screen: it
 * freezes a copy of that page before React replaces it.
 *
 * Touch screens are left alone: their back and forward are gestures (a swipe from the edge)
 * that animate the change themselves, and a transition after one would play it twice.
 */
export function installHistoryTransitions(): void {
  window.addEventListener("popstate", () => {
    const from = shown;
    const to = window.location.pathname;
    shown = to;
    const area = scrollArea();
    if (!area) return;
    const repository = repositoryOf(to);
    // Records where the home page was before leaving it, with or without a transition.
    if (from === "/" && repository) saveHomeNow(repository);
    if (touchInput()) return;
    const scroller = area.content;
    if (repositoryOf(from) && to === "/") {
      const line = lineOf(scroller.querySelector(select.shownLine) ?? scroller);
      returnHome(line, () => {});
      return;
    }
    if (from === "/" && repository) {
      if (!transitionsOn()) return;
      const card = select.cardFor(scroller, to.split("/").filter(Boolean).join("/"));
      const rect = card?.getBoundingClientRect();
      const frame = area.view();
      const onScreen = rect && rect.top >= frame.top && rect.bottom <= frame.bottom;
      openFromCard(card && onScreen ? card : null, () => {});
    }
  });
}
