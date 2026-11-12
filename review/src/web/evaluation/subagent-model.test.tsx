import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog } from "../../../../src/evaluation/catalog";
import { harnessIds } from "../../../../src/evaluation/models";
import { subagentSupport } from "../../../../src/evaluation/subagents";
import { resultsBySetting } from "../../../../src/public/release-results";
import { hasModelSelection } from "./model-selection";
import { RunModelRow } from "./RunModelRow";
import { RunSubagentControls } from "./RunSubagentControls";
import { credentials, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { restoreRunDraft } from "./run-draft";
import { retrySelection } from "./run-retry";

const subagent = {
  catalogId: "deepseek-v4-pro-0813",
  model: "openrouter/deepseek/deepseek-v4-pro-0813",
  label: "DeepSeek V4 Pro",
  credentialId: "managed-model",
};

test.each(["claude-code", "codex"] as const)(
  "%s exposes a separate optional subagent model and credential",
  (harness) => {
    const model = catalog.find((entry) => entry.id === "gpt-6-sol");
    if (!model) throw new Error("Missing model");
    const credential: CredentialInfo = {
      id: "managed-model",
      name: "Managed",
      kind: "openrouter",
      auth: "api-key",
      createdAt: "",
    };
    const html = renderToStaticMarkup(
      <RunModelRow
        model={model}
        models={catalog}
        credentials={[credential]}
        selection={{
          catalogId: model.id,
          credentialId: credential.id,
          harnesses: [harness],
          subagent,
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Configure Subagent Model"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Managed");
    expect(html).not.toContain('aria-label="Subagent Credential"');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("Overrides Claude Code's subagent model");
    expect(html).not.toContain("default subagent model");
    const plain = renderToStaticMarkup(
      <RunModelRow
        model={model}
        credentials={[credential]}
        selection={{ catalogId: model.id, credentialId: credential.id, harnesses: ["pi"] }}
        onChange={() => {}}
      />,
    );
    expect(plain).not.toContain('aria-label="Add Subagent Model"');
    expect(plain).toContain("Subagent Model · Not Supported");
    expect(plain).not.toContain("does not install a subagent extension");
  },
);

test("unsupported harnesses show a concise status instead of inert selectors", () => {
  const base = catalog[0];
  if (!base) throw new Error("Missing model");
  for (const harness of harnessIds.filter((entry) => !subagentSupport[entry].configurable)) {
    const html = renderToStaticMarkup(
      <RunModelRow
        model={base}
        credentials={[]}
        selection={{ catalogId: base.id, credentialId: "", harnesses: [harness] }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Subagent Model · Not Supported");
    expect(html).not.toContain('aria-label="Add Subagent Model"');
  }
});

test("a custom endpoint's row is told it cannot take a subagent model", () => {
  const model = catalog.find((entry) => entry.id === "gpt-6-sol");
  if (!model) throw new Error("Missing model");
  const endpoint: CredentialInfo = {
    id: "endpoint",
    name: "Endpoint",
    kind: "custom",
    auth: "api-key",
    createdAt: "",
  };
  const html = renderToStaticMarkup(
    <RunSubagentControls
      models={catalog}
      credentials={[endpoint]}
      harnesses={["codex"]}
      catalogId="custom"
      provider="custom"
      onChange={() => {}}
    />,
  );
  expect(html).toContain("Subagent Model · Not Supported");
  expect(html).toContain("A custom endpoint cannot run beside a subagent model");
  expect(html).not.toContain('aria-label="Configure Subagent Model"');
});

test("the same subagent model on another credential is the same configuration", () => {
  const model = catalog[0];
  if (!model) throw new Error("Missing model");
  const keys = [
    { id: "router-a", kind: "openrouter" as const },
    { id: "vercel", kind: "vercel-ai-gateway" as const },
  ];
  const selection = {
    catalogId: model.id,
    credentialId: "router-a",
    harnesses: ["codex" as const],
    subagent: { catalogId: subagent.catalogId, credentialId: "router-a" },
  };
  // A setting names its subagent model by catalog id, whatever credential serves it.
  expect(
    hasModelSelection(
      model,
      [selection],
      { ...selection, subagent: { ...selection.subagent, credentialId: "vercel" } },
      keys,
    ),
  ).toBe(true);
  expect(
    hasModelSelection(
      model,
      [selection],
      { ...selection, subagent: { ...selection.subagent, catalogId: "gpt-6-luna" } },
      keys,
    ),
  ).toBe(false);
  const { subagent: _none, ...alone } = selection;
  expect(hasModelSelection(model, [selection], alone, keys)).toBe(false);
});

test("subagent settings survive draft restoration and retry", () => {
  const original = run("configured", { subagent }, [
    { ...passed("task"), status: "failed", error: "Provider unavailable" },
  ]);
  const retry = retrySelection(original, "codex", crypto.randomUUID());
  expect(retry?.selection.models[0]?.subagent).toEqual({
    catalogId: subagent.catalogId,
    credentialId: subagent.credentialId,
  });
  const draft = {
    id: crypto.randomUUID(),
    models: [
      {
        catalogId: "gpt-6-sol",
        credentialId: "managed-model",
        harnesses: ["claude-code"],
        subagent,
      },
    ],
    sandbox: "e2b",
    sandboxCredentialId: "sandbox",
    tasks: [],
  };
  const restored = restoreRunDraft(JSON.stringify({ submitted: false, draft }), null);
  const restoredModel = restored.draft.models[0];
  expect(restoredModel && "subagent" in restoredModel ? restoredModel.subagent : undefined).toEqual(
    {
      catalogId: subagent.catalogId,
      credentialId: subagent.credentialId,
    },
  );
});

test("results and releases keep a model apart from itself with a subagent model", () => {
  const condition = { id: "c0ffee123456", name: "With Skills", skills: ["org/repo"] };
  const alone = run("alone", {}, [passed("task")]);
  const mixed = run("mixed", { subagent }, [passed("task")]);
  // The same subagent model on another credential is the same setting.
  const rerouted = run("rerouted", { subagent: { ...subagent, credentialId: "other" } }, [
    passed("other-task"),
  ]);
  const conditioned = run("conditioned", { subagent, condition }, [passed("task")]);
  const app = configurationsOf([alone, mixed, rerouted, conditioned], credentials, NOW);
  expect(app.map((entry) => [entry.label, entry.condition?.name, entry.latest.length])).toEqual(
    expect.arrayContaining([
      [alone.modelLabel, undefined, 1],
      [`${alone.modelLabel} + DeepSeek V4 Pro Subagents`, undefined, 2],
      [`${alone.modelLabel} + DeepSeek V4 Pro Subagents`, "With Skills", 1],
    ]),
  );
  expect(app).toHaveLength(3);
  expect(new Set(app.map((entry) => entry.key)).size).toBe(3);
  const mixedKey = app.find((entry) => entry.subagent && !entry.condition)?.key ?? "";
  expect(JSON.parse(mixedKey).at(-1)).toBe("subagent:deepseek-v4-pro-0813");
  const conditionedKey = app.find((entry) => entry.condition)?.key ?? "";
  expect(JSON.parse(conditionedKey).slice(-2)).toEqual([
    condition.id,
    "subagent:deepseek-v4-pro-0813",
  ]);
  // A model alone keeps the key it always had.
  expect(JSON.parse(app.find((entry) => !entry.subagent)?.key ?? "[]")).toHaveLength(3);
  const released = [...resultsBySetting([alone, mixed, rerouted]).values()];
  expect(released.map((entry) => entry.setting.label).sort()).toEqual(
    [alone.modelLabel, `${alone.modelLabel} + DeepSeek V4 Pro Subagents`].sort(),
  );
  expect(released.find((entry) => entry.setting.subagent)?.setting).toMatchObject({
    id: expect.stringMatching(/\|subagent:deepseek-v4-pro-0813$/),
    subagent: { catalogId: "deepseek-v4-pro-0813", label: "DeepSeek V4 Pro" },
  });
});
