import { describe, expect, test } from "bun:test";
import { HARBOR_AGENT_ADAPTERS } from "../src/agent-smoke.js";

describe("Harbor adapter smoke matrix", () => {
  test("covers every adapter registered by pinned Harbor", () => {
    expect(HARBOR_AGENT_ADAPTERS).toHaveLength(38);
    expect(new Set(HARBOR_AGENT_ADAPTERS).size).toBe(HARBOR_AGENT_ADAPTERS.length);
    expect(HARBOR_AGENT_ADAPTERS).toContain("codex");
    expect(HARBOR_AGENT_ADAPTERS).toContain("pi");
    expect(HARBOR_AGENT_ADAPTERS).toContain("oracle");
    expect(HARBOR_AGENT_ADAPTERS).toContain("nop");
  });
});
