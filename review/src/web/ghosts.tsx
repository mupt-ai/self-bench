import type { ReactNode } from "react";
import { cn } from "./primitives/cn";

/**
 * Faint pictures of what an empty page will hold, for `EmptyState`'s `visual`: the shapes of its
 * rows or cards drawn in outline, with no made-up data, so they read as the page to come.
 */

/** A placeholder for text: a short faint bar, as wide as `width`. */
function Bar({ width, strong = false }: { width: string; strong?: boolean }) {
  return (
    <span
      className={cn("block h-2 shrink-0", strong ? "bg-foreground/[0.12]" : "bg-foreground/[0.07]")}
      style={{ width }}
    />
  );
}

/** A small outlined tag, as rows carry for a status or a scope. */
function Chip({ children, width = "3rem" }: { children?: ReactNode; width?: string }) {
  return (
    <span
      className="flex h-5 shrink-0 items-center justify-center border border-foreground/15 px-1.5 font-mono text-xs text-(--faint)"
      style={{ minWidth: width }}
    >
      {children}
    </span>
  );
}

/** Rows of a list: a mark, a line of text, and what sits at the row's end. */
function Rows({
  rows,
  mark,
  end,
}: {
  rows: readonly string[];
  mark: (index: number) => ReactNode;
  end: (index: number) => ReactNode;
}) {
  return (
    <ul className="divide-y divide-foreground/[0.08] border border-foreground/[0.12]">
      {rows.map((width, index) => (
        <li
          key={width}
          className={cn("flex items-center gap-3 px-3 py-3", index > 1 && "opacity-60")}
        >
          {mark(index)}
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Bar width={width} strong />
            <Bar width={`calc(${width} * 0.6)`} />
          </span>
          {end(index)}
        </li>
      ))}
    </ul>
  );
}

const ring = (size = "size-3") => (
  <span className={cn("shrink-0 rounded-full border-[1.5px] border-(--faint)", size)} />
);

/** Tasks, each from a pull request, with its difficulty. */
export function GhostTasks() {
  return (
    <Rows
      rows={["70%", "55%", "64%"]}
      mark={() => ring()}
      end={(index) => <Chip>{["easy", "hard", "medium"][index]}</Chip>}
    />
  );
}

/** Repositories to connect. */
export function GhostRepos() {
  return (
    <Rows
      rows={["58%", "72%", "46%"]}
      mark={() => <span className="size-6 shrink-0 rounded-full bg-foreground/[0.08]" />}
      end={() => <Chip width="3.5rem" />}
    />
  );
}

/** API keys, by their visible prefix and scope. */
export function GhostKeys() {
  return (
    <Rows
      rows={["50%", "40%"]}
      mark={() => <span className="shrink-0 font-mono text-xs text-(--faint)">sbk_</span>}
      end={(index) => <Chip width="4.5rem">{index === 0 ? "write" : "read"}</Chip>}
    />
  );
}

/** Discovery: each sandbox reading merged pull requests and proposing task candidates. */
export function GhostDiscovery() {
  return (
    <Rows
      rows={["62%", "48%", "56%"]}
      mark={() => <span className="shrink-0 text-xs text-(--faint)">▸</span>}
      end={() => <Chip width="4rem" />}
    />
  );
}

/**
 * Batch generation: merged pull requests on the left become tasks on the right, fewer of them,
 * since only some pull requests make a good task.
 */
export function GhostBatches() {
  const prs = [26, 66, 106, 146] as const;
  const tasks = [46, 106] as const;
  return (
    <svg viewBox="0 0 380 190" className="block h-auto w-full" fill="none" role="presentation">
      <g stroke="var(--faint)" strokeWidth="1.5">
        {prs.map((y, index) => (
          <g key={y} opacity={index > 1 ? 0.6 : 1}>
            <rect x="8" y={y - 14} width="128" height="28" />
            <circle cx="24" cy={y} r="5" />
            <path d={`M38 ${y}h${70 - index * 8}`} strokeOpacity="0.5" strokeWidth="6" />
          </g>
        ))}
        <path d="M150 95h56m-8-6 8 6-8 6" strokeDasharray="4 5" />
        {tasks.map((y) => (
          <g key={y}>
            <rect x="220" y={y - 22} width="150" height="44" />
            <path d={`M234 ${y - 6}h96M234 ${y + 8}h60`} strokeOpacity="0.5" strokeWidth="6" />
          </g>
        ))}
      </g>
      <g fill="var(--faint)" fontSize="12" fontFamily="var(--sans)">
        <text x="8" y="186">
          Merged PRs
        </text>
        <text x="220" y="186">
          Tasks
        </text>
      </g>
    </svg>
  );
}

/** A release: the repository's card on selfbench.dev, with its two picks. */
export function GhostRelease({ repo }: { repo: string }) {
  return (
    <div className="border border-foreground/[0.12] p-4">
      <div className="flex items-center gap-2.5">
        <span className="size-5 shrink-0 rounded-full bg-foreground/[0.08]" />
        <span className="min-w-0 truncate font-mono text-sm text-(--faint)">{repo}</span>
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {["Most Accurate", "Cheapest"].map((label) => (
          <div key={label} className="flex items-center gap-3 text-xs text-(--faint)">
            <span className="w-24 shrink-0">{label}</span>
            <Bar width="40%" strong />
            <span className="ml-auto font-mono">—%</span>
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-foreground/[0.08] pt-3 font-mono text-xs text-(--faint)">
        selfbench.dev/{repo}
      </div>
    </div>
  );
}

/** Managed usage: tokens and sandbox time by day, as columns along an axis. */
export function GhostUsage() {
  const heights = [36, 64, 48, 92, 70, 120, 84, 104] as const;
  return (
    <svg viewBox="0 0 380 170" className="block h-auto w-full" fill="none" role="presentation">
      <g stroke="var(--ruler)">
        <path d="M20 30h350M20 80h350" />
      </g>
      <path d="M20 140h350" stroke="var(--border)" strokeWidth="1.5" />
      <g stroke="var(--faint)" strokeWidth="1.5">
        {heights.map((height, index) => (
          <rect
            key={height}
            x={32 + index * 42}
            y={140 - height}
            width="24"
            height={height}
            opacity={index < 5 ? 0.6 : 1}
          />
        ))}
      </g>
      <g fill="var(--faint)" fontSize="12" fontFamily="var(--sans)">
        <text x="20" y="162">
          Tokens and sandbox time
        </text>
      </g>
    </svg>
  );
}
