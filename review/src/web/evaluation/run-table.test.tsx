import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialEditor } from "./CredentialEditor";
import { RunModelTable } from "./RunModelTable";

test("model table remains visible without credentials and never embeds secret fields", () => {
  const html = renderToStaticMarkup(
    <RunModelTable
      models={[
        {
          id: "test",
          label: "Test model",
          provider: "openai",
          model: "test",
          harnesses: ["codex"],
          source: "",
        },
      ]}
      credentials={[]}
      draft={{ id: "draft", tasks: [], models: [], sandbox: "e2b", sandboxCredentialId: "" }}
      onChange={() => {
        throw new Error("Render must not change selection");
      }}
    />,
  );
  expect(html).toContain("Test model");
  expect(html).toContain("Select Credential");
  expect(html).toContain("Credential / Route");
  expect(html).toContain("Model Default");
  expect(html).toContain('aria-label="Test model Credential"');
  expect(html).toContain('aria-label="Test model Thinking Level"');
  expect(html).toContain("Harnesses");
  expect(html).not.toContain("Shortlist");
  expect(html).not.toContain('type="password"');
});

test("credential editor is separate and offers only supported providers and hosted sandboxes", () => {
  const html = renderToStaticMarkup(
    <CredentialEditor
      org="mupt-ai"
      onSaved={async () => {
        throw new Error("Render must not finish sign-in");
      }}
      onSave={async () => {
        throw new Error("Render must not save a credential");
      }}
      onCancel={() => {
        throw new Error("Render must not cancel");
      }}
    />,
  );
  expect(html).toContain("Model API Key");
  expect(html).toContain("Add Credential");
  expect(html).toContain("Provider or Sandbox");
  expect(html).toContain("Save Credential");
  expect(html).toContain('type="password"');
  expect(html).toContain("OpenRouter");
  expect(html).not.toContain("Docker");
  expect(html).not.toContain("OpenBao");
});
