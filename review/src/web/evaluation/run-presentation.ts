import type { ThinkingLevel } from "../../../../src/evaluation/model-options";

const thinkingLabels: Record<ThinkingLevel, string> = {
  default: "Model Default",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};
export function thinkingLabel(value?: ThinkingLevel) {
  return value ? thinkingLabels[value] : "Not Recorded";
}
