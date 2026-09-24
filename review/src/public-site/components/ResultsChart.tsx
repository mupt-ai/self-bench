import { useEffect, useRef, useState } from "react";
import type { PublicSetting } from "../contract";
import { dollars, harnessLabel, percent, settingLabel, vendorColor } from "../format";
import { nearest, niceTicks, placeLabels } from "./chart-layout";

const MARGIN = { top: 16, right: 24, bottom: 44, left: 48 };

/** Accuracy against cost per task, one point per setting, frontier joined by a line. */
export function ResultsChart({ settings }: { settings: PublicSetting[] }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  const [hovered, setHovered] = useState<string>();
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = width < 560 ? 300 : 420;
  const inner = {
    x: MARGIN.left,
    y: MARGIN.top,
    width: width - MARGIN.left - MARGIN.right,
    height: height - MARGIN.top - MARGIN.bottom,
  };
  const xTicks = niceTicks(
    Math.max(...settings.map((s) => s.costPerTaskUsd), 0.01) * 1.08,
    width < 560 ? 3 : 5,
  );
  const xMax = xTicks.at(-1) ?? 1;
  const yMin = Math.max(
    0,
    Math.floor((Math.min(...settings.map((s) => s.accuracy)) - 10) / 10) * 10,
  );
  const yTicks = niceTicks(100 - yMin, 5)
    .map((tick) => tick + yMin)
    .filter((tick) => tick <= 100);
  const scaleX = (value: number) => inner.x + (value / xMax) * inner.width;
  const scaleY = (value: number) =>
    inner.y + inner.height - ((value - yMin) / (100 - yMin)) * inner.height;
  const points = settings.map((setting) => ({
    id: setting.id,
    setting,
    x: scaleX(setting.costPerTaskUsd),
    y: scaleY(setting.accuracy),
    label: settingLabel(setting, settings),
    priority: setting.onFrontier ? 1 : 0,
  }));
  const labels = placeLabels(points, inner);
  const frontier = points.filter((point) => point.setting.onFrontier).sort((a, b) => a.x - b.x);
  const active = points.find((point) => point.id === hovered);
  // A mouse inspects the point nearest the pointer as it moves; a finger taps a point to
  // inspect it, and taps empty space to put it away. On the tap's pointerup: a touch that turns
  // into a scroll ends in pointercancel instead, so scrolling across the chart opens nothing.
  const inspect = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setHovered(nearest(points, { x: event.clientX - box.left, y: event.clientY - box.top })?.id);
  };
  return (
    <div ref={frame} className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Accuracy versus cost per task for every model setting"
        // Larger text on a narrow chart, which a phone shows at arm's length.
        className={`block font-mono ${width < 560 ? "text-[12px]" : "text-[11px]"}`}
        onPointerMove={(event) => event.pointerType === "mouse" && inspect(event)}
        onPointerUp={(event) => event.pointerType !== "mouse" && inspect(event)}
        onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(undefined)}
      >
        <rect
          x={inner.x}
          y={inner.y}
          width={inner.width}
          height={inner.height}
          fill="var(--card)"
        />
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line
              x1={inner.x}
              x2={inner.x + inner.width}
              y1={scaleY(tick)}
              y2={scaleY(tick)}
              stroke="var(--border)"
            />
            <text
              x={inner.x - 8}
              y={scaleY(tick) + 4}
              textAnchor="end"
              fill="var(--muted-fg)"
            >{`${tick}%`}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x${tick}`}>
            <line
              x1={scaleX(tick)}
              x2={scaleX(tick)}
              y1={inner.y}
              y2={inner.y + inner.height}
              stroke="var(--border)"
              strokeDasharray="2 3"
            />
            <text
              x={scaleX(tick)}
              y={inner.y + inner.height + 18}
              textAnchor="middle"
              fill="var(--muted-fg)"
            >
              {dollars(tick)}
            </text>
          </g>
        ))}
        <text x={inner.x + inner.width} y={height - 6} textAnchor="end" fill="var(--muted-fg)">
          Cost per Task →
        </text>
        <text
          x={12}
          y={inner.y + 4}
          fill="var(--muted-fg)"
          transform={`rotate(-90 12 ${inner.y + 4})`}
          textAnchor="end"
        >
          ↑ Accuracy
        </text>
        {frontier.length > 1 && (
          <polyline
            points={frontier.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            stroke="var(--foreground)"
            strokeOpacity={0.35}
            strokeWidth={1.5}
          />
        )}
        {points.map((point) => (
          <circle
            key={point.id}
            cx={point.x}
            cy={point.y}
            r={point.id === hovered ? 6.5 : point.setting.onFrontier ? 5 : 4}
            fill={point.setting.onFrontier ? vendorColor(point.setting) : "var(--card)"}
            stroke={vendorColor(point.setting)}
            strokeWidth={2}
          />
        ))}
        {labels.map((label) => (
          <text
            key={`l${label.id}`}
            x={label.x}
            y={label.y}
            textAnchor={label.anchor}
            fill="var(--foreground)"
            opacity={hovered && hovered !== label.id ? 0.35 : 0.85}
          >
            {points.find((point) => point.id === label.id)?.label}
          </text>
        ))}
      </svg>
      {active && (
        <div
          className="pointer-events-none absolute z-10 w-56 border border-border bg-card p-3 text-xs shadow-sm"
          style={{
            // Beside the point, on whichever side has room for the card (224px wide).
            left: active.x + 238 <= width ? active.x + 14 : Math.max(0, active.x - 238),
            top: Math.max(active.y - 20, 0),
          }}
        >
          <div className="flex items-center gap-2 font-medium">
            <span className="size-2" style={{ background: vendorColor(active.setting) }} />
            {active.label}
          </div>
          <div className="mt-1 text-muted-foreground">
            {harnessLabel(active.setting)} · {active.setting.reasoningLevel}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-y-1 font-mono tabular-nums">
            <dt className="text-muted-foreground">Accuracy</dt>
            <dd className="text-right">{percent(active.setting.accuracy)}</dd>
            <dt className="text-muted-foreground">Passed</dt>
            <dd className="text-right">{`${active.setting.passed} / ${active.setting.tasks}`}</dd>
            <dt className="text-muted-foreground">Cost / Task</dt>
            <dd className="text-right">{dollars(active.setting.costPerTaskUsd)}</dd>
          </dl>
          {active.setting.onFrontier && (
            <div className="mt-2 text-muted-foreground">On the frontier</div>
          )}
        </div>
      )}
    </div>
  );
}
