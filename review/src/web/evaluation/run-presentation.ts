import type { ThinkingLevel } from "../../../../src/evaluation/models";

const thinkingLabels: Record<ThinkingLevel, string> = {
  default: "model default",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
export function thinkingLabel(value?: ThinkingLevel) {
  return value ? thinkingLabels[value] : "Not Recorded";
}
