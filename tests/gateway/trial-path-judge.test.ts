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

  test("a judge calls any model of its provider under its own key, apart from the model under test", async () => {
    const tag = "trial-judged";
    const { trial } = api.trialFor("codex", "openai", tag);
    const judgeConnection = api.judgeFor(
      { credentialId: api.ids.anthropic, provider: "anthropic" },
      tag,
    );
    // The judge reaches the same gateway, but under a key of its own.
    const judgeEnv = judgeEnvironment(judgeConnection);
    expect(judgeEnv.OPENAI_BASE_URL).toBe(trial.child.OPENAI_BASE_URL);
    expect(judgeEnv.OPENAI_API_KEY).not.toBe(trial.child.OPENAI_API_KEY);
    api.upstream.calls.length = 0;
    // A judge names its model as Anthropic's own API would; the gateway serves it on the judge's key.
    const judged = await messages(judgeEnv, "claude-sonnet-5-5", false);
    expect(judged.status).toBe(200);
    expect(await judged.text()).toContain("served by claude-sonnet-5-5");
    expect(api.upstream.calls).toEqual([
      expect.objectContaining({ path: "/v1/messages", xApiKey: VAULT_SECRETS.anthropic }),
    ]);
    // The model under test still answers on its own key.
    const solved = await responses(trial.child, trial.model.replace(/^openai\//, ""));
    expect(solved.status).toBe(200);
    await solved.text();
    // No other provider's models: the judge's grant names Anthropic alone.
    api.upstream.calls.length = 0;
    const other = await responses(judgeEnv, "gpt-6-sol");
    expect(other.status).toBe(400);
    await other.text();
    // A bare model name on the solver's key is refused; it never reaches the judge's credential.
    const bare = await messages(
      {
        ANTHROPIC_BASE_URL: judgeEnv.ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY: trial.child.OPENAI_API_KEY,
      },
      "claude-sonnet-5-5",
      false,
    );
    expect(bare.status).toBe(400);
    await bare.text();
    expect(api.upstream.calls).toEqual([]);
    // The judge's call is its credential's, tagged apart, and outside the trial's cost; refused
    // calls used no tokens and cost nothing.
    // The bare name refused on the solver's key is the solver's, never the judge's.
    const rows = await api.usageRows(tag, 3);
    const role = (row: (typeof rows)[number]) => ({
      model: row.model,
      status: row.status,
      judge: row.tags.judge === "true",
      credentialId: row.credentialId,
    });
    expect(rows.map(role)).toEqual(
      expect.arrayContaining([
        {
          model: "anthropic/claude-sonnet-5-5",
          status: "completed",
          judge: true,
          credentialId: api.ids.anthropic,
        },
        {
          model: "openai/gpt-6-luna",
          status: "completed",
          judge: false,
          credentialId: api.ids.openai,
        },
        {
          model: "openai/gpt-6-luna",
          status: "selector_error",
          judge: false,
          credentialId: api.ids.openai,
        },
      ]),
    );
    expect(rows).toHaveLength(3);
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
