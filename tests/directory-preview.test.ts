import { expect, test } from "bun:test";
import { directoryOf, offFrontier } from "../src/public/directory.js";
import type { PublishedLine } from "../src/public/release-types.js";

const setting = (id: string, accuracy: number, costPerTaskUsd: number, onFrontier: boolean) => ({
  id,
  model: { label: id },
  reasoningLevel: "high",
  accuracy,
  costPerTaskUsd,
  onFrontier,
});

test("off the frontier, the most accurate come first; cost, then id, break ties", () => {
  const settings = [
    setting("frontier", 90, 1, true),
    setting("dear", 60, 4, false),
    setting("cheap", 60, 2, false),
    setting("best", 80, 9, false),
    setting("b-twin", 50, 1, false),
    setting("a-twin", 50, 1, false),
  ];
  expect(offFrontier(settings).map((entry) => entry.id)).toEqual([
    "best",
    "cheap",
    "dear",
    "a-twin",
    "b-twin",
  ]);
});

test("a card carries as many settings off the frontier as its preview has lines", () => {
  const line = {
    release: {
      schemaVersion: 1,
      releaseId: "r",
      releasedAt: "2026-10-05T00:00:00Z",
      repository: { id: 1, fullName: "owner/name" },
      publisher: { login: "acme", kind: "org" },
      tasks: 10,
      settings: [
        setting("sol", 90, 3, true),
        setting("luna", 70, 0.4, true),
        ...[85, 80, 75, 65, 60, 55, 50].map((accuracy) =>
          setting(`off-${accuracy}`, accuracy, 1, false),
        ),
      ],
    },
    endorsed: false,
  } as unknown as PublishedLine;
  const [card] = directoryOf([line]);
  expect(card?.frontier.map((entry) => entry.id)).toEqual(["luna", "sol"]);
  expect(card?.others.map((entry) => entry.id)).toEqual([
    "off-85",
    "off-80",
    "off-75",
    "off-65",
    "off-60",
  ]);
  expect(card?.others[0]).toEqual({
    id: "off-85",
    model: { label: "off-85" },
    accuracy: 85,
    costPerTaskUsd: 1,
  });
});
