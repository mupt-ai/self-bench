import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ApplicationFailure } from "@temporalio/common";
import { validateEndpoint } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import { gateways, isGateway, modelApiKeyVariable } from "../gateways/index.js";
import {
  managedModalEnvironment,
  managedModelKey,
  managedSandboxCredentials,
} from "../generation/billing/managed.js";
import {
  generationSubscriptionAuth,
  litellmSubscriptionAuth,
} from "../harnesses/codex/subscription.js";
import { providerCredentialEnvironment } from "../sandbox/provider-environment.js";
import { signInRefusal } from "./models.js";
import type { EvaluationInput, Harness } from "./types.js";

/**
 * A trial setup failure that every attempt would meet again (a missing or oversized bundle, an
 * unusable credential, an unsupported Harbor): the trial fails at once instead of retrying.
 */
export function refuseTrial(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, "TrialRefused");
}

/** The organization whose credentials an evaluation uses. */
export function evaluationCredentialOrg(
  input: Pick<EvaluationInput, "credentialOrgId" | "credentialOwnerId">,
): number | undefined {
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
    throw refuseTrial("Credential references missing");
  const comparison = await comparisons.find(input.comparisonId);
  const saved =
    comparison?.orgId === orgId && comparison.repoId === input.repoId
      ? comparison.inputs.find((entry) => entry.id === input.id)
      : undefined;
  // A trial workflow carries only its own task (trialInput); the rest must match exactly.
  const reserved =
    saved && input.tasks.length === 1
      ? { ...saved, tasks: saved.tasks.filter((task) => isDeepStrictEqual(task, input.tasks[0])) }
      : saved;
  if (!reserved || !isDeepStrictEqual(reserved, input))
    throw refuseTrial("Execution does not match the reserved comparison");
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
    throw refuseTrial("Credential unavailable");
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
  if (!modelSecret || !sandboxSecret) throw refuseTrial("Credential unavailable");
  const child: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  const secrets = [modelSecret, sandboxSecret.value, sandboxSecret.tokenId ?? ""].filter(Boolean);
  const refusal = signInRefusal(info.auth, input.harnesses);
  if (refusal) throw refuseTrial(refusal);
  if (info.auth === "codex-login") {
    if (input.harnesses.includes("codex")) {
      const authPath = join(home, "codex-auth.json");
      await writeFile(authPath, modelSecret, { mode: 0o600 });
      child.CODEX_AUTH_JSON_PATH = authPath;
    }
    if (input.harnesses.includes("pi")) {
      const authPath = join(home, "pi-auth.json");
      const piAuth = subscriptionAuth(generationSubscriptionAuth, modelSecret);
      await writeFile(authPath, piAuth, { mode: 0o600 });
      child.SELFBENCH_PI_AUTH_JSON_PATH = authPath;
      secrets.push(piAuth);
    }
    if (
      input.harnesses.some((harness) => harness === "mini-swe-agent" || harness === "terminus-2")
    ) {
      // LiteLLM's chatgpt provider reads this file: Terminus 2 in this trial's Harbor process,
      // mini-swe-agent from the copy harbor_subscription.py places in the sandbox.
      const tokenDir = join(home, "chatgpt");
      const authPath = join(tokenDir, "auth.json");
      const litellmAuth = subscriptionAuth(litellmSubscriptionAuth, modelSecret);
      await mkdir(tokenDir, { mode: 0o700 });
      await writeFile(authPath, litellmAuth, { mode: 0o600 });
      child.CHATGPT_TOKEN_DIR = tokenDir;
      child.SELFBENCH_CHATGPT_AUTH_JSON_PATH = authPath;
      secrets.push(litellmAuth);
    }
    const auth = JSON.parse(modelSecret);
    secrets.push(
      ...Object.values(auth.tokens).filter((value): value is string => typeof value === "string"),
    );
  } else if (info.auth === "claude-login") {
    // Harbor's Claude Code passes the token through and drops any API key once forced.
    child.CLAUDE_CODE_OAUTH_TOKEN = modelSecret;
    child.CLAUDE_FORCE_OAUTH = "1";
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
  return { profile: { model: input.modelName }, child, secrets, auth: info.auth };
}

/** A saved sign-in a harness cannot read fails the trial now: retrying cannot repair it. */
function subscriptionAuth(adapt: (raw: string) => string, raw: string): string {
  try {
    return adapt(raw);
  } catch (error) {
    throw refuseTrial(error instanceof Error ? error.message : String(error));
  }
}

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
  if (isGateway(provider)) return [...gateways[provider].hosts];
  if (provider === "anthropic") return ["api.anthropic.com"];
  if (provider === "openai") return ["api.openai.com"];
  return hostsFromEnvironment(env);
}

export function solverAgent(harness: Harness, model: string): string {
  if (harness === "pi") {
    const provider = model.slice(0, model.indexOf("/"));
    if (provider === "openai-codex") return "harbor_subscription:SelfBenchPi";
    return isGateway(provider) ? gateways[provider].harborPi : harness;
  }
  if (harness === "mini-swe-agent" && model.startsWith("chatgpt/"))
    return "harbor_subscription:ChatGptMiniSweAgent";
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
  auth?: "api-key" | "codex-login" | "claude-login",
): string {
  if (provider === "openai" && auth === "codex-login") {
    const modelId = model.slice("openai/".length);
    // Pi and LiteLLM (mini-swe-agent, Terminus 2) each name the ChatGPT backend as a provider.
    if (harness === "pi") return `openai-codex/${modelId}`;
    if (harness === "mini-swe-agent" || harness === "terminus-2") return `chatgpt/${modelId}`;
  }
  if (!isGateway(provider) || harness === "pi") return model;
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
  if (!isGateway(provider)) {
    const child = { ...env };
    const harborModel = gatewayModel(provider, harness, model, input.credentials?.auth);
    return {
      model: harborModel,
      child,
      extraAllowedHosts:
        provider === "openai" && input.credentials?.auth === "codex-login"
          ? ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"]
          : providerHosts(provider, child),
    };
  }
  const gateway = gateways[provider];
  const key = env[gateway.keyVariable];
  if (!key) throw refuseTrial("Gateway credential is unavailable");
  const harborModel = gatewayModel(provider, harness, model);
  const child = { ...env };
  for (const { keyVariable } of Object.values(gateways)) delete child[keyVariable];
  const extraAllowedHosts = [...gateway.hosts];
  if (harness === "claude-code") {
    child.ANTHROPIC_API_KEY = key;
    child.ANTHROPIC_BASE_URL = gateway.anthropicBase;
    return { model: harborModel, child, extraAllowedHosts };
  }
  if (harness === "pi") {
    child[gateway.keyVariable] = key;
    return { model: harborModel, child, extraAllowedHosts };
  }
  child.OPENAI_API_KEY = key;
  child.OPENAI_BASE_URL = gateway.openAiBase;
  child.OPENAI_API_BASE = gateway.openAiBase;
  return { model: harborModel, child, extraAllowedHosts };
}
