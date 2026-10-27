import { expect, test } from "bun:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { credentialSchema } from "../src/db/credentials.js";
import { catalog } from "../src/evaluation/catalog.js";
import { credentialExecution } from "../src/evaluation/execution.js";
import {
  DIRECT_API_KEY_PROVIDERS,
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

test("Meta API keys stay direct until the gateway's Meta provider ships; dropping it from the set routes them", () => {
  const meta = input("meta", "meta/muse-spark-1.3");
  expect([...DIRECT_API_KEY_PROVIDERS]).toEqual(["meta"]);
  for (const harness of ["codex", "claude-code", "pi", "muse-code"] as const)
    expect(trialRoute(meta, harness)).toBe("direct");
  const direct = gatewayTrial(meta, "codex", meta.modelName, { PATH: "/bin", META_API_KEY: "k" });
  expect(direct.extraAllowedHosts).toEqual(["api.meta.ai"]);
  // The one switch: with Meta out of the set, the same key takes the gateway on every harness
  // but Muse Code, which keeps Meta's endpoint.
  const released = new Set<string>();
  for (const harness of ["codex", "claude-code", "pi"] as const)
    expect(trialRoute(meta, harness, "api-key", released)).toBe("gateway");
  expect(trialRoute(meta, "muse-code", "api-key", released)).toBe("direct");
  // Sign-ins are unaffected by the set.
  expect(trialRoute(input("meta", "meta/muse-spark-1.3"), "pi", "muse-login", released)).toBe(
    "direct",
  );
});

test("sign-ins and Dari's router stay direct, as does Muse Code on a Meta key", () => {
  const signIn = (provider: string, auth: string) =>
    ({ modelName: `${provider}/model`, credentials: { provider, auth } }) as EvaluationInput;
  expect(trialRoute(signIn("openai", "codex-login"), "codex")).toBe("direct");
  expect(trialRoute(signIn("anthropic", "claude-login"), "claude-code")).toBe("direct");
  expect(trialRoute(signIn("meta", "muse-login"), "muse-code")).toBe("direct");
  expect(trialRoute(input("dari", "dari/routing"), "pi")).toBe("direct");
  expect(trialRoute(input("custom", "openai/dari/routing"), "pi")).toBe("direct");
  expect(trialRoute(input("meta", "meta/muse-spark-1.3"), "muse-code")).toBe("direct");
  // Muse Code keeps Meta's key, endpoint and bare model name.
  const meta = input("meta", "meta/muse-spark-1.3", "high");
  const env = { PATH: "/bin", META_API_KEY: "meta-key" };
  expect(gatewayTrial(meta, "muse-code", meta.modelName, env)).toEqual({
    model: "meta/muse-spark-1.3",
    agent: "harbor_muse:SelfBenchMuseCode",
    agentArguments: ["--agent-kwarg", "reasoning_effort=high"],
    child: env,
    extraAllowedHosts: ["api.meta.ai"],
  });
  // A custom endpoint naming Dari's router keeps Harbor's endpoint adapters.
  const dari = input("custom", "openai/dari/routing");
  const endpoint = { OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://models.example/v1" };
  expect(gatewayTrial(dari, "codex", dari.modelName, endpoint)).toMatchObject({
    model: "openai/dari/routing",
    agent: "harbor_gateway:GatewayCodex",
    extraAllowedHosts: ["models.example"],
  });
  expect(gatewayTrial(dari, "pi", dari.modelName, endpoint)).toMatchObject({
    agent: "harbor_dari:DariPi",
    agentArguments: ["--agent-kwarg", "model_api=openai-completions"],
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

test("gateway Pi takes the model's context window and output limit from Pi's catalog", () => {
  const known = getBuiltinModels("anthropic").find((model) => model.contextWindow > 128_000);
  if (!known) throw new Error("Missing Pi catalog fixture");
  const trialInput = input("anthropic", `anthropic/${known.id}`);
  const connection = { openAiBase: "https://gateway/v1", requestModel: "dari/model/x" };
  expect(piGatewayModels(trialInput, connection)).toEqual({
    providers: {
      selfbench: {
        baseUrl: "https://gateway/v1",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        models: [
          {
            id: "dari/model/x",
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
  expect(custom).toMatchObject({ providers: { selfbench: { models: [{ id: "dari/model/x" }] } } });
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

test("a Meta key stays in the vault and reaches its harnesses directly while Meta is off the gateway", async () => {
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
  // Until the gateway serves Meta, a Meta key takes the direct route on every harness.
  const codex = await credentialExecution(trialInput, "/home", {}, vault, "codex");
  expect(codex.route).toBe("direct");
  // Direct trials keep the key in their environment, as they did before the gateway.
  expect(codex.child.META_API_KEY).toBe("meta-secret");
  // Building task images calls no model, so it gets no model credential at all.
  const prepare = await credentialExecution(trialInput, "/home", {}, vault);
  expect(prepare.route).toBeUndefined();
  expect(JSON.stringify(prepare)).not.toContain("meta-secret");
});
