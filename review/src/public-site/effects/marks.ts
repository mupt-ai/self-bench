/**
 * The attributes the page marks itself with so the effects can find their parts. Markup
 * spreads the helpers (`<span {...flightFrom("name")}>`); effects use the matching selectors.
 * Keeping both sides here makes the coupling explicit: rename a mark here and both follow.
 *
 * theme.css also reads `data-active` in its `card-on` variant; keep the two in step.
 */

/** Card parts that fly to the repository page when their card is clicked. */
export type FlightPart = "avatar" | "name" | "stars" | "description";

const SCROLL_ROOT = "data-scroll-root";
const CARD = "data-card";
const CARD_LINE = "data-card-line";
const LINE = "data-line";
const ACTIVE = "data-active";
const FLIGHT = "data-flight";
const FLIGHT_TARGET = "data-flight-target";
const REVEAL = "data-reveal";

/** The page's scrolling area; the transition freezes and burns a copy of it. */
export const scrollRoot = { [SCROLL_ROOT]: "" };
/**
 * A repository card; the cursor aura wakes over it. It names its repository ("owner/name")
 * and the run it shows ("owner/name/publisher"), so a title can fly back to it.
 */
export const repoCard = (repository: string, line: string) => ({
  [CARD]: repository,
  [CARD_LINE]: line,
});
/** The run a repository page is showing ("owner/name/publisher"). */
export const shownLine = (line: string) => ({ [LINE]: line });
/** A card part that flies to the repository page when its card is clicked. */
export const flightFrom = (part: FlightPart) => ({ [FLIGHT]: part });
/** Where that part lands on the repository page. */
export const flightTo = (part: FlightPart) => ({ [FLIGHT_TARGET]: part });
/** A line that fades in whole during the page reveal instead of being assembled. */
export const revealFade = { [REVEAL]: "fade" };

export const select = {
  scrollRoot: `[${SCROLL_ROOT}]`,
  card: `[${CARD}]`,
  /** A card for this run if there is one, else any card for its repository. */
  cardFor: (root: ParentNode, line: string) =>
    root.querySelector<HTMLElement>(`[${CARD_LINE}="${line}"]`) ??
    root.querySelector<HTMLElement>(`[${CARD}="${line.split("/").slice(0, 2).join("/")}"]`),
  shownLine: `[${LINE}]`,
  flightFrom: (part?: string) => (part ? `[${FLIGHT}="${part}"]` : `[${FLIGHT}]`),
  flightTo: (part: string) => `[${FLIGHT_TARGET}="${part}"]`,
  revealFade: `[${REVEAL}="fade"]`,
};

/** The run a repository page element is showing. */
export const lineOf = (element: Element) => element.getAttribute(LINE) ?? "";
/** Marks an element (on a frozen copy) to fade out whole rather than come apart. */
export const markFade = (element: Element) => element.setAttribute(REVEAL, "fade");
/** Which part a flying element is. */
export const flightPartOf = (element: Element) => element.getAttribute(FLIGHT) ?? "";
/** Strips the landing mark from a copy, so it is not mistaken for the real landing spot. */
export const unmarkFlightTo = (element: Element) => element.removeAttribute(FLIGHT_TARGET);
/** Holds a card in its hover state (see theme.css `card-on`), or lets it go. */
export const holdHover = (element: Element, held: boolean) =>
  held ? element.setAttribute(ACTIVE, "") : element.removeAttribute(ACTIVE);
