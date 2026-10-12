import { expect, test } from "bun:test";
import { catalog } from "../src/evaluation/catalog.js";
import { thinkingArguments, thinkingOptions } from "../src/evaluation/models.js";

test("a row offers the model's levels that every one of its harnesses accepts", () => {
  const deepseek = catalog.find((entry) => entry.id === "deepseek-v4-pro-0813");
  if (!deepseek) throw new Error("Missing DeepSeek V4 Pro");
  expect(thinkingOptions(deepseek, ["mini-swe-agent"])).toEqual(["off", "low", "high", "max"]);
  // Claude Code takes no "off"; a level one harness lacks leaves the row's other harnesses too.
  expect(thinkingOptions(deepseek, ["claude-code"])).toEqual(["low", "high", "max"]);
  expect(thinkingOptions(deepseek, ["pi", "terminus-2"])).toEqual(["off", "low", "high"]);
});

test("thinking levels reach the actual Harbor harness flags without changing models", () => {
  expect(thinkingArguments("codex", "max")).toEqual(["--agent-kwarg", "reasoning_effort=max"]);
  expect(thinkingArguments("codex", "off")).toEqual(["--agent-kwarg", "reasoning_effort=none"]);
  expect(thinkingArguments("claude-code", "xhigh")).toEqual([
    "--agent-kwarg",
    "reasoning_effort=xhigh",
  ]);
  expect(thinkingArguments("pi", "high")).toEqual(["--agent-kwarg", "thinking=high"]);
  expect(thinkingArguments("pi", "default")).toEqual([]);
});

test("each harness gets a level as its Harbor adapter spells it, or not at all", () => {
  for (const harness of ["mini-swe-agent", "terminus-2", "muse-code"] as const) {
    expect(thinkingArguments(harness, "off")).toEqual(["--agent-kwarg", "reasoning_effort=none"]);
    expect(thinkingArguments(harness, "max")).toEqual(["--agent-kwarg", "reasoning_effort=max"]);
  }
  // A level the harness's Harbor adapter would reject never reaches it.
  expect(thinkingArguments("pi", "max")).toEqual([]);
});
