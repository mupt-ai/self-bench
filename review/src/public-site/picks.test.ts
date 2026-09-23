import { expect, test } from "bun:test";
import { frontierSettings, picks } from "./picks";
import { setting } from "./test-fixture";

const roles = (settings: Parameters<typeof picks>[0]) =>
  picks(settings).map((pick) => `${pick.setting.id}:${pick.roles.join("+")}`);

test("frontier settings are ordered cheapest first and exclude dominated ones", () => {
  const ordered = frontierSettings([
    setting({ id: "b", costPerTaskUsd: 2 }),
    setting({ id: "off", costPerTaskUsd: 1.5, onFrontier: false }),
    setting({ id: "a", costPerTaskUsd: 1 }),
  ]);
  expect(ordered.map((entry) => entry.id)).toEqual(["a", "b"]);
});

test("picks are the cheapest and the most accurate frontier settings", () => {
  expect(
    roles([
      setting({ id: "top", accuracy: 100, costPerTaskUsd: 4 }),
      setting({ id: "mid", accuracy: 92, costPerTaskUsd: 2 }),
      setting({ id: "cheap", accuracy: 40, costPerTaskUsd: 0.3 }),
    ]),
  ).toEqual(["cheap:cheapest", "top:mostAccurate"]);
});

test("a single frontier setting holds both roles once", () => {
  expect(roles([setting({ id: "only" })])).toEqual(["only:cheapest+mostAccurate"]);
});

test("ties resolve deterministically and non-frontier settings never become picks", () => {
  expect(
    roles([
      setting({ id: "z", accuracy: 80, costPerTaskUsd: 1 }),
      setting({ id: "a", accuracy: 80, costPerTaskUsd: 1 }),
      setting({ id: "hidden", accuracy: 99, costPerTaskUsd: 0.1, onFrontier: false }),
    ]),
  ).toEqual(["a:cheapest+mostAccurate"]);
});

test("no settings means no picks", () => {
  expect(picks([])).toEqual([]);
});
