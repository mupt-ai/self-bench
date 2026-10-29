import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog } from "../../../../src/evaluation/catalog";
import { resultsBySetting } from "../../../../src/public/release-results";
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

test("Claude Code exposes a separate optional subagent model and credential", () => {
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
        harnesses: ["claude-code"],
        subagent,
      }}
      onChange={() => {}}
    />,
  );
  expect(html).toContain("Override Subagent Model");
  expect(html).toContain('aria-label="Subagent Credential"');
  expect(html).toContain("does not force delegation");
  const plain = renderToStaticMarkup(
    <RunModelRow
      model={model}
      credentials={[credential]}
      selection={{ catalogId: model.id, credentialId: credential.id, harnesses: ["pi"] }}
      onChange={() => {}}
    />,
  );
  expect(plain).not.toContain("Override Subagent Model");
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
