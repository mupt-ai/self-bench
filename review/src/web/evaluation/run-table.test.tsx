import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import { thinkingLevels } from "../../../../src/evaluation/model-options";
import { CredentialEditor } from "./CredentialEditor";
import { CredentialGroup } from "./CredentialGroup";
import { RunModelRow } from "./RunModelRow";
import { RunModelTable } from "./RunModelTable";
import { thinkingLabel } from "./run-presentation";

test("thinking levels use lowercase in selectors and run summaries", () => {
  const html = renderToStaticMarkup(
    <RunModelRow
      model={{
        id: "openai-astra6",
        label: "GPT-6 Astra",
        provider: "openai",
        model: "gpt-6-astra",
        harnesses: ["codex"],
        source: "",
      }}
      credentials={[]}
      onChange={() => {}}
    />,
  );
  const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)];
  const levels = options.filter((option) => thinkingLevels.some((level) => level === option[1]));
  expect(levels.map((option) => option[2])).toEqual(["low", "medium", "high", "xhigh", "max"]);
  for (const level of thinkingLevels) {
    expect(thinkingLabel(level)).toBe(level === "default" ? "model default" : level);
  }
});

test("model cards remain usable without credentials and never embed a table or secret fields", () => {
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
      draft={{
        id: "draft",
        tasks: [],
        models: [{ catalogId: "test", credentialId: "", harnesses: [] }],
        sandbox: "e2b",
        sandboxCredentialId: "",
      }}
      onChange={() => {
        throw new Error("Render must not change selection");
      }}
    />,
  );
  expect(html).toContain("Test model");
  expect(html).toContain('aria-label="Model"');
  expect(html).not.toContain(">openai<");
  expect(html).not.toContain("<table");
  expect(html).toContain("Select Credential");
  expect(html).toContain("Credential");
  expect(html).toContain('value="default" selected="">default</option>');
  expect(html).toContain('aria-label="Test model Credential"');
  expect(html).toContain('aria-label="Test model Thinking Level"');
  expect(html).toContain("Harness");
  expect(html).toContain("Reasoning");
  expect(html).toContain("sm:grid-cols-3");
  expect(html).not.toContain("border-transparent!");
  expect(html).toContain('aria-label="Remove Test model"');
  expect(html).toContain("right-0 bottom-3 flex h-9 w-10");
  expect(html).toContain("border-0 bg-transparent p-0");
  expect(html).not.toContain("Shortlist");
  expect(html).not.toContain('type="password"');
});

function credentialEditor(kind?: CredentialInfo["kind"], previous?: CredentialInfo) {
  return renderToStaticMarkup(
    <CredentialEditor
      org="mupt-ai"
      kind={kind}
      previous={previous}
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
}

function options(html: string) {
  return [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
}

test("Add Provider offers only model providers and keeps secrets hidden", () => {
  const html = credentialEditor();
  expect(html).toContain("API Key");
  expect(html).toContain("Add Provider");
  expect(html).toContain("Save");
  expect(html).toContain('type="password"');
  expect(options(html)).toEqual(["openai", "anthropic", "openrouter", "custom"]);
});

test.each([false, true])(
  "credential add actions match the small plus-button style: %s",
  (sandbox) => {
    const html = renderToStaticMarkup(
      <CredentialGroup
        title="Credentials"
        credentials={[]}
        loading={false}
        canManage
        sandbox={sandbox}
        onAdd={() => {}}
        onReplace={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain(sandbox ? "Add Sandbox" : "Add Provider");
    expect(html).toContain("h-8 px-3 text-xs");
    expect(html).toContain("mr-1 h-4 w-4");
  },
);

test("Add Sandbox offers only hosted sandboxes and the fields for its selected sandbox", () => {
  const html = credentialEditor("modal");
  expect(html).toContain("Add Sandbox");
  expect(html).toContain("Modal Token ID");
  expect(html).toContain("Modal Token Secret");
  expect(options(html)).toEqual(["e2b", "modal", "daytona", "vercel"]);
  expect(html).not.toContain("ChatGPT Sign-In");
});

test("replacement keeps the original credential category regardless of the default kind", () => {
  const previous: CredentialInfo = {
    id: "credential",
    name: "Team",
    kind: "e2b",
    auth: "api-key",
    createdAt: "2026-09-09T00:00:00Z",
  };
  const sandbox = credentialEditor(undefined, previous);
  expect(sandbox).toContain("Replace Credential");
  expect(options(sandbox)).toEqual(["e2b", "modal", "daytona", "vercel"]);
  const provider = credentialEditor("modal", { ...previous, kind: "anthropic" });
  expect(options(provider)).toEqual(["openai", "anthropic", "openrouter", "custom"]);
});

test("harness dropdown keeps the static five options even with a ChatGPT credential", () => {
  const html = renderToStaticMarkup(
    <RunModelRow
      model={{
        id: "openai-astra6",
        label: "GPT-6 Astra",
        provider: "openai",
        model: "gpt-6-astra",
        harnesses: ["codex", "pi"],
        source: "",
      }}
      credentials={[
        { id: "login", name: "ChatGPT", kind: "openai", auth: "codex-login" } as CredentialInfo,
      ]}
      selection={{ catalogId: "openai-astra6", credentialId: "login", harnesses: [] }}
      onChange={() => {}}
    />,
  );
  expect(html).toContain('value="codex"');
  expect(html).not.toContain("Already Added");
  for (const harness of ["codex", "claude-code", "pi", "mini-swe-agent", "terminus-2"]) {
    expect(html).toContain(`value="${harness}"`);
  }
});
