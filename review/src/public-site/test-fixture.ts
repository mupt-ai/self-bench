import {
  PUBLIC_SCHEMA_VERSION,
  type PublicRelease,
  type PublicRepoPage,
  type PublicSetting,
} from "./contract";

/** Minimal synthetic data for unit tests. Realistic fixtures stay untracked. */
export function setting(overrides: Partial<PublicSetting> & { id: string }): PublicSetting {
  return {
    model: { catalogId: overrides.id, name: `openai/${overrides.id}`, label: overrides.id },
    harness: "codex",
    reasoningLevel: "high",
    provider: "openai",
    signIn: "api-key",
    custom: false,
    tasks: 10,
    passed: 5,
    accuracy: 50,
    costPerTaskUsd: 1,
    totalCostUsd: 10,
    onFrontier: true,
    ...overrides,
  };
}

function release(overrides: Partial<PublicRelease> = {}): PublicRelease {
  const settings = overrides.settings ?? [
    setting({ id: "sol", accuracy: 100, passed: 10, costPerTaskUsd: 3.2, totalCostUsd: 32 }),
    setting({ id: "sonnet", accuracy: 70, passed: 7, costPerTaskUsd: 1.6, totalCostUsd: 16 }),
    setting({
      id: "qwen",
      accuracy: 30,
      passed: 3,
      costPerTaskUsd: 0.4,
      totalCostUsd: 4,
      custom: true,
    }),
    setting({
      id: "luna",
      accuracy: 40,
      passed: 4,
      costPerTaskUsd: 0.9,
      totalCostUsd: 9,
      onFrontier: false,
    }),
  ];
  return {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    releaseId: "rel-1",
    releasedAt: "2026-09-16T21:05:12Z",
    repository: { id: 70107786, fullName: "vercel/next.js", stars: 137842 },
    publisher: { login: "acme-labs", kind: "org" },
    tasks: 10,
    settings,
    frontier: settings.filter((entry) => entry.onFrontier).map((entry) => entry.id),
    ...overrides,
  };
}

export function page(overrides: Partial<PublicRelease> = {}, endorsed = false): PublicRepoPage {
  return { release: release(overrides), endorsed, lines: [] };
}
