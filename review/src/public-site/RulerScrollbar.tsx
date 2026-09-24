import { useEffect, useRef, useState } from "react";
import { RULER_WIDTH } from "./frame";
import { type ScrollArea, scrollArea } from "./scroll-area";
import { type ScrollMetrics, scrollPerThumbPixel, scrollToCentre, thumbFor } from "./scroll-thumb";

/** How long the thumb stays after the page stops scrolling, before it fades away. */
const LINGER_MS = 900;

/** The page's scroll, in the terms of the thumb: the visible band against the whole page. */
function metrics(area: ScrollArea): ScrollMetrics {
  const view = area.view().height;
  return { scrollTop: area.top(), clientHeight: view, scrollHeight: view + area.range() };
}

/**
 * The page's scrollbar, drawn on the right ruler line between the header and the footer: the
 * browser's own is hidden. While the page scrolls, a darker stretch of the line shows the
 * visible share of the page and where it is, then fades once the page settles. Dragging it
 * scrolls, and pressing elsewhere on the line jumps there; hovering the line brings it back.
 * Like the browser's own, it is rigid: it never stretches with the page's rubber-band.
 */
export function RulerScrollbar() {
  const [band, setBand] = useState<{ top: number; height: number }>();
  const [thumb, setThumb] = useState<{ top: number; height: number }>();
  const [shown, setShown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const area = useRef<ScrollArea | undefined>(undefined);

  useEffect(() => {
    const found = scrollArea();
    if (!found) return;
    area.current = found;
    let frame = 0;
    let linger = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const view = found.view();
        setBand({ top: view.top, height: view.height });
        setThumb(thumbFor(metrics(found), view.height));
      });
    };
    // Shows the thumb, and keeps it up until scrolling has stopped for a moment. Scrolling on
    // against an end moves nothing and sends no scroll events, so wheel and touch input keeps
    // it up too, for as long as the visitor keeps scrolling.
    const flash = () => {
      setShown(true);
      clearTimeout(linger);
      linger = window.setTimeout(() => setShown(false), LINGER_MS);
    };
    const scrolled = () => {
      update();
      flash();
    };
    update();
    window.addEventListener("scroll", scrolled, { passive: true });
    window.addEventListener("wheel", flash, { passive: true });
    window.addEventListener("touchmove", flash, { passive: true });
    window.addEventListener("resize", update);
    // The page's length changes as routes render and data arrives.
    const resized = new ResizeObserver(update);
    resized.observe(found.content);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(linger);
      window.removeEventListener("scroll", scrolled);
      window.removeEventListener("wheel", flash);
      window.removeEventListener("touchmove", flash);
      window.removeEventListener("resize", update);
      resized.disconnect();
    };
  }, []);

  if (!band || !thumb) return null;

  const press = (event: React.PointerEvent<HTMLDivElement>) => {
    const page = area.current;
    if (!page || event.button !== 0) return;
    event.preventDefault();
    const y = event.clientY - band.top;
    // Pressing off the thumb first jumps it there, centred under the pointer.
    if (y < thumb.top || y > thumb.top + thumb.height)
      page.scrollTo(scrollToCentre(metrics(page), band.height, y));
    const startY = event.clientY;
    const startScroll = page.top();
    const rate = scrollPerThumbPixel(metrics(page), band.height);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (moved: PointerEvent) =>
      page.scrollTo(startScroll + (moved.clientY - startY) * rate);
    const release = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", release);
      target.removeEventListener("pointercancel", release);
      setDragging(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", release);
    target.addEventListener("pointercancel", release);
  };

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed left-1/2 z-10 ${RULER_WIDTH} -translate-x-1/2`}
      style={{ top: band.top, height: band.height }}
    >
      {/*
        A strip a little wider than the line, so it is easy to grab with a pointer. Not on
        touch: there it only shows the page's place, and a finger scrolling near the edge
        must scroll the page, not grab the strip.
      */}
      <div
        onPointerDown={press}
        className="group pointer-events-auto absolute inset-y-0 -right-1.5 w-3 touch-none touch:pointer-events-none"
      >
        <div
          data-shown={shown || dragging || undefined}
          data-dragging={dragging || undefined}
          className="absolute right-1.5 w-px bg-foreground/30 opacity-0 [transition:width_150ms,right_150ms,background-color_150ms,opacity_350ms] group-hover:right-[5px] group-hover:w-[3px] group-hover:bg-foreground/45 group-hover:opacity-100 group-hover:[transition-duration:150ms,150ms,150ms,120ms] data-[dragging]:right-[5px] data-[dragging]:w-[3px] data-[dragging]:bg-foreground/55 data-[shown]:opacity-100 data-[shown]:[transition-duration:150ms,150ms,150ms,120ms]"
          style={{ top: thumb.top, height: thumb.height }}
        />
      </div>
    </div>
  );
}
