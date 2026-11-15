import type { PublicSetting } from "../../contract";
import { setting } from "../../test-fixture";

/** A model's settings in a repo ablation and under a saved harness, for the chart's filters. */
export function variantSettings(model: PublicSetting["model"]): PublicSetting[] {
  return [
    setting({
      id: "alpha-codex|no-agents",
      model,
      ablation: "No AGENTS.md",
      accuracy: 88,
      costPerTaskUsd: 2.9,
    }),
    setting({
      id: "alpha-codex|skills",
      model,
      customHarness: "With Skills",
      accuracy: 96,
      costPerTaskUsd: 3.6,
    }),
  ];
}
