import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { judgeEnvironment } from "../../src/evaluation/judge.js";
import {
  CREDENTIALS,
  messages,
  ORG,
  responses,
  startTrialApi,
} from "../support/gateway-trial-api.js";
import { VAULT_SECRETS } from "../support/gateway-upstream.js";

// A task's LLM judge on the trial's own key, and what the gateway refuses it
// (support/gateway-trial-api.ts).

describe("a judged trial's path through the gateway", () => {
  let api: Awaited<ReturnType<typeof startTrialApi>>;
  beforeAll(async () => {
    api = await startTrialApi();
  });
  afterAll(() => api.close());

  test("a judge calls any model of its credential's provider on the trial's key, apart from the solver", async () => {
    const tag = "trial-judged";
    const judge = { credentialId: api.ids.anthropic, provider: "anthropic" };
    const { trial, connection } = api.trialFor("codex", "openai", tag, judge);
    // The judge reads the same key and gateway the solver does, under every judge variable.
    const judgeEnv = judgeEnvironment(connection);
    expect(judgeEnv.OPENAI_API_KEY).toBe(trial.child.OPENAI_API_KEY);
    expect(judgeEnv.OPENAI_BASE_URL).toBe(trial.child.OPENAI_BASE_URL);
    api.upstream.calls.length = 0;
    // A judge names its model as Anthropic's own API would; the gateway serves it on the judge's key.
    const judged = await messages(judgeEnv, "claude-sonnet-5-5", false);
    expect(judged.status).toBe(200);
    expect(await judged.text()).toContain("served by claude-sonnet-5-5");
    expect(api.upstream.calls).toEqual([
      expect.objectContaining({ path: "/v1/messages", xApiKey: VAULT_SECRETS.anthropic }),
    ]);
    // The solver's own model still answers on the solver's key.
    const solved = await responses(trial.child, trial.model.replace(/^openai\//, ""));
    expect(solved.status).toBe(200);
    await solved.text();
    // No other provider's models: the grant names Anthropic alone.
    api.upstream.calls.length = 0;
    const other = await responses(judgeEnv, "gpt-6-sol");
    expect(other.status).toBe(400);
    await other.text();
    expect(api.upstream.calls).toEqual([]);
    // The judge's call is its credential's, tagged apart, and outside the trial's cost; the refused
    // call used no tokens and costs nothing.
    const rows = await api.usageRows(tag, 3);
    expect(rows.find((row) => row.tags.judge === "true")).toMatchObject({
      credentialId: api.ids.anthropic,
      model: "anthropic/claude-sonnet-5-5",
      status: "completed",
    });
    expect(await api.store.trialCost(ORG, tag)).toEqual({
      costUsd: expect.closeTo(8 * 0.1e-6 + 3 * 0.5e-6, 9),
      complete: true,
    });
  });

  test("a request for any model but the pinned one is refused before the provider is called", async () => {
    const { trial } = api.trialFor("codex", "openai", "trial-refusal");
    api.upstream.calls.length = 0;
    const other = await responses(trial.child, `dari/model/${CREDENTIALS.anthropic.model}`);
    expect(other.status).toBe(400);
    await other.text();
    expect(api.upstream.calls).toEqual([]);
    // The refused call is still recorded against the trial, with no tokens or cost.
    const [refused] = await api.usageRows("trial-refusal", 1);
    expect(refused).toMatchObject({ status: "selector_error", inputTokens: null, costUsd: null });
  });
});
