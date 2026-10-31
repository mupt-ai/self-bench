import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog } from "../../../../src/evaluation/catalog";
import { harnessIds } from "../../../../src/evaluation/models";
import { subagentSupport } from "../../../../src/evaluation/subagents";
import { resultsBySetting } from "../../../../src/public/release-results";
import { hasModelSelection } from "./model-selection";
import { RunModelRow } from "./RunModelRow";
import { credentials, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { restoreRunDraft } from "./run-draft";
import { retrySelection } from "./run-retry";

const subagent = {
  catalogId: "deepseek-v4-pro-0813",
  model: "openrouter/deepseek/deepseek-v4-pro-0813",
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
    expect(html).toContain('aria-label="Edit Subagent Model"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Managed");
    expect(html).not.toContain('aria-label="Subagent Credential"');
    expect(html).not.toContain("<details");
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
    expect(plain).toContain("does not install a subagent extension");
  },
);

test("every unsupported harness explains why instead of exposing an inert selector", () => {
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

test("secondary credentials on one provider do not create distinct model configurations", () => {
  const model = catalog[0];
  if (!model) throw new Error("Missing model");
  const keys = [
    { id: "router-a", kind: "openrouter" as const },
    { id: "router-b", kind: "openrouter" as const },
    { id: "vercel", kind: "vercel-ai-gateway" as const },
  ];
  const selection = {
    catalogId: model.id,
    credentialId: "router-a",
    harnesses: ["codex" as const],
    subagent: { catalogId: subagent.catalogId, credentialId: "router-a" },
  };
  expect(
    hasModelSelection(
      model,
      [selection],
      { ...selection, subagent: { ...selection.subagent, credentialId: "router-b" } },
      keys,
    ),
  ).toBe(true);
  expect(
    hasModelSelection(
      model,
      [selection],
      { ...selection, subagent: { ...selection.subagent, credentialId: "vercel" } },
      keys,
    ),
  ).toBe(false);
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

test("results and public releases never merge parent-only and subagent configurations", () => {
  const parent = run("parent", {}, [passed("task")]);
  const child = run("child", { subagent }, [passed("task")]);
  const app = configurationsOf([parent, child], credentials, NOW);
  const publicSettings = [...resultsBySetting([parent, child]).values()];
  expect(app).toHaveLength(2);
  expect(publicSettings).toHaveLength(2);
  expect(app.some((entry) => entry.label.includes("Subagents:"))).toBe(true);
  expect(publicSettings.some((entry) => entry.setting.label.includes(subagent.model))).toBe(true);
});
