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

test("any provider's or gateway's API key can call the judge, through the gateway", () => {
  // A sign-in and the platform's managed key never call a judge.
  expect(judgeCredentials(credentials).map((entry) => entry.id)).toEqual([
    "openai",
    "anthropic",
    "router",
  ]);
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
  expect(render(credentials.slice(2, 3))).toContain(
    "None of your credentials can call this judge.",
  );
});
