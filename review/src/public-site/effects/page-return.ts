import { scrollArea } from "../scroll-area";
import { burn } from "./burn";
import { disassemble } from "./disassemble";
import {
  type Box,
  boxAtTime,
  type FlightPath,
  fireStartAfter,
  flightPath,
  settleTime,
} from "./flight-path";
import { type FlightPart, markFade, select } from "./marks";
import { transitionsOn } from "./page-reveal";
import { REWRAP_SHARE } from "./reflow";
import { beginWithSheet, fly, inside, measure, union } from "./transition-parts";
import { currentTransition, onCancel, stillRunning } from "./transition-run";

/** The return runs quicker than the opening: leaving should feel lighter than arriving. */
const FLIGHT_MS = 480;
const BURN_MS = 800;
const PARTS: FlightPart[] = ["avatar", "name", "stars", "description"];
/**
 * The parts that fly back. The description does not: squeezing a wide paragraph into the
 * card's narrow one cannot look smooth, so it fades with the page and fades back in whole in
 * the card as the title comes to rest.
 */
const FLYING: FlightPart[] = ["avatar", "name", "stars"];
/** When the fire starts without a flight to stay ahead of, once the page is coming apart. */
const BURN_AFTER_MS = 120;
/** When the title lifts off, once the page below it has visibly started coming apart. */
const LIFT_AFTER_MS = 90;
/** Margin, a frame, between the title passing a spot and the fire touching it. */
const LEAD_MS = 16;
/** The "Run by" line's fade out: this long normally, never shorter than the minimum. */
const FADE_MS = 200;
const MIN_FADE_MS = 60;

/** How long the returning description takes to fade in. */
const DESCRIPTION_FADE_MS = 240;

/** Fades a hidden element in whole, then drops the styles used to do it. */
function fadeIn(element: HTMLElement) {
  element.style.opacity = "0";
  element.style.visibility = "";
  // Register the transparent state before animating away from it.
  void element.offsetHeight;
  element.style.transition = `opacity ${DESCRIPTION_FADE_MS}ms ease-out`;
  element.style.opacity = "1";
  const settle = () => {
    element.style.removeProperty("opacity");
    element.style.removeProperty("transition");
  };
  const undo = onCancel(settle);
  setTimeout(() => {
    settle();
    undo();
  }, DESCRIPTION_FADE_MS + 20);
}

/** Where the visible text of an element is (its glyphs, not its layout box). */
function textBox(element: Element): Box {
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = range.getBoundingClientRect();
  const box = text.width ? text : element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

/** Where `inner` sits within `outer`, as fractions of `outer`'s size. */
function share(inner: Box, outer: Box) {
  return {
    x: (inner.left - outer.left) / (outer.width || 1),
    y: (inner.top - outer.top) / (outer.height || 1),
    w: inner.width / (outer.width || 1),
    h: inner.height / (outer.height || 1),
  };
}

interface TextMove {
  path: FlightPath;
  /** The visible text's place within the flying box at the start and at the end. */
  from: ReturnType<typeof share>;
  to: ReturnType<typeof share>;
}

/**
 * When (from the flight's schedule) the visible text of any flying part first overlaps `box`,
 * or never. The text rides the real flight path, moving within its box from where it sits
 * on the page to where it sits on the card (over the first `REWRAP_SHARE` of the flight), so
 * the "Run by" line and the description can be gone before the title's text reaches them.
 */
function firstOverlap(moves: TextMove[], box: Box, pace: { duration: number; delay: number }) {
  let first = Number.POSITIVE_INFINITY;
  for (const { path, from, to } of moves)
    for (let step = 0; step <= 200; step++) {
      const u = step / 200;
      const flying = boxAtTime(path, u);
      const k = Math.min(1, u / REWRAP_SHARE);
      const mix = (key: "x" | "y" | "w" | "h") => from[key] + (to[key] - from[key]) * k;
      const at = {
        left: flying.left + mix("x") * flying.width,
        top: flying.top + mix("y") * flying.height,
        width: mix("w") * flying.width,
        height: mix("h") * flying.height,
      };
      const overlaps =
        at.left < box.left + box.width &&
        at.left + at.width > box.left &&
        at.top < box.top + box.height &&
        at.top + at.height > box.top;
      if (overlaps) first = Math.min(first, pace.delay + u * pace.duration);
    }
  return first;
}
/** How long to wait for the home page to render. */
const WAIT_MS = 600;

/**
 * Leaves a repository page for the home page: the opening transition in reverse. `line` is
 * the run the page was showing ("owner/name/publisher"); `go` performs the navigation (for
 * history navigation it is already under way and does nothing).
 *
 * The repository page is frozen as a sheet of paper, and the home page renders underneath,
 * already scrolled to where the visitor left it. Then, if that repository's card has its
 * title row on screen, the full version plays: the page comes apart from the bottom up, and
 * the title lifts off and flies back into the card, which dissolves into view through the
 * paper. The paper burns from the far edges in toward the card, started exactly late enough
 * that the fire never reaches a spot before the title has passed it: the title leads, the
 * fire follows it in. Otherwise the page comes apart entirely and the paper burns outwards
 * from where the title was.
 */
export function returnHome(line: string, go: () => void): void {
  const area = scrollArea();
  const layout = area?.content.parentElement;
  if (!transitionsOn() || !area || !layout) {
    go();
    return;
  }
  const scroller = area.content;
  const frame = area.view();
  const title = new Map(
    PARTS.flatMap((part) => {
      const element = scroller.querySelector<HTMLElement>(select.flightTo(part));
      return element ? [[part, { ...measure(element), text: textBox(element) }] as const] : [];
    }),
  );
  const description = scroller.querySelector(select.flightTo("description"));
  const faded = [
    ...scroller.querySelectorAll(select.revealFade),
    ...(description ? [description] : []),
  ];
  const fadedBox = faded.length ? union(faded) : undefined;
  const titleBlock = [
    ...PARTS.flatMap((part) => scroller.querySelector(select.flightTo(part)) ?? []),
  ];
  const titleBox = titleBlock.length ? union(titleBlock) : undefined;
  const keepLine = Math.max(
    frame.top,
    ...[...titleBlock, ...faded].map((element) => element.getBoundingClientRect().bottom),
  );
  const sheet = beginWithSheet(area, layout);
  const run = currentTransition();
  go();

  // Waits for the home page (any card, or nothing after a while), then picks a version.
  const begin = performance.now();
  const wait = () => {
    if (!stillRunning(run)) return;
    const card = select.cardFor(scroller, line);
    const homeShown = card || scroller.querySelector(select.card);
    if (!homeShown && performance.now() - begin < WAIT_MS) {
      requestAnimationFrame(wait);
      return;
    }
    // The title flies back when its landing row on the card is on screen, even if the rest of
    // the card runs off the edge: that row is all it needs to land in view.
    const row = card
      ? FLYING.flatMap((part) => card.querySelector(select.flightFrom(part)) ?? [])
      : [];
    const landing = row.length ? union(row) : undefined;
    const onScreen =
      landing && landing.top >= frame.top && landing.top + landing.height <= frame.bottom;
    if (card && onScreen && title.size) returnToCard(card);
    else fallApart();
  };
  requestAnimationFrame(wait);

  function fallApart() {
    disassemble(sheet, frame.top);
    const origin = titleBox ?? { left: frame.left, top: frame.top, width: frame.width, height: 0 };
    setTimeout(() => {
      if (stillRunning(run)) burn(sheet, inside(frame, origin), { duration: BURN_MS });
    }, BURN_AFTER_MS);
  }

  function returnToCard(card: HTMLElement) {
    const targets = new Map(
      FLYING.flatMap((part) => {
        const element = card.querySelector<HTMLElement>(select.flightFrom(part));
        return element && title.has(part) ? [[part, element] as const] : [];
      }),
    );
    const paths = new Map(
      [...targets].flatMap(([part, target]) => {
        const start = title.get(part);
        return start ? [[part, flightPath(start, target, part === "avatar")] as const] : [];
      }),
    );
    // The card shows through the paper from the start: the fire converges on its edges and
    // never scorches it.
    const cardArea = inside(frame, card.getBoundingClientRect());
    const fire = burn(sheet, cardArea, {
      inward: true,
      keepClear: cardArea,
      duration: BURN_MS,
      hold: true,
    });
    // "Run by" fades out before any flying part reaches it; if that leaves too little time for
    // a visible fade, the title waits on the page the few milliseconds needed.
    const flights = [...paths.values()];
    const planned = { duration: FLIGHT_MS, delay: LIFT_AFTER_MS };
    const moves = [...paths].flatMap(([part, path]) => {
      const start = title.get(part)?.text;
      const target = targets.get(part);
      if (!start || !target) return [];
      return [
        {
          path,
          from: share(start, boxAtTime(path, 0)),
          to: share(textBox(target), boxAtTime(path, 1)),
        },
      ];
    });
    const reaches = fadedBox ? firstOverlap(moves, fadedBox, planned) : Number.POSITIVE_INFINITY;
    const room = reaches - LEAD_MS;
    const pace = { ...planned, delay: planned.delay + Math.max(0, MIN_FADE_MS - room) };
    // The page's description fades out with "Run by"; the card's stays hidden until typed out.
    const leaving = sheet.querySelector(select.flightTo("description"));
    if (leaving) markFade(leaving);
    const arriving = card.querySelector<HTMLElement>(select.flightFrom("description"));
    if (arriving) arriving.style.visibility = "hidden";
    const shown = onCancel(() => {
      if (arriving) arriving.style.visibility = "";
    });
    disassemble(sheet, keepLine, Math.max(MIN_FADE_MS, Math.min(FADE_MS, room)));
    const touchedIn = (box: Box) => fire.touchedAt(inside(frame, box));
    // Drawing starts now, so the paper over the card dissolves at once; the fire itself starts
    // exactly late enough that it never reaches a spot before the title has passed it.
    fire.start(fireStartAfter(flights, touchedIn, pace) + LEAD_MS);

    for (const part of targets.keys())
      for (const copy of sheet.querySelectorAll<HTMLElement>(select.flightTo(part)))
        copy.style.visibility = "hidden";
    const landed = Promise.all(
      [...targets].map(([part, target]) => {
        const path = paths.get(part);
        // Above the paper: the title is leaving the page being burned, not arriving under it.
        return path
          ? fly(path, target, layout as HTMLElement, pace, { fadeIn: false, aboveSheet: true })
          : Promise.resolve(undefined);
      }),
    );
    // The card is uncovered all along, so each copy gives way to the real part as it lands.
    landed.then((flyers) => {
      if (!stillRunning(run)) return;
      for (const target of targets.values()) target.style.visibility = "";
      for (const flyer of flyers) flyer?.remove();
    });
    // The description fades in whole, starting the instant the title comes to rest above it. It
    // is the real paragraph (no copy laid over the page), so it sits under the footer's fog and
    // fades with the card's hover preview like the rest of the card.
    const rests = pace.delay + settleTime(flights) * pace.duration;
    setTimeout(() => {
      if (!stillRunning(run)) return;
      shown();
      if (arriving) fadeIn(arriving);
    }, rests);
  }
}
