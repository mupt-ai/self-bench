import { type RefObject, useEffect, useRef } from "react";
import { motionOff } from "../motion";
import {
  type RunningWater,
  runWater,
  type Water,
  type WaterReply,
  type WaterState,
} from "./water-paint";

const MODES: Record<string, number> = { out: 0, in: 1, rain: 2 };

/**
 * What the page asks of the water, read from the root element: `data-water` picks the mode
 * (out, in, rain, or off); `--ripple` is the dot colour, `--ripple-strength` its opacity,
 * `--ripple-coverage` scales how much of each wave draws dots, and `--ripple-speed` how fast
 * the water moves.
 */
function readWater(root: HTMLElement): Water {
  const style = getComputedStyle(root);
  const [red = 0, green = 0, blue = 0] = style
    .getPropertyValue("--ripple")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const strength = Number.parseFloat(style.getPropertyValue("--ripple-strength"));
  const coverage = Number.parseFloat(style.getPropertyValue("--ripple-coverage"));
  const speed = Number.parseFloat(style.getPropertyValue("--ripple-speed"));
  const choice = root.dataset.water ?? "out";
  return {
    tint: [red / 255, green / 255, blue / 255],
    strength: Number.isFinite(strength) ? strength : 0.3,
    coverage: Number.isFinite(coverage) ? coverage : 1,
    speed: Number.isFinite(speed) ? speed : 1,
    // Off by choice, from the widgets: no water at all.
    mode: choice === "off" ? undefined : (MODES[choice] ?? 0),
  };
}

/** The water is drawn at half the window's resolution: it is grain, not detail. */
const SCALE = 0.5;

/** What the water needs from the page now. */
function stateOf(canvas: HTMLCanvasElement): WaterState {
  return {
    water: readWater(document.documentElement),
    still: motionOff(),
    hidden: document.hidden,
    width: Math.floor(canvas.clientWidth * SCALE),
    height: Math.floor(canvas.clientHeight * SCALE),
  };
}

/** Runs `start` once the browser is idle after the first render, or soon after where it cannot say. */
function whenIdle(start: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(start, { timeout: 1500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(start, 250);
  return () => clearTimeout(id);
}

/**
 * Starts the water on a worker, so the GPU context's slow start and every frame stay off the
 * main thread, and calls `ready` with it. Where the browser cannot hand a worker its canvases,
 * or the worker cannot draw WebGL on them, it runs here instead. Returns how to stop it.
 */
function startWater(
  canvas: HTMLCanvasElement,
  bands: HTMLCanvasElement | null,
  shown: () => void,
  ready: (water: RunningWater) => void,
): () => void {
  const here = () => {
    const water = runWater(canvas, bands, shown);
    if (water) ready(water);
    return () => water?.stop();
  };
  if (typeof Worker !== "function" || !("transferControlToOffscreen" in canvas)) return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./water.worker.ts", import.meta.url), { type: "module" });
  } catch {
    // Browsers without module workers.
    return here();
  }
  let stop = () => worker.terminate();
  const fallBack = () => {
    worker.terminate();
    stop = here();
  };
  // Until the canvases are handed over, the water can still start here instead.
  worker.onerror = fallBack;
  worker.onmessage = ({ data }: MessageEvent<WaterReply>) => {
    if (data === "shown") shown();
    if (data === "no-webgl") fallBack();
    if (data !== "webgl") return;
    worker.onerror = null;
    try {
      const offscreen = canvas.transferControlToOffscreen();
      const offscreenBands = bands?.transferControlToOffscreen() ?? null;
      worker.postMessage(
        { canvas: offscreen, bands: offscreenBands },
        offscreenBands ? [offscreen, offscreenBands] : [offscreen],
      );
    } catch {
      // Already handed over, when the dev server reloads this component in place: no water.
      worker.terminate();
      return;
    }
    ready({ update: (state) => worker.postMessage({ state }), stop: () => worker.terminate() });
  };
  return () => stop();
}

/** Keeps `water` in step with the page: its look, less motion, visibility, and size. */
function follow(water: RunningWater, canvas: HTMLCanvasElement): () => void {
  const update = () => water.update(stateOf(canvas));
  update();
  // Theme, palette, and mode changes all land on the root element's attributes.
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-water", "style"],
  });
  const lessMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  lessMotion.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  // A still frame (less motion) is redrawn on resize, or it would stretch.
  window.addEventListener("resize", update);
  return () => {
    observer.disconnect();
    lessMotion.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("resize", update);
  };
}

/** Hidden until the first frame is drawn (`data-shown`), then faded in; at once for less motion. */
const FADE_IN =
  "opacity-0 transition-opacity duration-700 motion-reduce:transition-none data-[shown]:opacity-100";

/**
 * Faint water behind the page. Rendered at half resolution, paused when the tab is hidden,
 * and drawn once, still, for visitors who prefer less motion. It starts once the page is up
 * and the browser is idle, on a worker where it can, and fades in: a GPU context is slow to
 * start, and would otherwise hold back the page. `bands` is the canvas over the pinned header
 * and footer (`WaterBands`), which gets a copy of every frame.
 */
export function WaterBackground({ bands }: { bands?: RefObject<HTMLCanvasElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const band = bands?.current ?? null;
    if (!element) return;
    const shown = () => {
      element.dataset.shown = "";
      if (band) band.dataset.shown = "";
    };
    let stop = () => {};
    let unfollow = () => {};
    const cancel = whenIdle(() => {
      stop = startWater(element, band, shown, (water) => {
        unfollow = follow(water, element);
      });
    });
    return () => {
      cancel();
      stop();
      unfollow();
    };
  }, [bands]);
  return (
    <canvas
      ref={canvas}
      className={`pointer-events-none fixed inset-0 -z-10 h-full w-full ${FADE_IN}`}
    />
  );
}

/**
 * The water again, over the pinned header and footer, whose solid backgrounds hide the canvas
 * behind the page: a canvas masked to those two strips, which `WaterBackground` copies each
 * frame into, so the water runs on unbroken behind them. Place it where it should stack.
 */
export function WaterBands({ ref }: { ref: RefObject<HTMLCanvasElement | null> }) {
  return (
    <canvas
      ref={ref}
      className={`pointer-events-none fixed inset-0 z-[7] h-full w-full [mask-image:linear-gradient(black_0_var(--bar-top),transparent_var(--bar-top)_calc(100%-var(--bar-bottom)),black_calc(100%-var(--bar-bottom)))] ${FADE_IN}`}
    />
  );
}
