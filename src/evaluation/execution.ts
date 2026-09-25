import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { modelApiKeyVariable } from "../contracts/models.js";
import { validateEndpoint } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import {
  managedModalEnvironment,
  managedModelKey,
  managedSandboxCredentials,
} from "../generation/billing/managed.js";
import { providerCredentialEnvironment } from "../sandbox/provider-environment.js";
import type { EvaluationInput, Harness } from "./types.js";

/** The organization whose credentials an evaluation uses. */
function evaluationCredentialOrg(input: EvaluationInput): number | undefined {
  return input.credentialOrgId ?? input.credentialOwnerId;
}

/** Resolves the comparison's saved credentials into a clean Harbor process environment. */
export async function credentialExecution(
  input: EvaluationInput,
  home: string,
  env: NodeJS.ProcessEnv,
  { credentials, comparisons }: Pick<Vault, "credentials" | "comparisons">,
) {
  const orgId = evaluationCredentialOrg(input);
  if (!input.credentials || !orgId || !input.comparisonId)
    throw new Error("Credential references missing");
  const comparison = await comparisons.find(input.comparisonId);
  const saved =
    comparison?.orgId === orgId && comparison.repoId === input.repoId
      ? comparison.inputs.find((entry) => entry.id === input.id)
      : undefined;
  if (!saved || !isDeepStrictEqual(saved, input))
    throw new Error("Execution does not match the reserved comparison");
  const managedModel = input.credentials.modelCredentialId === "managed-model";
  const managedSandbox = input.credentials.sandboxCredentialId === "managed-sandbox";
  const info = managedModel
    ? { id: "managed-model", kind: "openrouter" as const, auth: "api-key" as const }
    : await credentials.find(orgId, input.credentials.modelCredentialId);
  const sandbox = managedSandbox
    ? { id: "managed-sandbox", kind: input.sandbox }
    : await credentials.find(orgId, input.credentials.sandboxCredentialId);
  if (
    !info ||
    !sandbox ||
    sandbox.kind !== input.sandbox ||
    info.kind !== input.credentials.provider
  )
    throw new Error("Credential unavailable");
  const modelSecret = managedModel
    ? managedModelKey(env)
    : (await credentials.secret(orgId, info.id))?.value;
  const managedE2B =
    managedSandbox && input.sandbox === "e2b" ? managedSandboxCredentials(env) : undefined;
  const managedModal =
    managedSandbox && input.sandbox === "modal" ? managedModalEnvironment(env) : undefined;
  const sandboxSecret = managedE2B
    ? { value: managedE2B.apiKey }
    : managedModal
      ? { value: managedModal.MODAL_TOKEN_SECRET, tokenId: managedModal.MODAL_TOKEN_ID }
      : await credentials.secret(orgId, sandbox.id);
  if (!modelSecret || !sandboxSecret) throw new Error("Credential unavailable");
  const child: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  const secrets = [modelSecret, sandboxSecret.value, sandboxSecret.tokenId ?? ""].filter(Boolean);
  if (info.auth === "codex-login") {
    if (input.harnesses.some((harness) => harness !== "codex"))
      throw new Error("Codex login requires Codex harness");
    const authPath = join(home, "codex-auth.json");
    await writeFile(authPath, modelSecret, { mode: 0o600 });
    child.CODEX_AUTH_JSON_PATH = authPath;
    const auth = JSON.parse(modelSecret);
    secrets.push(
      ...Object.values(auth.tokens).filter((value): value is string => typeof value === "string"),
    );
  } else {
    child[modelApiKeyVariable(info.kind)] = modelSecret;
  }
  if (info.kind === "custom")
    child.OPENAI_BASE_URL = validateEndpoint("endpoint" in info ? (info.endpoint ?? "") : "", env);
  Object.assign(
    child,
    providerCredentialEnvironment(input.sandbox, { ...sandboxSecret, domain: managedE2B?.domain }),
    managedModal ? { MODAL_ENVIRONMENT: managedModal.MODAL_ENVIRONMENT } : {},
  );
  return { profile: { model: input.modelName }, child, secrets };
}

const gateways = {
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    messages: "https://openrouter.ai/api",
    hosts: ["openrouter.ai", "*.openrouter.ai"],
  },
} as const;

function hostsFromEnvironment(env: NodeJS.ProcessEnv): string[] {
  return ["OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL"]
    .flatMap((key) => {
      const value = env[key];
      if (!value) return [];
      try {
        return [new URL(value).hostname];
      } catch {
        return [];
      }
    })
    .filter((host, index, hosts) => hosts.indexOf(host) === index);
}

function providerHosts(provider: string | undefined, env: NodeJS.ProcessEnv): string[] {
  if (provider === "openrouter") return [...gateways.openrouter.hosts];
  if (provider === "anthropic") return ["api.anthropic.com"];
  if (provider === "openai") return ["api.openai.com"];
  return hostsFromEnvironment(env);
}

export function solverAgent(harness: Harness, model: string): string {
  if (harness !== "codex") return harness;
  return model.startsWith("openai/") && model.slice(7).includes("/")
    ? "harbor_gateway:GatewayCodex"
    : "harbor_gateway:SelfBenchCodex";
}

/** The model name Harbor receives for a harness over the selected connection. */
export function gatewayModel(
  provider: NonNullable<EvaluationInput["credentials"]>["provider"] | undefined,
  harness: Harness,
  model: string,
): string {
  if (provider !== "openrouter" || harness === "pi") return model;
  const modelId = model.slice(provider.length + 1);
  return harness === "claude-code" ? modelId : `openai/${modelId}`;
}

/** Adapt the selected connection to each harness without inheriting host credentials. */
export function gatewayTrial(
  input: EvaluationInput,
  harness: Harness,
  model: string,
  env: NodeJS.ProcessEnv,
) {
  const provider = input.credentials?.provider;
  if (provider !== "openrouter") {
    const child = { ...env };
    return { model, child, extraAllowedHosts: providerHosts(provider, child) };
  }
  const gateway = gateways[provider];
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error("Gateway credential is unavailable");
  const harborModel = gatewayModel(provider, harness, model);
  const child = { ...env };
  delete child.OPENROUTER_API_KEY;
  delete child.AI_GATEWAY_API_KEY;
  if (harness === "claude-code") {
    child.ANTHROPIC_API_KEY = key;
    child.ANTHROPIC_BASE_URL = gateway.messages;
    return { model: harborModel, child, extraAllowedHosts: [...gateway.hosts] };
  }
  if (harness === "pi") {
    child.OPENROUTER_API_KEY = key;
    return { model: harborModel, child, extraAllowedHosts: [...gateway.hosts] };
  }
  child.OPENAI_API_KEY = key;
  child.OPENAI_BASE_URL = gateway.base;
  child.OPENAI_API_BASE = gateway.base;
  return { model: harborModel, child, extraAllowedHosts: [...gateway.hosts] };
}
