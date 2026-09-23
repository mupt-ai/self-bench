import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { hasModelSelection, nextModelSelection } from "./model-selection";
import { RunModelRow } from "./RunModelRow";
import { RunModelTable } from "./RunModelTable";

const model: CatalogModel = {
  id: "anthropic-test",
  provider: "anthropic",
  model: "test",
  label: "Test Model",
  harnesses: ["claude-code"],
  source: "",
};
const credential: CredentialInfo = {
  id: "connection",
  name: "Connection",
  kind: "anthropic",
  auth: "api-key",
  createdAt: "2026-09-11T00:00:00Z",
};

test("requested harness chooses a compatible credential and respects login restrictions", () => {
  const openai: CatalogModel = { ...model, provider: "openai" };
  const login: CredentialInfo = { ...credential, kind: "openai", auth: "codex-login" };
  expect(nextModelSelection(openai, [login], "pi")).toBeUndefined();
  expect(
    nextModelSelection(openai, [login, { ...login, id: "api-key", auth: "api-key" }], "pi"),
  ).toEqual({ catalogId: model.id, credentialId: "api-key", harnesses: ["pi"] });
});

test("duplicates match model, effective thinking level, and harness, not credential", () => {
  const astra: CatalogModel = { ...model, id: "gpt-6-astra", provider: "openai" };
  const selection: ComparisonDraft["models"][number] = {
    catalogId: astra.id,
    credentialId: "first",
    harnesses: ["codex"],
  };
  expect(
    hasModelSelection(astra, [selection], {
      ...selection,
      credentialId: "second",
      thinking: "high",
    }),
  ).toBe(true);
  expect(hasModelSelection(astra, [selection], { ...selection, thinking: "low" })).toBe(false);
  expect(hasModelSelection(astra, [selection], { ...selection, harnesses: ["pi"] })).toBe(false);
  expect(hasModelSelection(astra, [selection], { ...selection, catalogId: "other" })).toBe(false);
  expect(hasModelSelection(astra, [{ ...selection, harnesses: ["codex", "pi"] }], selection)).toBe(
    true,
  );
});

test("inline rows expose model, thinking, and harness dropdowns without provider subtitles", () => {
  const selection = nextModelSelection(model, [credential]);
  if (!selection) throw new Error("Expected compatible selection");
  const html = renderToStaticMarkup(
    <RunModelRow
      model={model}
      credentials={[credential]}
      selection={selection}
      onChange={() => {
        throw new Error("Rendering cannot add a model");
      }}
    />,
  );
  expect(html).toContain('aria-label="Test Model Thinking Level"');
  expect(html).toContain('aria-label="Test Model Harness"');
  expect(html).toContain('aria-label="Model"');
  expect(html).not.toContain(">anthropic<");
  expect(html).toContain('value="default" selected=""');
});

test("selection fails without credentials", () => {
  expect(nextModelSelection(model, [])).toBeUndefined();
});

test("selection fails without a compatible provider", () => {
  expect(nextModelSelection(model, [{ ...credential, kind: "openai" }])).toBeUndefined();
});

test("custom endpoints speak the OpenAI protocol and offer its harnesses", () => {
  expect(
    nextModelSelection({ ...model, provider: "custom", harnesses: [] }, [
      { ...credential, kind: "custom" },
    ]),
  ).toEqual({ catalogId: model.id, credentialId: credential.id, harnesses: ["codex"] });
  expect(
    nextModelSelection(
      { ...model, provider: "custom", harnesses: [] },
      [{ ...credential, kind: "custom" }],
      "claude-code",
    ),
  ).toBeUndefined();
});

test("requested Codex needs a gateway credential for an Anthropic model", () => {
  expect(nextModelSelection(model, [credential], "codex")).toBeUndefined();
  expect(
    nextModelSelection(
      model,
      [credential, { ...credential, id: "gateway", kind: "openrouter" }],
      "codex",
    ),
  ).toEqual({ catalogId: model.id, credentialId: "gateway", harnesses: ["codex"] });
});

test("selection skips incompatible credentials and fills the first compatible row", () => {
  expect(
    nextModelSelection(model, [{ ...credential, id: "unmatched", kind: "e2b" }, credential]),
  ).toEqual({ catalogId: model.id, credentialId: credential.id, harnesses: ["claude-code"] });
});

test("selection uses Codex for a compatible login credential", () => {
  expect(
    nextModelSelection({ ...model, provider: "openai" }, [
      { ...credential, kind: "openai", auth: "codex-login" },
    ]),
  ).toEqual({ catalogId: model.id, credentialId: credential.id, harnesses: ["codex"] });
});

test("an empty inline row offers the catalog and disables dependent controls", () => {
  const draft: ComparisonDraft = {
    id: "draft",
    tasks: [],
    models: [{ catalogId: "", credentialId: "", harnesses: [] }],
    sandbox: "e2b",
    sandboxCredentialId: "",
  };
  const html = renderToStaticMarkup(
    <RunModelTable
      models={[model]}
      draft={draft}
      credentials={[credential]}
      onChange={() => {
        throw new Error("Render must not change selection");
      }}
    />,
  );
  expect(html).toContain("Select Model");
  expect(html).toContain("Test Model");
  expect(html.match(/<select[^>]*disabled=""/g)).toHaveLength(3);
  expect(html).not.toContain('role="dialog"');
});
