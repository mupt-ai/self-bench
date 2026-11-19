import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gatewayTrial } from "../../src/evaluation/gateway-trial.js";
import { judgeEnvironment } from "../../src/evaluation/judge.js";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import { gatewayConnection } from "../../src/gateway/connection.js";
import { dariJudgeModel } from "../../src/gateway/dari-link/judge.js";
import {
  connectDari,
  dariLinkConnection,
  dariRefusal,
  recordDariLinkUsage,
} from "../../src/gateway/dari-link/link.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { servedModelCost } from "../../src/gateways/catalog.js";
import { generationDariLink } from "../../src/generation/settings/dari-link.js";
import { CLAUDE, GPT, startDariLink } from "../support/dari-link.js";
import { responses } from "../support/gateway-trial-api.js";

const SECRET = "s".repeat(40);

// Connect with Dari against Dari's stub gateway: the API saves the grant's refresh token as a
// credential, each trial and generation stage calls Dari on a child token for its model alone, and
// deleting the credential ends the grant.

describe("Dari Link", () => {
  let link: Awaited<ReturnType<typeof startDariLink>>;
  let credentialId = "";
  beforeAll(async () => {
    link = await startDariLink();
    const connected = await link.connect();
    expect(connected.status).toBe(201);
    credentialId = ((await connected.json()) as { id: string }).id;
  }, 60_000);
  afterAll(async () => {
    await link?.server.close();
    await link?.dari.stop();
  });

  /** A Codex trial's environment on the connection, as trial-setup.ts makes it. */
  async function trial(model: string) {
    const tag = `run-link/${crypto.randomUUID()}`;
    const connection = await dariLinkConnection(link.grants, {
      orgId: link.orgId,
      credentialId,
      model,
      thinking: "low",
      tags: { run: "run-link", trial: tag, harness: "codex" },
    });
    const input = {
      modelName: `dari-link/${model}`,
      credentials: { provider: "dari-link", auth: "dari-link", modelCredentialId: credentialId },
    } as EvaluationInput;
    return { tag, env: gatewayTrial(input, "codex", model, {}, connection).child };
  }

  test("an approval becomes one credential offering what the grant serves", async () => {
    const { credentials, dariLink } = await link.list();
    expect(dariLink).toEqual({
      gatewayUrl: link.dari.app.gatewayUrl,
      clientId: link.dari.app.clientId,
      redirectUri: link.dari.app.redirectUri,
    });
    const [credential] = credentials;
    expect(credentials).toHaveLength(1);
    expect(credential).toMatchObject({ id: credentialId, kind: "dari-link", auth: "dari-link" });
    // A Claude plan's model runs only on Claude Code; the ChatGPT plan's on any harness.
    expect(credential?.linkModels?.models).toContainEqual(
      expect.objectContaining({ id: CLAUDE, only: "claude-code" }),
    );
    expect(credential?.linkModels?.models).toContainEqual(expect.objectContaining({ id: GPT }));
    expect(credential?.linkModels?.prefixes).toEqual(["openrouter/"]);
    // A verifier the page did not make is refused.
    const forged = await link.server.request("/api/orgs/avyay/credentials/dari-link", {
      method: "POST",
      body: JSON.stringify({ code: "dlk_code_x", codeVerifier: "v".repeat(43) }),
    });
    expect(forged.status).toBe(400);
  });

  test("a trial calls Dari on a child token for its model, and its usage is read back", async () => {
    const run = await trial(GPT);
    const secret = (await link.vault.credentials.secret(link.orgId, credentialId))?.value ?? "";
    const { refreshToken } = JSON.parse(secret) as { refreshToken: string };
    expect(JSON.stringify(run.env)).not.toContain(refreshToken);
    expect(run.env.OPENAI_API_KEY).toStartWith("dlk_ct_");
    const response = await responses(run.env, GPT.replace(/^openai\//, ""));
    await response.text();
    expect(response.status).toBe(200);
    expect(link.dari.calls.at(-1)).toMatchObject({ model: "gpt-5.5", effort: "low" });
    const rows: GatewayUsage[] = [];
    for (let attempt = 0; attempt < 50 && rows.length === 0; attempt += 1) {
      await recordDariLinkUsage(
        link.grants,
        { orgId: link.orgId, credentialId, tags: { trial: run.tag } },
        { record: async (row) => void rows.push(row), listCost: servedModelCost },
      );
      if (rows.length === 0) await Bun.sleep(20);
    }
    expect(rows[0]).toMatchObject({ credentialId, model: GPT, costSource: "pricing" });
  });

  test("a model the grant does not serve is refused with Dari's reason", async () => {
    const refused = await trial("openai/gpt-nope-9").catch((error: unknown) => error);
    expect(dariRefusal(refused)).toStartWith("Dari refused this model:");
  });

  test("an approval SelfBench cannot save is ended on Dari", async () => {
    const grants = async () =>
      (
        (await (
          await fetch(`${link.dari.baseUrl}/v1/link/grants`, {
            headers: { authorization: `Bearer ${link.dari.gatewayKey}` },
          })
        ).json()) as { grants: unknown[] }
      ).grants.length;
    const before = await grants();
    const full = {
      ...link.vault,
      credentials: {
        ...link.vault.credentials,
        create: () => Promise.reject(new Error("Credential limit reached")),
      },
    };
    const approved = await link.dari.connect();
    await expect(connectDari(full, link.orgId, link.dari.app, approved)).rejects.toThrow(
      "Credential limit reached",
    );
    expect(await grants()).toBe(before);
  });

  test("a generation stage gets a child token and Pi's models.json naming Dari", async () => {
    const model = `dari/model/${GPT}`;
    const stage = await generationDariLink(link.grants, {
      orgId: link.orgId,
      credentialId,
      runId: "run-dari",
      role: "author",
      model,
      reasoning: "low",
    });
    const pi = JSON.parse(stage.piModels.models) as {
      providers: Record<string, { baseUrl: string; models: { id: string }[] }>;
    };
    const provider = pi.providers["dari-link"];
    expect(provider).toMatchObject({
      baseUrl: `${link.dari.app.gatewayUrl}/v1`,
      models: [{ id: model }],
    });
    const response = await responses(
      { OPENAI_BASE_URL: provider?.baseUrl, OPENAI_API_KEY: stage.key },
      model,
    );
    await response.text();
    expect(response.status).toBe(200);
  });

  test("a judge on the connection reaches Dari for the model it names, through SelfBench's gateway", async () => {
    const gateway = await judgeGateway();
    try {
      const tag = `run-judge/${crypto.randomUUID()}`;
      const judge = judgeEnvironment(
        gatewayConnection(gateway.url, SECRET, {
          orgId: link.orgId,
          judge: { credentialId, provider: "dari-link" },
          tags: { run: "run-judge", trial: tag, harness: "codex" },
        }),
      );
      // The judge holds only its SelfBench key; the grant stays with the gateway.
      expect(judge.OPENAI_API_KEY).toStartWith("sbk_");
      // A judge names its model as OpenAI's API would, or with its vendor, in either protocol.
      for (const model of ["gpt-5.5", GPT]) {
        const answer = await responses(judge, model);
        await answer.text();
        expect(answer.status).toBe(200);
        expect(link.dari.calls.at(-1)).toMatchObject({ model: "gpt-5.5" });
      }
      const chat = await fetch(`${judge.OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${judge.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "1+1?" }] }),
      });
      await chat.text();
      expect(chat.status).toBe(200);
      // Dari's usage of the judge's calls is recorded as a judge's, apart from the trial's own.
      const rows: GatewayUsage[] = [];
      for (let attempt = 0; attempt < 50 && rows.length === 0; attempt += 1) {
        await recordDariLinkUsage(
          link.grants,
          { orgId: link.orgId, credentialId, tags: { trial: tag }, judge: true },
          { record: async (row) => void rows.push(row), listCost: servedModelCost },
        );
        if (rows.length === 0) await Bun.sleep(20);
      }
      expect(rows[0]).toMatchObject({ credentialId, model: GPT, tags: { judge: "true" } });
      const solver: GatewayUsage[] = [];
      await recordDariLinkUsage(
        link.grants,
        { orgId: link.orgId, credentialId, tags: { trial: tag } },
        { record: async (row) => void solver.push(row) },
      );
      expect(solver).toEqual([]);
    } finally {
      await gateway.close();
    }
  });

  test("a judge's model the connection does not serve is refused with Dari's reason", async () => {
    const gateway = await judgeGateway();
    try {
      const judge = judgeEnvironment(
        gatewayConnection(gateway.url, SECRET, {
          orgId: link.orgId,
          judge: { credentialId, provider: "dari-link" },
          tags: { run: "run-judge", trial: "run-judge/refused" },
        }),
      );
      const calls = link.dari.calls.length;
      const refused = await responses(judge, "gpt-nope-9");
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      const body = (await refused.json()) as { error: { message: string } };
      expect(body.error.message).toContain("gpt-nope-9");
      expect(link.dari.calls.length).toBe(calls);
    } finally {
      await gateway.close();
    }
  });

  /** SelfBench's gateway, as the API mounts it, with the stub's app as its Dari Link. */
  async function judgeGateway() {
    const route = gatewayRoute({
      secret: SECRET,
      credentials: link.vault.credentials,
      endpoint: (endpoint) => endpoint,
      dariLink: link.dari.app,
      recordUsage: () => undefined,
      captureError: (error) => {
        throw error;
      },
    });
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://api.test");
      if (!(await route(request, url, response))) response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  test("deleting the credential ends the grant on Dari: running trials stop", async () => {
    const running = await trial(GPT);
    expect((await link.remove(credentialId)).status).toBe(200);
    const response = await responses(running.env, "gpt-5.5");
    expect(response.status).toBe(401);
    const refused = await trial(GPT).catch((error: unknown) => error);
    expect(dariRefusal(refused)).toContain("Connect again");
  });
});

test("a judge's model name is Dari's id for a model the connection serves", () => {
  const served = {
    models: [
      { id: "anthropic/claude-sonnet-5-5", only: "claude-code" as const },
      { id: "openai/gpt-5.5" },
      { id: "opencode-go/claude-sonnet-5-5" },
    ],
    prefixes: ["openrouter/"],
  };
  expect(dariJudgeModel("gpt-5.5", served)).toBe("openai/gpt-5.5");
  expect(dariJudgeModel("openai/gpt-5.5", served)).toBe("openai/gpt-5.5");
  expect(dariJudgeModel("dari/model/openai/gpt-5.5", served)).toBe("openai/gpt-5.5");
  // A model any app may call before one only Claude Code may.
  expect(dariJudgeModel("claude-sonnet-5-5", served)).toBe("opencode-go/claude-sonnet-5-5");
  // A vendor's model the connection does not list, on its gateway key.
  expect(dariJudgeModel("anthropic/claude-opus-4-5", served)).toBe(
    "openrouter/anthropic/claude-opus-4-5",
  );
  // Nothing matches: Dari is asked as it is, and refuses it with its reason.
  expect(dariJudgeModel("gpt-nope-9", served)).toBe("gpt-nope-9");
});
