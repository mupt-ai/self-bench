import { expect, test } from "bun:test";
import { endpointNumber, publicIds } from "../src/public/endpoint-numbers.js";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { approvedTasks, full, inputs } from "./support/release-fixture.js";

/** Custom settings that differ only by endpoint, numbered instead of fingerprinted. */
const context = {
  repository: { id: 70107786, fullName: "vercel/next.js" },
  publisher: { login: "acme", kind: "org" as const },
};

test("one model on two endpoints is numbered by key, whatever the run order", () => {
  const twins = (order: string[]) =>
    inputs({
      runs: order.map((credential) => full("qwen", ["t1"], { provider: "custom", credential })),
      tasks: approvedTasks(["t1"]),
    });
  const ids = (all: ReturnType<typeof inputs>, credentials?: string[]) => {
    const preview = previewRelease(all);
    const keys = preview.settings
      .filter((setting) => !credentials || credentials.some((c) => setting.key.includes(c)))
      .map((setting) => setting.key);
    return buildRelease(all, keys, context).payload.settings.map((setting) => setting.id);
  };
  const numbered = ["qwen|codex|custom|api-key|default|#1", "qwen|codex|custom|api-key|default|#2"];
  expect(ids(twins(["host-a", "host-b"]))).toEqual(numbered);
  expect(ids(twins(["host-b", "host-a"]))).toEqual(numbered);
  // Released alone, an endpoint needs no number.
  expect(ids(twins(["host-a", "host-b"]), ["b.example"])).toEqual([
    "qwen|codex|custom|api-key|default",
  ]);
});

test("endpoint numbers go to custom twins only, in key order", () => {
  const ids = publicIds([
    { key: '["m","b"]', id: "m", custom: true },
    { key: '["m","a"]', id: "m", custom: true },
    { key: '["n","a"]', id: "n", custom: true },
    { key: '["o"]', id: "o", custom: false },
  ]);
  expect([...ids.values()]).toEqual(["m|#2", "m|#1", "n", "o"]);
  expect(endpointNumber("m|#2")).toBe(2);
  expect(endpointNumber("n")).toBeUndefined();
});
