import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { measureTrial } from "../../src/evaluation/gateway-cost.js";
import { initialEvaluation } from "../../src/evaluation/store.js";
import { readTrialKey } from "../../src/gateway/trial-key.js";
import { gatewayModelPrice } from "../../src/gateways/catalog.js";
import { evaluationInput } from "../support/evaluation-fixture.js";
import { messages, ORG, responses, SECRET, startTrialApi } from "../support/gateway-trial-api.js";
import { VAULT_SECRETS } from "../support/gateway-upstream.js";

// A run with a subagent model, end to end (support/gateway-trial-api.ts): Claude Opus orchestrates
// on an Anthropic key and its subagents call DeepSeek on an OpenRouter key, both through the
// gateway under one trial key. Each call is priced at its own model, and the trial's cost is the
// gateway's total for the two.

const OPUS = "anthropic/claude-opus-5-5";
const DEEPSEEK = "openrouter/deepseek/deepseek-v3.2";
const mixed = {
  model: OPUS,
  subagent: { credential: "openrouter", model: DEEPSEEK, thinking: "high" },
} as const;
/** Opus's list price for the stand-in's reply: 8 tokens in and 3 out. */
const opusCall =
  8 * (gatewayModelPrice(OPUS)?.input ?? Number.NaN) * 1e-6 +
  3 * (gatewayModelPrice(OPUS)?.output ?? Number.NaN) * 1e-6;
/** What the stand-in's OpenRouter says it charged for a call (`usage.cost`). */
const DEEPSEEK_CALL = 0.0123;

describe("a trial whose subagents run on another model", () => {
  let api: Awaited<ReturnType<typeof startTrialApi>>;
  beforeAll(async () => {
    api = await startTrialApi();
  });
  afterAll(() => api.close());

  test("Opus with DeepSeek subagents on Claude Code costs the gateway's total for both", async () => {
    const tag = "trial-opus-deepseek";
    const { trial, connection, input } = api.trialFor("claude-code", "anthropic", tag, mixed);
    const env = trial.child;
    // The key serves exactly the two models, each on its own credential, and the adapter is told
    // which model Claude Code's subagents ask for.
    expect(readTrialKey(connection.key, SECRET)).toMatchObject({
      model: OPUS,
      credentialId: api.ids.anthropic,
      subagent: { model: DEEPSEEK, credentialId: api.ids.openrouter, thinking: "high" },
    });
    expect(trial.model).toBe(`dari/model/${OPUS}`);
    expect(trial.agentArguments).toContain(`subagent_model=dari/model/${DEEPSEEK}`);
    expect(JSON.stringify(trial)).not.toContain(VAULT_SECRETS.openrouter);

    api.upstream.calls.length = 0;
    // Two orchestrator turns, then a subagent's turn: Claude Code sends it to the same gateway
    // with the same key, naming the subagent model and the effort it runs its own model at,
    // which DeepSeek does not have.
    for (const _turn of [1, 2]) {
      const own = await messages(env, trial.model);
      expect(own.status).toBe(200);
      expect(await own.text()).toContain("served by claude-opus-5-5");
    }
    const delegated = await messages(env, `dari/model/${DEEPSEEK}`, true, {
      thinking: { type: "enabled", budget_tokens: 32_000 },
      output_config: { effort: "max" },
    });
    expect({ status: delegated.status, text: await delegated.text() }).toMatchObject({
      status: 200,
      text: expect.stringContaining("served by deepseek/deepseek-v3.2"),
    });
    // Each model was reached on its own credential, the subagent's on OpenRouter's wire.
    expect(api.upstream.calls).toEqual([
      expect.objectContaining({ path: "/v1/messages", xApiKey: VAULT_SECRETS.anthropic }),
      expect.objectContaining({ path: "/v1/messages", xApiKey: VAULT_SECRETS.anthropic }),
      // DeepSeek has no `max`: the call is served at the level the key pins DeepSeek to.
      expect.objectContaining({
        path: "/api/v1/chat/completions",
        model: "deepseek/deepseek-v3.2",
        authorization: `Bearer ${VAULT_SECRETS.openrouter}`,
        effort: "high",
      }),
    ]);
    const rows = await api.usageRows(tag, 3);
    expect(api.failures).toEqual([]);
    // A third model is refused before any provider is called.
    const other = await messages(env, "dari/model/openrouter/openai/gpt-4o-mini");
    expect(other.status).toBe(400);
    expect(await other.text()).toContain("not enabled");
    expect(api.upstream.calls).toHaveLength(3);
    api.failures.length = 0;
    const subagentRows = rows.filter((row) => row.tags.subagent === "true");
    expect(subagentRows).toHaveLength(1);
    expect(subagentRows[0]).toMatchObject({
      model: DEEPSEEK,
      credentialId: api.ids.openrouter,
      costSource: "provider",
      tags: { trial: tag, harness: "claude-code" },
    });
    expect(subagentRows[0]?.costUsd).toBeCloseTo(DEEPSEEK_CALL, 9);
    for (const row of rows.filter((row) => row.tags.subagent !== "true")) {
      expect(row).toMatchObject({ model: OPUS, credentialId: api.ids.anthropic });
      expect(row.costUsd).toBeCloseTo(opusCall, 9);
    }

    // The trial's cost is that total, whatever its transcript would estimate: Harbor's Claude
    // Code trajectory here prices every call as Opus's and reports $99.
    const total = 2 * opusCall + DEEPSEEK_CALL;
    expect((await api.store.trialCost(ORG, tag))?.costUsd).toBeCloseTo(total, 9);
    const run = {
      ...initialEvaluation({ ...evaluationInput(), ...input, harnesses: ["claude-code"] }, "Opus"),
      id: "run-e2e",
    };
    const trajectory = {
      agent: { model_name: trial.model },
      steps: [1, 2, 3].map((step) => ({
        step_id: step,
        source: "agent",
        model_name: step === 3 ? `dari/model/${DEEPSEEK}` : trial.model,
        metrics: { prompt_tokens: 8, completion_tokens: 3, cached_tokens: 0, cost_usd: 33 },
      })),
    };
    const measure = (billed: "api-key" | "claude-login") =>
      measureTrial(
        // The trial's tag is `<run>/<index>`; this one's was written out above.
        { ...run, id: "trial-opus" },
        { ...run.trials[0], harness: "claude-code" } as (typeof run.trials)[number],
        Number.NaN,
        {
          records: new Map([["solver/t/agent/trajectory.json", JSON.stringify(trajectory)]]),
          result: {
            agent_result: {
              n_input_tokens: 24,
              n_output_tokens: 9,
              n_cache_tokens: 0,
              cost_usd: 99,
            },
          },
          child: {},
        },
        {
          modelAuth: billed,
          subagentAuth: "api-key",
          gateway: {
            at: {
              api: { url: "", secret: "" },
              usage: {
                trialCost: (orgId) => api.store.trialCost(orgId, tag),
                trialModels: (orgId) => api.store.trialModels(orgId, tag),
              },
            },
            orgId: ORG,
          },
        },
      );
    const measured = await measure("api-key");
    expect(measured.apiCostUsd).toBeCloseTo(total, 9);
    expect(measured).toMatchObject({
      billedCostUsd: measured.apiCostUsd,
      costSource: "gateway",
      // The gateway served Opus and nothing but DeepSeek beside it.
      modelVerified: true,
      tokenUsage: { input: 24, output: 9, cacheRead: 0, cacheWrite: 0 },
      subagentCalls: 1,
    });
    // On a Claude sign-in the orchestrator's share was a plan's, so the total is not a bill.
    const planned = await measure("claude-login");
    expect(planned.apiCostUsd).toBeCloseTo(total, 9);
    expect(planned.billedCostUsd).toBeUndefined();
  });

  test("Codex's subagents reach the subagent model over Responses", async () => {
    const tag = "trial-codex-deepseek";
    const { trial } = api.trialFor("codex", "openai", tag, {
      model: "openai/gpt-6-luna",
      subagent: { credential: "openrouter", model: DEEPSEEK },
    });
    expect(trial.agentArguments).toContain(`subagent_model=dari/model/${DEEPSEEK}`);
    const delegated = await responses(trial.child, `dari/model/${DEEPSEEK}`);
    expect({ status: delegated.status, text: await delegated.text() }).toMatchObject({
      status: 200,
      text: expect.stringContaining("served by deepseek/deepseek-v3.2"),
    });
    const [row] = await api.usageRows(tag, 1);
    expect(row).toMatchObject({ model: DEEPSEEK, tags: { subagent: "true", harness: "codex" } });
    expect(row?.costUsd).toBeCloseTo(DEEPSEEK_CALL, 9);
    expect(await api.store.trialModels(ORG, tag)).toEqual([
      { model: DEEPSEEK, calls: 1, input: 8, output: 3, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  test("subagents on the run's own credential are served at the subagent model's own level", async () => {
    // Opus with Sonnet subagents on one Anthropic key. Claude Code asks its subagents' model for
    // the effort it runs Opus at, and for no thinking on its side calls; the gateway serves
    // Sonnet at the level the key pins it to either way.
    const tag = "trial-opus-sonnet";
    const { trial } = api.trialFor("claude-code", "anthropic", tag, {
      model: OPUS,
      subagent: { credential: "anthropic", model: "anthropic/claude-sonnet-5-5", thinking: "high" },
    });
    api.upstream.calls.length = 0;
    for (const asked of [
      { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
      { thinking: { type: "disabled" } },
    ]) {
      const reply = await messages(
        trial.child,
        "dari/model/anthropic/claude-sonnet-5-5",
        true,
        asked,
      );
      expect({ status: reply.status, text: await reply.text() }).toMatchObject({ status: 200 });
    }
    expect(api.upstream.calls).toEqual([
      expect.objectContaining({ model: "claude-sonnet-5-5", effort: "high" }),
      expect.objectContaining({ model: "claude-sonnet-5-5", effort: "high" }),
    ]);
    const rows = await api.usageRows(tag, 2);
    expect(rows.map((row) => [row.credentialId, row.tags.subagent])).toEqual([
      [api.ids.anthropic, "true"],
      [api.ids.anthropic, "true"],
    ]);
  });
});
