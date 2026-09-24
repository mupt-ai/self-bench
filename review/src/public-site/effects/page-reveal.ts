import type { MouseEvent } from "react";
import { canHover } from "../mobile/device";
import { motionOff } from "../motion";
import { scrollArea } from "../scroll-area";
import { assembleForReveal } from "./assemble-reveal";
import { burn } from "./burn";
import { type Box, flightPath, paceFlight, settleTime } from "./flight-path";
import { flightPartOf, holdHover, select } from "./marks";
import { beginWithSheet, fly, inside, measure, union, whenFound } from "./transition-parts";
import { currentTransition, stillRunning } from "./transition-run";

const FLIGHT_MS = 620;
/**
 * How close (in pixels) every flying part must be to its spot before the rest of the page
 * starts assembling. The flight's ease-out spends its last stretch creeping the final few
 * pixels; waiting for all of it leaves a visible pause between the title and the page.
 */
const NEAR_REST_PX = 6;
/** Parts hidden on a hovered card, which fade in as they fly. */
const FADE_IN = new Set(["description", "stars"]);

/** Whether page transitions should play at all. */
export function transitionsOn(): boolean {
  return document.documentElement.dataset.transition !== "none" && !motionOff();
}

/**
 * A plain left click, which the site may take over. Modified clicks (new tab, new window,
 * download) are left to the browser.
 */
export function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Follows a card link with the opening transition (see `openFromCard`). Plain navigation is
 * kept for modified clicks and when transitions are off.
 */
export function revealNavigate(event: MouseEvent<HTMLElement>, go: () => void): void {
  if (event.defaultPrevented || !plainClick(event)) return;
  if (!transitionsOn() || !scrollArea()) return;
  event.preventDefault();
  openFromCard(event.currentTarget, go);
}

/**
 * Opens a repository page from the home page, in three beats:
 *
 * 1. The home page is frozen as a sheet of paper over the new page and burns away outwards
 *    from the card (or from the top, without one). Through the holes there is only the
 *    background water for now.
 * 2. The card's logo, name, stars, and description fly to their places on the new page and
 *    grow into them (parts marked `flightFrom` land on the matching `flightTo`; see marks.ts).
 *    They fly beneath the burning sheet, paced so they only ever cross burned-through paper.
 *    Each flying piece is a copy of its landing spot, so the hand-over at the end is exact.
 * 3. As they come to rest (within a few pixels), the rest of the page is assembled below the
 *    title: a ragged frontier creeps down and each block of the page clicks into place.
 *
 * `go` performs the navigation; for history navigation it is already under way and `go`
 * does nothing.
 */
export function openFromCard(card: HTMLElement | null, go: () => void): void {
  const area = scrollArea();
  const layout = area?.content.parentElement;
  if (!area || !layout) {
    go();
    return;
  }
  const sources = new Map(
    [...(card?.querySelectorAll<HTMLElement>(select.flightFrom()) ?? [])].map((source) => [
      flightPartOf(source),
      source,
    ]),
  );
  // The frozen copy keeps the card in its hover look (card-on in theme.css) rather than snapping
  // back, if it showed it: under a mouse, or focused from the keyboard. A tapped card never did
  // (and :hover stays stuck on after a tap), so it is left as it was.
  const shown =
    card !== null && ((canHover() && card.matches(":hover")) || card.matches(":focus-visible"));
  if (card && shown) holdHover(card, true);
  const sheet = beginWithSheet(area, layout);
  const run = currentTransition();
  if (card && shown) holdHover(card, false);
  const frame = area.view();
  // The title lands near the top left of the content column; the fire leans that way.
  const column = area.content.querySelector("main")?.getBoundingClientRect() ?? frame;
  const toward = { x: column.left - frame.left + 180, y: 60 };
  const start = card?.getBoundingClientRect() ?? {
    left: frame.left + frame.width / 2,
    top: frame.top,
    width: 0,
    height: 0,
  };
  const { clearedAt } = burn(sheet, inside(frame, start), { toward });
  const burnStart = performance.now();
  const from = new Map([...sources].map(([key, source]) => [key, measure(source)]));

  // Hidden until the title lands, then assembled block by block below it.
  const content = area.content.querySelector("main");
  const hidden = content ? assembleForReveal(content, area) : undefined;
  go();
  area.scrollTo(0);
  whenFound(
    [...sources.keys()],
    (key) => area.content.querySelector<HTMLElement>(select.flightTo(key)),
    (targets) => {
      // The sheet's copies of the flying parts give way to the flyers.
      for (const key of targets.keys())
        for (const copy of sheet.querySelectorAll<HTMLElement>(select.flightFrom(key)))
          copy.style.visibility = "hidden";
      const paths = new Map(
        [...targets].flatMap(([key, target]) => {
          const origin = from.get(key);
          return origin ? [[key, flightPath(origin, target, key === "avatar")] as const] : [];
        }),
      );
      const now = performance.now() - burnStart;
      const clearedIn = (box: Box) => clearedAt(inside(frame, box)) - now;
      const pace = paceFlight([...paths.values()], clearedIn, FLIGHT_MS);
      const clears = targets.size ? clearedIn(union([...targets.values()])) : 0;
      const landed = Promise.all(
        [...targets].map(([key, target]) => {
          const path = paths.get(key);
          return path
            ? fly(path, target, layout, pace, {
                // Parts the hover look hides fade in on the way; a tapped card never hid them.
                fadeIn: shown && FADE_IN.has(key),
                aboveSheet: false,
                rewrapFrom:
                  key === "description"
                    ? sheet.querySelector<HTMLElement>(select.flightFrom(key))
                    : null,
              })
            : Promise.resolve(undefined);
        }),
      );
      // The rest of the page starts as the title comes to rest (within a few pixels of its
      // spot), worked out from the flight itself, and never before the fire has cleared the
      // title area.
      const rests = pace.delay + settleTime([...paths.values()], NEAR_REST_PX) * pace.duration;
      let started = () => {};
      const revealStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      setTimeout(
        () => {
          if (!stillRunning(run)) return;
          // Assembly starts under the title block, which is already in place, and under any
          // lines marked to fade in rather than assemble.
          const faded = [...area.content.querySelectorAll(select.revealFade)];
          const below = Math.max(
            frame.top,
            ...[...targets.values(), ...faded].map((part) => part.getBoundingClientRect().bottom),
          );
          hidden?.reveal(below + 4);
          started();
        },
        targets.size ? Math.max(rests, clears) : 0,
      );
      // Each flyer gives way to the real title the moment it lands (once the reveal has
      // opened the title area), so the browser never redraws a resting flyer and nudges it.
      Promise.all([landed, revealStarted]).then(([flyers]) => {
        for (const target of targets.values()) target.style.visibility = "";
        for (const flyer of flyers) flyer?.remove();
      });
    },
    // The title's parts render together: once its name is there, whatever is missing (a
    // repository with no description) is not coming.
    sources.has("name") ? ["name"] : [],
  );
}
