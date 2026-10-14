import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { judgeCredentials, RunJudgePanel } from "./RunJudgePanel";

const credentials = [
  { id: "openai", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: "" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", auth: "api-key", createdAt: "" },
  { id: "claude", name: "Claude Sign-In", kind: "anthropic", auth: "claude-login", createdAt: "" },
  { id: "router", name: "OpenRouter", kind: "openrouter", auth: "api-key", createdAt: "" },
  { id: "managed-model", name: "Managed", kind: "openrouter", auth: "api-key", createdAt: "" },
] as CredentialInfo[];

test("only API keys that give every judge variable can call the judge", () => {
  // A sign-in and the platform's managed key never call a judge.
  const anthropic = { variables: ["ANTHROPIC_API_KEY"], required: ["ANTHROPIC_API_KEY"] };
  expect(judgeCredentials(credentials, anthropic).map((entry) => entry.id)).toEqual([
    "anthropic",
    "router",
  ]);
  expect(
    judgeCredentials(credentials, {
      variables: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      required: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    }).map((entry) => entry.id),
  ).toEqual(["openai", "router"]);
  // A judge with only optional keys still needs a credential that gives one of them.
  expect(
    judgeCredentials(credentials, { variables: ["ANTHROPIC_API_KEY"], required: [] }).map(
      (entry) => entry.id,
    ),
  ).toEqual(["anthropic", "router"]);
});

test("the judge panel says what the judge reads, and offers the keys that can call it", () => {
  const render = (available: CredentialInfo[]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <RunJudgePanel
          pages="/benchmarks/law/lab"
          needs={{ variables: ["ANTHROPIC_API_KEY"], required: ["ANTHROPIC_API_KEY"] }}
          credentials={available}
          value={undefined}
          onChange={() => {}}
          disabled={false}
        />
      </MemoryRouter>,
    );
  const html = render(credentials);
  expect(html).toContain("LLM Judge");
  expect(html).toContain("ANTHROPIC_API_KEY");
  expect(html).toContain('<option value="anthropic">Anthropic</option>');
  expect(html).not.toContain("Claude Sign-In");
  expect(render(credentials.slice(0, 1))).toContain(
    "None of your credentials can call this judge.",
  );
});
