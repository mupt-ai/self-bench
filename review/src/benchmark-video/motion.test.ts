import { describe, expect, test } from "bun:test";
import type { PublicSetting } from "../public-site/contract";
import {
  chartable,
  focusSetting,
  HOLD,
  labelSpot,
  MORPH,
  momentAt,
  pointsAt,
  type VideoRepo,
} from "./motion";

const setting = (id: string, accuracy: number, costPerTaskUsd: number) =>
  ({ id, accuracy, costPerTaskUsd }) as PublicSetting;
const repo = (...settings: PublicSetting[]): VideoRepo => ({
  name: "o/r",
  avatar: "",
  tasks: 10,
  settings,
});

describe("focusSetting", () => {
  test("picks the model's most accurate setting, matching the whole catalog id", () => {
    const r = repo(
      setting("deepseek/flash|pi|low", 60, 0.05),
      setting("deepseek/flash|pi|high", 70, 0.08),
      setting("deepseek/flash-1017|pi|high", 80, 0.07),
    );
    expect(focusSetting(r, "deepseek/flash")?.id).toBe("deepseek/flash|pi|high");
    expect(focusSetting(r, "deepseek/flash-1017")?.id).toBe("deepseek/flash-1017|pi|high");
    expect(focusSetting(r, "deepseek/flash-2")).toBeUndefined();
  });
});

describe("chartable", () => {
  test("drops settings whose cost is zero, as the site's chart does", () => {
    const r = repo(setting("a|x|high", 50, 0.1), setting("c|x|high", 70, 0));
    expect(chartable(r).settings.map((s) => s.id)).toEqual(["a|x|high"]);
  });
});

describe("pointsAt", () => {
  const from = repo(setting("a|x|high", 40, 0.01), setting("gone|x|high", 50, 1));
  const to = repo(setting("a|x|high", 60, 1), setting("new|x|high", 70, 1));

  test("moves shared settings, cost on a log scale", () => {
    const middle = pointsAt(from, to, 0.5, () => 0).find((s) => s.setting.id === "a|x|high");
    expect(middle?.y).toBe(50);
    expect(middle?.x).toBeCloseTo(0.1);
  });

  test("fades settings out of one repository and into the next", () => {
    const ids = (p: number) => pointsAt(from, to, p, () => 0).map((s) => [s.setting.id, s.alpha]);
    expect(ids(0.25)).toEqual([
      ["a|x|high", 1],
      ["gone|x|high", 0.5],
    ]);
    expect(ids(0.75)).toEqual([
      ["a|x|high", 1],
      ["new|x|high", 0.5],
    ]);
  });

  test("draws higher ranks last", () => {
    const order = pointsAt(to, to, 0, (s) => (s.id === "a|x|high" ? 1 : 0)).map(
      (s) => s.setting.id,
    );
    expect(order).toEqual(["new|x|high", "a|x|high"]);
  });
});

describe("momentAt", () => {
  test("holds each repository, then morphs into the next and wraps around", () => {
    expect(momentAt(1, 3)).toMatchObject({ from: 0, to: 1, p: 0, morphing: false });
    const middle = momentAt(HOLD + MORPH / 2, 3);
    expect(middle).toMatchObject({ from: 0, to: 1, morphing: true });
    expect(middle.p).toBeCloseTo(0.5);
    expect(momentAt(2 * (HOLD + MORPH) + 1, 3)).toMatchObject({ from: 2, to: 0 });
  });
});

describe("labelSpot", () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
  const size = { width: 100, height: 20 };

  test("goes above the point when that is clear", () => {
    expect(labelSpot([500, 500], size, { marks: [], labels: [], line: [], bounds })).toEqual([
      450, 468,
    ]);
  });

  test("steps aside from a frontier segment running through the spot above", () => {
    const line: [number, number][] = [
      [300, 478],
      [700, 478],
    ];
    const [, y] = labelSpot([500, 500], size, { marks: [], labels: [], line, bounds });
    expect(y).toBeGreaterThan(478);
  });

  test("stays inside the bounds", () => {
    const [x] = labelSpot([20, 500], size, { marks: [], labels: [], line: [], bounds });
    expect(x).toBeGreaterThanOrEqual(0);
  });
});
