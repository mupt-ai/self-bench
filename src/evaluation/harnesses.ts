export const harnessIds = ["codex", "claude-code", "pi", "mini-swe-agent", "terminus-2"] as const;
export type Harness = (typeof harnessIds)[number];
export const harnessLabels: Record<Harness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
  "mini-swe-agent": "Mini-SWE-Agent",
  "terminus-2": "Terminus 2",
};
export const harnessOptions = harnessIds.map((id) => ({ id, label: harnessLabels[id] }));
