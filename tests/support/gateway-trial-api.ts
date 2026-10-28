import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type { CredentialInfo } from "../../src/db/credentials.js";
import { gatewayRequests } from "../../src/db/schema.js";
import { createVault } from "../../src/db/vault.js";
import {
  gatewayModelId,
  gatewayTrial,
  pinnedThinking,
} from "../../src/evaluation/gateway-trial.js";
import type { EvaluationInput, Harness } from "../../src/evaluation/types.js";
import { gatewayConnection } from "../../src/gateway/connection.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { TrialJudge } from "../../src/gateway/trial-key.js";
import { createGatewayUsageStore } from "../../src/gateway/usage-store.js";
import { gatewayModelPrice, listedModelConfig } from "../../src/gateways/catalog.js";
import { startUpstream, VAULT_SECRETS } from "./gateway-upstream.js";
import { testDatabase } from "./test-database.js";

// A real trial's path, with no SelfBench code stubbed: gatewayTrial builds the trial's environment,
// the gateway route is mounted in a node:http server as the API mounts it, its usage lands in
// gateway_requests on PGlite, and an HTTP client sends each harness's request shape. The provider is
// the stand-in in gateway-upstream.ts; only its address differs from production, since a
// credential's endpoint must be HTTPS on an operator-approved host.

export const ORG = 1;
export const SECRET = "s".repeat(40);
const VAULT_KEY = "a".repeat(64);

/** Each credential the trials run on: its kind, sign-in, and a real catalog model it serves. */
export const CREDENTIALS = {
  openai: { kind: "openai", auth: "api-key", model: "openai/gpt-6-luna" },
  anthropic: { kind: "anthropic", auth: "api-key", model: "anthropic/claude-sonnet-5-5" },
  openrouter: { kind: "openrouter", auth: "api-key", model: "openrouter/openai/gpt-4o-mini" },
  meta: { kind: "meta", auth: "api-key", model: "meta/muse-spark-1.3" },
  "codex-login": { kind: "openai", auth: "codex-login", model: "openai/gpt-6-luna" },
  "claude-login": { kind: "anthropic", auth: "claude-login", model: "anthropic/claude-sonnet-5-5" },
} as const;
export type Credential = keyof typeof CREDENTIALS;

/** Codex's Responses call, to the URL its environment names. */
export const responses = (env: NodeJS.ProcessEnv, model: string) =>
  fetch(`${env.OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }),
  });

/** An Anthropic Messages call; Claude Code's own headers mark it as Claude Code's. */
export const messages = (env: NodeJS.ProcessEnv, model: string, claudeCode = true) =>
  fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(claudeCode
        ? {
            "user-agent": "claude-cli/2.1.0 (external, cli)",
            "x-app": "cli",
            "x-claude-code-session-id": crypto.randomUUID(),
          }
        : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });

/**
 * The API with its gateway route, on a PGlite vault holding each of CREDENTIALS, whose providers
 * are the stand-in.
 */
export async function startTrialApi() {
  const upstream = startUpstream();
  const database = await testDatabase();
  const store = createGatewayUsageStore(database.db);
  const failures: unknown[] = [];
  const ids = {} as Record<Credential, string>;
  const vault = createVault(database.db, VAULT_KEY).credentials;
  for (const [name, { kind, auth }] of Object.entries(CREDENTIALS)) {
    const saved = await vault.create(
      ORG,
      { name, kind, auth, value: VAULT_SECRETS[name as Credential] },
      {},
    );
    ids[name as Credential] = saved.id;
  }
  const nameOf = (id: string) =>
    (Object.keys(ids) as Credential[]).find((name) => ids[name] === id);
  const route = gatewayRoute({
    secret: SECRET,
    // Stored credentials, with the stand-in's address as their endpoint (see the header).
    credentials: {
      find: async (orgId, id) => {
        const info = await vault.find(orgId, id);
        const name = nameOf(id);
        return info && name ? ({ ...info, endpoint: upstream.base[name] } as CredentialInfo) : info;
      },
      secret: (orgId, id) => vault.secret(orgId, id),
      renew: (orgId, id, value) => vault.renew(orgId, id, value),
    },
    endpoint: (endpoint) => endpoint,
    modelConfig: listedModelConfig,
    modelPrice: gatewayModelPrice,
    recordUsage: (entry) => {
      store.record(entry).catch((error) => failures.push(error));
    },
    captureError: (error) => failures.push(error),
  });
  // As the API mounts it (server.ts): the gateway route ahead of the rest of the API.
  const api = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://api.test");
    if (!(await route(request, url, response))) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  /** A trial's environment and connection, as the worker builds them. */
  /** A judge's own connection, as the worker builds one for a judged trial. */
  function judgeFor(judge: TrialJudge, trial: string) {
    return gatewayConnection(apiUrl, SECRET, {
      orgId: ORG,
      judge,
      tags: { run: "run-e2e", trial },
    });
  }

  function trialFor(harness: Harness, credential: Credential, trial: string) {
    const { kind, auth, model } = CREDENTIALS[credential];
    const input = {
      modelName: model,
      credentials: { provider: kind, auth, modelCredentialId: ids[credential] },
    } as EvaluationInput;
    const thinking = pinnedThinking(harness, input.thinking);
    const connection = gatewayConnection(apiUrl, SECRET, {
      orgId: ORG,
      credentialId: ids[credential],
      model: gatewayModelId(input),
      ...(thinking ? { thinking } : {}),
      tags: { run: "run-e2e", trial, harness },
    });
    // The worker's host environment holds every raw provider key; none may reach the trial.
    const hostEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "raw-openai",
      ANTHROPIC_API_KEY: "raw-anthropic",
      OPENROUTER_API_KEY: "raw-openrouter",
      AI_GATEWAY_API_KEY: "raw-vercel",
      META_API_KEY: "raw-meta",
    };
    const trialEnv = gatewayTrial(input, harness, model, hostEnv, connection);
    return { trial: trialEnv, connection, input, hostEnv };
  }

  /** The trial's usage rows, once `calls` of them have landed (recordUsage runs after the reply). */
  async function usageRows(trialTag: string, calls: number) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = await database.db
        .select()
        .from(gatewayRequests)
        .where(sql`${gatewayRequests.tags}->>'trial' = ${trialTag}`);
      if (rows.length >= calls) return rows;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`usage rows for ${trialTag} never landed`);
  }

  return {
    upstream,
    store,
    ids,
    failures,
    trialFor,
    judgeFor,
    usageRows,
    async close() {
      await new Promise((resolve) => api.close(resolve));
      await database.close();
      await upstream.stop();
    },
  };
}
