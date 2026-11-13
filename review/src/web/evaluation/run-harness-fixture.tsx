import { Window } from "happy-dom";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { EnvironmentItem } from "../environments/environment-api";
import type { SavedHarness } from "../harnesses/harness-api";
import type { RunDraft } from "./RunExecution";

// What the Run page's harness and repo ablation tests share.

export const key = (id: string, kind: CredentialInfo["kind"]): CredentialInfo => ({
  id,
  name: id,
  kind,
  auth: "api-key",
  createdAt: "",
});
export const saved = (id: number, name: string, changes: Partial<SavedHarness>): SavedHarness => ({
  id,
  name,
  skills: [],
  createdAt: "",
  updatedAt: "",
  ...changes,
});
export const skills = saved(1, "With Skills", { skills: ["https://github.com/acme/skills"] });
export const delegating = saved(2, "Haiku Subagents", {
  subagent: { catalogId: "claude-haiku-5-5", prompt: "Delegate the tests." },
});
export const codexOnly = saved(3, "Codex Search Off", {
  agent: "codex",
  harnessOptions: { codex: { disable_web_search: true } },
});
export const environment: EnvironmentItem = {
  id: 7,
  name: "No AGENTS.md",
  script: "rm -f AGENTS.md",
  createdAt: "",
  tasks: { total: 4, ready: 3, checking: 0, failed: 1 },
};
export type Row = RunDraft["models"][number];
export const row = (harness: Row["harnesses"][number], more: Partial<Row> = {}): Row => ({
  catalogId: "gpt-6-sol",
  credentialId: "router",
  harnesses: [harness],
  ...more,
});

/** Runs `verify` with a browser's globals in place, for components that take clicks. */
export async function inBrowser(
  verify: (browser: Window, container: HTMLElement) => Promise<void>,
) {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  try {
    await verify(browser, container);
  } finally {
    container.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
  }
}
