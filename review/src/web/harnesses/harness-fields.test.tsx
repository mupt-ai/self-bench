import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessOptionValue } from "../../../../src/contracts/harness-options";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { evaluationCatalog } from "../../../../src/evaluation/catalog";
import { subagentCredentials } from "../../../../src/evaluation/subagents";
import { runCredentials } from "../evaluation/run-readiness";
import { HarnessOptionFields } from "./HarnessOptionFields";
import { type HarnessDraft, subagentOn } from "./harness-draft";
import { SubagentFields, staleSubagentCredential } from "./SubagentFields";

/** A page to render fields into, with its selects found and set by their labels. */
async function onPage(
  body: (page: {
    browser: Window;
    root: Root;
    select: (label: string) => HTMLSelectElement;
    pick: (label: string, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const select = (label: string) => {
    const found = browser.document.querySelector(`select[aria-label="${label}"]`);
    if (!(found instanceof browser.HTMLSelectElement)) throw new Error(`Missing ${label}`);
    return found as unknown as HTMLSelectElement;
  };
  const pick = async (label: string, value: string) => {
    const found = select(label);
    await act(async () => {
      found.value = value;
      found.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
    });
  };
  try {
    await body({ browser, root, select, pick });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
}

test("every option a harness takes is a field, left at Harbor's default until set", async () => {
  let seen: Record<string, HarnessOptionValue> = {};
  function Fields() {
    const [options, setOptions] = useState<Record<string, HarnessOptionValue>>({});
    seen = options;
    return (
      <HarnessOptionFields
        harness="codex"
        options={options}
        idPrefix="harness-codex"
        disabled={false}
        onSet={(name, value) => {
          const { [name]: _, ...rest } = options;
          setOptions(value === undefined ? rest : { ...rest, [name]: value });
        }}
      />
    );
  }
  await onPage(async ({ browser, root, select, pick }) => {
    await act(async () => root.render(<Fields />));
    // Nothing to add or remove: each of Codex's options is already a field, at its default.
    expect(select("Disable Web Search").value).toBe("");
    expect(select("Web Search").value).toBe("");
    expect(browser.document.querySelector('textarea[aria-label="Native Config"]')).not.toBeNull();
    expect(browser.document.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(browser.document.querySelector('select[aria-label^="Add"]')).toBeNull();
    await pick("Disable Web Search", "true");
    expect(seen).toEqual({ disable_web_search: "true" });
    // Claude Code's system prompt is the Instructions field's, so its options don't list it.
    await act(async () =>
      root.render(
        <HarnessOptionFields
          harness="claude-code"
          options={{}}
          idPrefix="harness-claude-code"
          disabled={false}
          onSet={() => undefined}
        />,
      ),
    );
    expect(browser.document.querySelector('[aria-label="Append System Prompt"]')).toBeNull();
    // Claude Code runs in bypass mode, so its permission mode and tool lists aren't fields.
    expect(browser.document.querySelector('[aria-label="Permission Mode"]')).toBeNull();
    expect(browser.document.querySelector('[aria-label="Allowed Tools"]')).toBeNull();
    expect(browser.document.querySelector('[aria-label="Disallowed Tools"]')).toBeNull();
    expect(browser.document.querySelector('fieldset[aria-label="Harness Options"]')).not.toBeNull();
    await act(async () => root.render(<Fields />));
    // Back to Harbor's default, the option is no longer set at all.
    await pick("Disable Web Search", "");
    expect(seen).toEqual({});
  });
});

test("a harness's subagent credential is one that serves its model to its agent, flagged once it can't", () => {
  const key = (id: string, kind: CredentialInfo["kind"]): CredentialInfo => ({
    id,
    name: id,
    kind,
    auth: "api-key",
    createdAt: "",
  });
  const credentials = [
    key("anthropic", "anthropic"),
    key("router", "openrouter"),
    key("e2b", "e2b"),
  ];
  const models = evaluationCatalog();
  const serving = (id: string, agent: "claude-code" | "codex", given: CredentialInfo[]) => {
    const model = models.find((entry) => entry.id === id);
    if (!model) throw new Error(`No catalog model ${id}`);
    return subagentCredentials(model, [agent], given).map((credential) => credential.id);
  };
  // An Anthropic key serves Haiku to Claude Code alone; a gateway key serves it to Codex too.
  const ids = (agent: "claude-code" | "codex") => serving("claude-haiku-5-5", agent, credentials);
  expect(ids("claude-code")).toEqual(["anthropic", "router"]);
  expect(ids("codex")).toEqual(["router"]);
  const on = (agent: "claude-code" | "codex", credentialId?: string) => ({
    agent,
    subagent: subagentOn("claude-haiku-5-5", "", credentialId),
  });
  expect(staleSubagentCredential(on("claude-code", "anthropic"), credentials, models)).toBe(false);
  expect(staleSubagentCredential(on("codex", "anthropic"), credentials, models)).toBe(true);
  expect(staleSubagentCredential(on("codex", "deleted"), credentials, models)).toBe(true);
  // None named runs on the first that serves it, and nothing is flagged before credentials load.
  expect(staleSubagentCredential(on("codex"), credentials, models)).toBe(false);
  expect(staleSubagentCredential(on("codex", "anthropic"), undefined, models)).toBe(false);
  expect(staleSubagentCredential(on("codex", "anthropic"), credentials, [])).toBe(false);
  // A model a gateway lists under its own name, as Vercel's AI Gateway lists DeepSeek, is served
  // by that gateway's key, as on the Run page.
  const vercel = [key("vercel", "vercel-ai-gateway")];
  expect(serving("deepseek-v4-pro-0813", "codex", vercel)).toEqual(["vercel"]);
  // With the managed offering, its key is listed as the Run page lists it, so one pinned to it
  // stays saved.
  const managed = runCredentials(credentials, true);
  expect(serving("claude-haiku-5-5", "codex", managed)).toEqual(["managed-model", "router"]);
  expect(staleSubagentCredential(on("codex", "managed-model"), managed, models)).toBe(false);
  const html = renderToStaticMarkup(
    <SubagentFields
      agent="codex"
      models={models}
      credentials={credentials}
      value={subagentOn("claude-haiku-5-5", "", "anthropic")}
      disabled={false}
      onChange={() => undefined}
    />,
  );
  expect(html).toContain('aria-label="Subagent Credential"');
  expect(html).toContain("no longer serves this model");
  // Its thinking level is picked from the levels the model has on the credential that serves it.
  expect(html).toContain('aria-label="Subagent Thinking Level"');
  for (const level of ["low", "medium", "high"]) expect(html).toContain(`<option value="${level}"`);
  expect(html).not.toContain('<option value="off">');
});

test("a subagent model's thinking level is always one of its own, starting on its default", async () => {
  const credentials: CredentialInfo[] = [
    { id: "router", name: "router", kind: "openrouter", auth: "api-key", createdAt: "" },
  ];
  let seen: HarnessDraft["subagent"];
  function Fields({ start }: { start: HarnessDraft["subagent"] }) {
    const [value, setValue] = useState(start);
    seen = value;
    return (
      <SubagentFields
        agent="codex"
        models={evaluationCatalog()}
        credentials={credentials}
        value={value}
        disabled={false}
        onChange={setValue}
      />
    );
  }
  await onPage(async ({ browser, root, select, pick }) => {
    const levels = () =>
      [...select("Subagent Thinking Level").options].map((option) => option.value);
    // One saved without a level shows the level it runs at, and stays as saved until one is picked.
    await act(async () => root.render(<Fields start={subagentOn("claude-haiku-5-5", "")} />));
    expect(select("Subagent Thinking Level").value).toBe("high");
    expect(levels()).toContain("low");
    expect(levels()).not.toContain("");
    expect(seen?.thinking).toBeUndefined();
    await pick("Subagent Thinking Level", "low");
    expect(seen?.thinking).toBe("low");
    // Another model starts on its own default level, not the last model's.
    const click = async (selector: string, text?: string) => {
      const found = [...browser.document.querySelectorAll(selector)].find(
        (element) => !text || element.textContent?.includes(text),
      );
      if (!found) throw new Error(`Missing ${selector} ${text ?? ""}`);
      await act(async () => (found as unknown as HTMLElement).click());
    };
    await click('button[aria-label="Subagent Model"]');
    await click('[role="option"]', "DeepSeek V4 Pro");
    expect(seen).toMatchObject({ credentialId: "router", thinking: "high" });
    expect(seen?.catalogId).not.toBe("claude-haiku-5-5");
    expect(select("Subagent Thinking Level").value).toBe("high");
  });
});
