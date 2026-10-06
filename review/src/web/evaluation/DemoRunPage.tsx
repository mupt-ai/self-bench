import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { Notice, PageContent, PageHeader } from "../ui";
import { RunExecution } from "./RunExecution";
import { RunModelTable } from "./RunModelTable";
import { RunTaskPicker } from "./RunTaskPicker";

const credentials: CredentialInfo[] = [
  {
    id: "demo-openai",
    name: "OpenAI API Key (Demo)",
    kind: "openai",
    auth: "api-key",
    createdAt: "",
  },
  {
    id: "demo-openrouter",
    name: "OpenRouter API Key (Demo)",
    kind: "openrouter",
    auth: "api-key",
    createdAt: "",
  },
  { id: "demo-sandbox", name: "E2B (Demo)", kind: "e2b", auth: "api-key", createdAt: "" },
];
const models: CatalogModel[] = [
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    provider: "openai",
    model: "gpt-6-sol",
    harnesses: ["codex", "pi"],
    source: "",
    gateways: { openrouter: "openai/gpt-6-sol" },
    thinking: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "glm-5.3",
    label: "GLM 5.3",
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    harnesses: ["pi", "codex", "claude-code"],
    source: "",
    gateways: { openrouter: "z-ai/glm-5.3" },
    thinking: ["low", "high", "max"],
  },
];
const sandboxes: HostedSandbox[] = ["e2b", "modal", "daytona"];
const tasks = [
  { runId: "sample-pr-184", taskId: "fix-retry-backoff", difficulty: "medium" },
  { runId: "sample-pr-207", taskId: "preserve-query-state", difficulty: "hard" },
  { runId: "sample-pr-231", taskId: "handle-empty-response", difficulty: "easy" },
  { runId: "sample-pr-248", taskId: "avoid-duplicate-write", difficulty: "hard" },
];

export function DemoRunPage() {
  const [draft, setDraft] = React.useState<ComparisonDraft>({
    id: "00000000-0000-4000-8000-000000000001",
    tasks: tasks.map(({ runId, taskId }) => ({ runId, taskId })),
    models: [
      {
        catalogId: "gpt-6-sol",
        credentialId: "demo-openai",
        harnesses: ["codex"],
        thinking: "high",
      },
      {
        catalogId: "glm-5.3",
        credentialId: "demo-openrouter",
        harnesses: ["pi"],
        thinking: "high",
      },
    ],
    sandbox: "e2b",
    sandboxCredentialId: "demo-sandbox",
  });
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  const pairs = selected.reduce((sum, model) => sum + model.harnesses.length, 0);
  return (
    <PageContent>
      <PageHeader
        className="mb-6"
        title="Run · Demo Repository"
        description="Compare models and harnesses against accepted tasks."
      />
      <Notice className="mb-5">
        Demo mode · Sample data only. You can explore the controls, but no evaluations are
        submitted.
      </Notice>
      <RunTaskPicker
        repo="demo/sample-repository"
        availableTasks={tasks}
        draft={draft}
        tasksReady
        disabled={false}
        readOnly
        onChange={(next) => setDraft({ ...draft, tasks: next })}
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <fieldset className="panel min-w-0 p-0" disabled>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Models and Harnesses</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {draft.models.length} of 12 configurations
              </p>
            </div>
          </div>
          <RunModelTable
            models={[
              ...models,
              {
                id: "custom",
                label: "Custom Model",
                provider: "custom",
                model: "",
                harnesses: ["pi"],
                source: "",
              },
            ]}
            credentials={credentials}
            draft={draft}
            onChange={setDraft}
          />
        </fieldset>
        <RunExecution
          returnTo="/repos/demo/sample-repository/run"
          draft={draft}
          credentials={credentials}
          sandboxes={sandboxes}
          submitted={false}
          busy={false}
          ready={draft.tasks.length > 0 && pairs > 0}
          pairs={pairs}
          readOnly
          onChange={(next) => setDraft(next)}
          onSubmit={() => {}}
          onRunMissing={() => {}}
        />
      </div>
    </PageContent>
  );
}
