import { expect, test } from "bun:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { credentialSchema } from "../src/db/credentials.js";
import { catalog } from "../src/evaluation/catalog.js";
import { credentialExecution } from "../src/evaluation/execution.js";
import {
  allowedHosts,
  gatewayModelId,
  gatewayTrial,
  piGatewayModels,
  pinnedThinking,
  trialRoute,
} from "../src/evaluation/gateway-trial.js";
import { harnessIds, modelRoutes, openHarnesses, routeFor } from "../src/evaluation/models.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { isGateway } from "../src/gateways/index.js";
import { credentialedInput } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";

function input(provider: string, modelName: string, thinking?: string): EvaluationInput {
  return {
    modelName,
    ...(thinking ? { thinking } : {}),
    credentials: { provider, auth: "api-key", modelCredentialId: CREDENTIAL },
  } as EvaluationInput;
}

test("every API key and ChatGPT or Claude sign-in takes the gateway; Dari's router on Pi and Muse Code stay direct", () => {
  const signIn = (provider: string, auth: string) =>
    ({ modelName: `${provider}/model`, credentials: { provider, auth } }) as EvaluationInput;
  const meta = input("meta", "meta/muse-spark-1.3", "high");
  for (const harness of ["codex", "claude-code", "pi", "mini-swe-agent"] as const)
    expect(trialRoute(meta, harness)).toBe("gateway");
  expect(trialRoute(signIn("openai", "codex-login"), "codex")).toBe("gateway");
  expect(trialRoute(signIn("anthropic", "claude-login"), "claude-code")).toBe("gateway");
  expect(trialRoute(signIn("meta", "muse-login"), "muse-code")).toBe("direct");
  expect(trialRoute(input("dari", "dari/routing"), "pi")).toBe("direct");
  expect(trialRoute(input("custom", "openai/dari/routing"), "pi")).toBe("direct");
  // A custom endpoint serving Dari's router is a custom endpoint to every other harness.
  expect(trialRoute(input("custom", "openai/dari/routing"), "codex")).toBe("gateway");
  expect(trialRoute(meta, "muse-code")).toBe("direct");
  // A gateway trial without its connection never falls back to a direct call.
  expect(() => gatewayTrial(meta, "codex", meta.modelName, {})).toThrow(/connection is missing/);
  // Muse Code keeps Meta's key, endpoint and bare model name.
  const env = { PATH: "/bin", META_API_KEY: "meta-key" };
  expect(gatewayTrial(meta, "muse-code", meta.modelName, env)).toEqual({
    model: "meta/muse-spark-1.3",
    agent: "harbor_muse:SelfBenchMuseCode",
    agentArguments: ["--agent-kwarg", "reasoning_effort=high"],
    child: env,
    extraAllowedHosts: ["api.meta.ai"],
  });
  const dari = input("custom", "openai/dari/routing");
  const endpoint = { OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://models.example/v1" };
  expect(gatewayTrial(dari, "pi", dari.modelName, endpoint)).toMatchObject({
    agent: "harbor_dari:DariPi",
    agentArguments: ["--agent-kwarg", "model_api=openai-completions"],
    extraAllowedHosts: ["models.example"],
  });
});

test("the gateway pins the run's level for every harness but Claude Code", () => {
  for (const harness of harnessIds)
    expect(pinnedThinking(harness, "xhigh")).toBe(harness === "claude-code" ? undefined : "xhigh");
  expect(pinnedThinking("codex", "default")).toBeUndefined();
  expect(pinnedThinking("codex")).toBeUndefined();
  expect(gatewayModelId(input("custom", "openai/acme/coder-2"))).toBe("custom/acme/coder-2");
  expect(gatewayModelId(input("openrouter", "openrouter/z-ai/glm-5.3"))).toBe(
    "openrouter/z-ai/glm-5.3",
  );
});

test("gateway Pi takes the model's context window and output limit from the model catalog", () => {
  const known = getBuiltinModels("anthropic").find((model) => model.contextWindow > 128_000);
  if (!known) throw new Error("Missing Pi catalog fixture");
  const trialInput = input("anthropic", `anthropic/${known.id}`);
  const connection = { openAiBase: "https://gateway/v1" };
  expect(piGatewayModels(trialInput, connection)).toEqual({
    providers: {
      selfbench: {
        baseUrl: "https://gateway/v1",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        models: [
          {
            id: `dari/model/anthropic/${known.id}`,
            name: known.name,
            input: known.input,
            contextWindow: known.contextWindow,
            maxTokens: known.maxTokens,
          },
        ],
      },
    },
  });
  // A model no catalog describes takes Pi's defaults.
  const custom = piGatewayModels(input("custom", "openai/acme-coder"), connection);
  expect(custom).toMatchObject({
    providers: { selfbench: { models: [{ id: "dari/model/custom/acme-coder" }] } },
  });
  expect(JSON.stringify(custom)).not.toContain("contextWindow");
});

test("gateways and Meta keys offer every harness they speak; OpenAI and Anthropic keys their protocol's", () => {
  for (const entry of catalog) {
    for (const route of modelRoutes(entry)) {
      if (isGateway(route.provider))
        expect(new Set(route.harnesses)).toEqual(new Set(openHarnesses));
      else if (route.provider === "meta")
        expect(new Set(route.harnesses)).toEqual(new Set(harnessIds));
      // OpenAI serves no Anthropic Messages, and Anthropic no Responses.
      else
        expect(route.harnesses).not.toContain(
          route.provider === "openai" ? "claude-code" : "codex",
        );
    }
  }
  const model = catalog.find((entry) => entry.id === "gpt-6-sol");
  if (!model) throw new Error("Missing model fixture");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("claude-code");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("mini-swe-agent");
  expect(routeFor(model, "vercel-ai-gateway")?.harnesses).toContain("claude-code");
  expect(routeFor(model, "openai")?.harnesses).not.toContain("claude-code");
  const anthropic = catalog.find((entry) => entry.id === "claude-opus-5-5");
  if (!anthropic) throw new Error("Missing model fixture");
  expect(routeFor(anthropic, "anthropic")?.harnesses).not.toContain("codex");
  expect(routeFor(model, "vercel")).toBeUndefined();
  expect(
    credentialSchema.parse({ name: "Gateway", kind: "openrouter", value: "test-key" }).kind,
  ).toBe("openrouter");
  expect(() =>
    credentialSchema.parse({
      name: "Gateway",
      kind: "openrouter",
      value: "test-key",
      endpoint: "https://wrong.example",
    }),
  ).toThrow();
});

test("a Meta key stays in the vault for the gateway, and reaches only Muse Code directly", async () => {
  const vault = memoryVault();
  const meta = await vault.credentials.create(
    1,
    { name: "Meta", kind: "meta", auth: "api-key", value: "meta-secret" },
    {},
  );
  const trialInput = await credentialedInput(vault, (draft) => {
    draft.modelName = "meta/muse-spark-1.3";
    draft.harnesses = ["muse-code", "codex"];
    if (draft.credentials) {
      draft.credentials.modelCredentialId = meta.id;
      draft.credentials.provider = "meta";
    }
  });
  const muse = await credentialExecution(trialInput, "/home", {}, vault, "muse-code");
  expect(muse.route).toBe("direct");
  expect(muse.child.META_API_KEY).toBe("meta-secret");
  expect(muse.secrets).toContain("meta-secret");
  const codex = await credentialExecution(trialInput, "/home", {}, vault, "codex");
  expect(codex.route).toBe("gateway");
  expect(JSON.stringify(codex)).not.toContain("meta-secret");
  // Building task images calls no model, so it gets no model credential at all.
  const prepare = await credentialExecution(trialInput, "/home", {}, vault);
  expect(prepare.route).toBeUndefined();
  expect(JSON.stringify(prepare)).not.toContain("meta-secret");
});

test("a judge on any route lets the sandbox reach the gateway it calls", () => {
  const dari = input("custom", "openai/dari/routing");
  const judge = { host: "api.selfbench.test" };
  const endpoint = { OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://models.example/v1" };
  const direct = gatewayTrial(dari, "pi", dari.modelName, endpoint);
  expect(allowedHosts(direct, judge)).toEqual(["models.example", "api.selfbench.test"]);
  expect(allowedHosts(direct)).toEqual(["models.example"]);
  // A gateway trial already allows the gateway's host: the judge's adds no second entry.
  expect(allowedHosts({ extraAllowedHosts: ["api.selfbench.test"] }, judge)).toEqual([
    "api.selfbench.test",
  ]);
});
