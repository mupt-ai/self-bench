import { useCallback, useEffect, useRef, useState } from "react";
import { motionOff } from "../../motion";

/**
 * An easter egg, after Google Hangouts' /pitchforks: a small mob of pixel villagers marches
 * along the top of the search bar, in from its left edge and out past its right. Each mob is
 * its own element and is removed as soon as it has crossed, so repeated triggers stack up
 * without leaving anything behind. Every mob carries at least one torch, and its members
 * shout demands ("more evals!") that trail behind them as they go.
 */

/** Size of one pixel of the villagers, in CSS pixels. */
const PX = 2;
/** Walking speed, in CSS pixels per second. */
const SPEED = 105;
const PEOPLE = 5;
/** Playful colours for the villagers; each gets one for head and body. */
const COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
const SHOUTS = [
  "more evals!",
  "we want evals!",
  "show us the frontier!",
  "benchmark it!",
  "pareto or bust!",
  "run it again!",
];
/** How often someone in the mob shouts, give or take. */
const SHOUT_EVERY_MS = 1000;

interface Villager {
  tool: "pitchfork" | "torch";
  colour: string;
  gap: number;
  rise: number;
  step: number;
}

interface Mob {
  id: number;
  villagers: Villager[];
}

function gather(): Villager[] {
  // Colours drawn without repeats, so neighbours never match.
  const colours = [...COLOURS].sort(() => Math.random() - 0.5);
  const villagers: Villager[] = Array.from({ length: PEOPLE }, (_, index) => ({
    tool: Math.random() < 0.65 ? "pitchfork" : "torch",
    colour: colours[index % colours.length] ?? "#3b82f6",
    // Packed close: tools overlap the next villager a little, like a crowd.
    gap: 11 + Math.round(Math.random() * 3),
    rise: Math.random() < 0.25 ? PX : 0,
    step: Math.round(Math.random() * 300),
  }));
  // Every mob carries at least one torch.
  if (!villagers.some((villager) => villager.tool === "torch")) {
    const bearer = villagers[Math.floor(Math.random() * villagers.length)];
    if (bearer) bearer.tool = "torch";
  }
  return villagers;
}

interface Shout {
  id: number;
  text: string;
  x: number;
}

/** One villager on a 7 by 10 pixel grid: a block head on a block body, holding a tool. */
function Figure({ villager }: { villager: Villager }) {
  const cell = (x: number, y: number, width = 1, height = 1, className = "") => (
    <rect
      x={x * PX}
      y={y * PX}
      width={width * PX}
      height={height * PX}
      className={className}
      key={`${x}-${y}-${width}-${height}`}
    />
  );
  return (
    <svg
      width={7 * PX}
      height={10 * PX}
      viewBox={`0 0 ${7 * PX} ${10 * PX}`}
      className="mob-bob shrink-0 overflow-visible"
      style={{ animationDelay: `-${villager.step}ms`, marginBottom: villager.rise }}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <g style={{ fill: villager.colour }}>
        {cell(1, 4, 2, 2)}
        {cell(0, 6, 4, 4)}
        {cell(4, 7)}
      </g>
      {villager.tool === "pitchfork" ? (
        <g className="fill-muted-foreground">
          {cell(5, 1, 1, 9)}
          {cell(4, 2, 3, 1)}
          {cell(4, 0, 1, 2)}
          {cell(6, 0, 1, 2)}
          {cell(5, 0)}
        </g>
      ) : (
        <>
          <g className="fill-muted-foreground">{cell(5, 3, 1, 7)}</g>
          <g className="mob-flame">
            {cell(4, 0, 3, 3, "fill-[#f97316]")}
            {cell(5, 1, 1, 2, "fill-[#facc15]")}
          </g>
        </>
      )}
    </svg>
  );
}

function MarchingMob({
  mob,
  onGone,
  onShout,
}: {
  mob: Mob;
  onGone: (id: number) => void;
  onShout: (text: string, x: number) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = row.current;
    const lane = element?.parentElement;
    if (!element || !lane) return;
    const from = -element.offsetWidth;
    const to = lane.clientWidth;
    const march = element.animate(
      [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
      { duration: ((to - from) / SPEED) * 1000, easing: "linear", fill: "forwards" },
    );
    march.onfinish = () => onGone(mob.id);
    // Someone on the bar shouts every so often. The shout stays where it was said, so the mob
    // walks on and leaves it trailing behind as it drifts up and fades.
    // Each mob works through its own shuffled copy of the lines, so no line is said twice.
    const lines = [...SHOUTS].sort(() => Math.random() - 0.5);
    let timer = 0;
    const shout = () => {
      const figures = [...element.children] as HTMLElement[];
      const speaker = figures[Math.floor(Math.random() * figures.length)];
      const along = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
      const x = along + (speaker?.offsetLeft ?? 0);
      if (speaker && x > 0 && x < to) {
        const line = lines.pop();
        if (line) onShout(line, x);
      }
      if (lines.length)
        timer = window.setTimeout(shout, SHOUT_EVERY_MS * (0.7 + Math.random() * 0.6));
    };
    timer = window.setTimeout(shout, 350);
    return () => {
      march.cancel();
      window.clearTimeout(timer);
    };
  }, [mob.id, onGone, onShout]);
  return (
    <div
      ref={row}
      className="absolute bottom-0 left-0 flex items-end"
      style={{ transform: "translateX(-100%)" }}
    >
      {mob.villagers.map((villager, index) => (
        <span
          // The mob never reorders, so position in it is a stable identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed order within one mob
          key={index}
          className="flex"
          style={{ marginRight: villager.gap - 7 * PX }}
        >
          <Figure villager={villager} />
        </span>
      ))}
    </div>
  );
}

/**
 * The lane the mobs walk in, sitting on the top edge of its (relatively positioned) parent.
 * Villagers are clipped to its width, so they enter and leave at the bar's edges; shouts are
 * not, so a shout near an edge still shows whole. `summon` starts a new mob.
 */
export function usePitchforks() {
  const [mobs, setMobs] = useState<Mob[]>([]);
  const [shouts, setShouts] = useState<Shout[]>([]);
  const next = useRef(0);
  const summon = useCallback(() => {
    if (motionOff()) return;
    next.current += 1;
    const mob = { id: next.current, villagers: gather() };
    setMobs((current) => [...current, mob]);
  }, []);
  const gone = useCallback((id: number) => {
    setMobs((current) => current.filter((mob) => mob.id !== id));
  }, []);
  const shout = useCallback((text: string, x: number) => {
    next.current += 1;
    const id = next.current;
    setShouts((current) => [...current, { id, text, x }]);
  }, []);
  const lane =
    mobs.length || shouts.length ? (
      <div
        aria-hidden="true"
        // Positioned from inside the bar's 1.5px border; lifted by it so feet rest on the edge.
        className="pointer-events-none absolute inset-x-0 bottom-full mb-[1.5px] h-6"
      >
        <div className="absolute inset-0 overflow-hidden">
          {mobs.map((mob) => (
            <MarchingMob key={mob.id} mob={mob} onGone={gone} onShout={shout} />
          ))}
        </div>
        {shouts.map((said) => (
          <span
            key={said.id}
            className="mob-shout absolute bottom-1 font-mono text-[10px] whitespace-nowrap text-foreground/70"
            style={{ left: said.x }}
            // Each shout removes itself once it has faded.
            onAnimationEnd={() =>
              setShouts((current) => current.filter((other) => other.id !== said.id))
            }
          >
            {said.text}
          </span>
        ))}
      </div>
    ) : null;
  return { lane, summon };
}
