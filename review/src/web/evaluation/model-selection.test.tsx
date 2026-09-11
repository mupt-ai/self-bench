import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { nextModelSelection } from "./model-selection";
import { RunModelPicker } from "./RunModelPicker";

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

test("selection fails without credentials", () => {
  expect(nextModelSelection(model, [])).toBeUndefined();
});

test("selection fails without a compatible provider", () => {
  expect(nextModelSelection(model, [{ ...credential, kind: "openai" }])).toBeUndefined();
});

test("selection fails without a compatible harness", () => {
  expect(
    nextModelSelection({ ...model, provider: "custom", harnesses: [] }, [
      { ...credential, kind: "custom" },
    ]),
  ).toBeUndefined();
});

test("selection rejects a login credential when the route has no Codex harness", () => {
  expect(nextModelSelection(model, [{ ...credential, auth: "codex-login" }])).toBeUndefined();
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

test.each([false, true])("picker enables models only with a matching connection: %s", (matched) => {
  const draft: ComparisonDraft = {
    id: "draft",
    tasks: [],
    models: [],
    sandbox: "e2b",
    sandboxCredentialId: "",
  };
  const html = renderToStaticMarkup(
    <RunModelPicker
      picking
      visible={[model]}
      draft={draft}
      credentials={matched ? [credential] : []}
      query=""
      setQuery={() => {}}
      setPicking={() => {}}
      state={{ draft, submitted: false }}
      setState={() => {
        throw new Error("Render must not change selection");
      }}
    />,
  );
  const button = html.match(/<button\b[^>]*><span>Test Model<\/span>/)?.[0];
  expect(button).toBeDefined();
  expect(button?.includes('disabled=""')).toBe(!matched);
});
