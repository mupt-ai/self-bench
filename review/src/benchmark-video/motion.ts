import type { PublicSetting } from "../public-site/contract";

/**
 * The benchmark video's timeline and choices, kept apart from the page so they can be tested:
 * which settings are shown and labeled, where every point sits between two repositories, and
 * where the highlighted model's label goes.
 */

export interface VideoRepo {
  name: string;
  avatar: string;
  tasks: number;
  settings: PublicSetting[];
}

/** A model shown beside the highlighted one, by its catalog id, with an optional note. */
interface VideoExtra {
  model: string;
  note?: string;
}

export interface VideoConfig {
  title: string;
  model: string;
  extras: VideoExtra[];
  repos: VideoRepo[];
}

/** Each repository holds still, then morphs into the next. */
export const HOLD = 2.2;
export const MORPH = 0.7;
export const SEGMENT = HOLD + MORPH;

/** A setting id is "<catalog model>|<harness>|<reasoning>". */
export const catalogModel = (setting: Pick<PublicSetting, "id">) => setting.id.split("|")[0] ?? "";

/**
 * The repository with only the settings the site's chart plots: an incomplete cost is only a
 * lower bound, possibly zero, which a log axis cannot place (ResultsChart drops them too).
 */
export function chartable(repo: VideoRepo): VideoRepo {
  return {
    ...repo,
    settings: repo.settings.filter((s) => !s.costIncomplete && s.costPerTaskUsd > 0),
  };
}

/** The highlighted model's best setting in a repository, if it ran there. */
export function focusSetting(repo: VideoRepo, model: string): PublicSetting | undefined {
  return repo.settings
    .filter((setting) => catalogModel(setting) === model)
    .sort((a, b) => b.accuracy - a.accuracy)[0];
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface Shown {
  setting: PublicSetting;
  x: number;
  y: number;
  alpha: number;
}

/**
 * Every point at progress p from one repository to the next: settings in both move, cost on the
 * log scale the chart uses; the rest fade out in the first half and in during the second.
 * Points sort by `rank`, so higher ranks draw over lower ones.
 */
export function pointsAt(
  from: VideoRepo,
  to: VideoRepo,
  p: number,
  rank: (setting: PublicSetting) => number,
): Shown[] {
  const next = new Map(to.settings.map((s) => [s.id, s]));
  const prev = new Map(from.settings.map((s) => [s.id, s]));
  const shown: Shown[] = [];
  for (const a of from.settings) {
    const b = next.get(a.id);
    if (b) {
      shown.push({
        setting: p < 0.5 ? a : b,
        x: Math.exp(lerp(Math.log(a.costPerTaskUsd), Math.log(b.costPerTaskUsd), p)),
        y: lerp(a.accuracy, b.accuracy, p),
        alpha: 1,
      });
    } else if (p < 0.5) {
      shown.push({ setting: a, x: a.costPerTaskUsd, y: a.accuracy, alpha: 1 - 2 * p });
    }
  }
  for (const b of to.settings) {
    if (!prev.has(b.id) && p >= 0.5)
      shown.push({ setting: b, x: b.costPerTaskUsd, y: b.accuracy, alpha: 2 * p - 1 });
  }
  return shown.sort((a, b) => rank(a.setting) - rank(b.setting));
}

/** Where the timeline stands at second t. */
export function momentAt(t: number, repos: number) {
  const segment = Math.floor(t / SEGMENT) % repos;
  const local = t - segment * SEGMENT;
  const morphing = local >= HOLD;
  const p = morphing ? ease(clamp((local - HOLD) / MORPH)) : 0;
  // Labels and the dimmed rest come in once a repository settles and leave before it moves on.
  const focusIn = morphing
    ? 0
    : ease(clamp((local - 0.15) / 0.35)) * ease(clamp((HOLD - local) / 0.3));
  return { from: segment, to: (segment + 1) % repos, p, morphing, focusIn };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Point = readonly [number, number];

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function crosses(box: Box, [x1, y1]: Point, [x2, y2]: Point) {
  for (let i = 0; i <= 20; i++) {
    const x = x1 + ((x2 - x1) * i) / 20;
    const y = y1 + ((y2 - y1) * i) / 20;
    if (x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height) return true;
  }
  return false;
}

/**
 * The top-left corner for a label of the given size beside the point at (px, py): of the spots
 * around it, the one that hits the fewest marks, other labels and frontier segments, and stays
 * inside the bounds. Ties go to the earlier spot, so above the point wins when it is clear.
 */
export function labelSpot(
  [px, py]: Point,
  size: { width: number; height: number },
  obstacles: { marks: Box[]; labels: Box[]; line: Point[]; bounds: Box },
): Point {
  const { width, height } = size;
  const gap = 12;
  const spots: Point[] = [
    [px - width / 2, py - gap - height],
    [px - width * 0.85, py - gap - height],
    [px - width * 0.15, py - gap - height],
    [px - gap - width, py - height / 2],
    [px + gap, py - height / 2],
    [px - width / 2, py + gap],
    [px - gap - width, py - gap - height],
    [px + gap, py - gap - height],
    [px - gap - width, py + gap],
    [px + gap, py + gap],
  ];
  const { marks, labels, line, bounds } = obstacles;
  const collisions = ([x, y]: Point) => {
    const box = { x, y, width, height };
    const outside =
      x < bounds.x ||
      y < bounds.y ||
      x + width > bounds.x + bounds.width ||
      y + height > bounds.y + bounds.height;
    return (
      10 * Number(outside) +
      marks.filter((mark) => overlaps(box, mark)).length +
      labels.filter((label) => overlaps(box, label)).length +
      line.filter((point, i) => i > 0 && crosses(box, line[i - 1] ?? point, point)).length
    );
  };
  return spots.reduce((best, spot) => (collisions(spot) < collisions(best) ? spot : best));
}
