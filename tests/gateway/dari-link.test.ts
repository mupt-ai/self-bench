import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gatewayTrial } from "../../src/evaluation/gateway-trial.js";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import {
  connectDari,
  dariLinkConnection,
  dariRefusal,
  recordDariLinkUsage,
} from "../../src/gateway/dari-link/link.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { servedModelCost } from "../../src/gateways/catalog.js";
import { generationDariLink } from "../../src/generation/settings/dari-link.js";
import { CLAUDE, GPT, startDariLink } from "../support/dari-link.js";
import { responses } from "../support/gateway-trial-api.js";

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
    // The Credentials page names what was shared, not just "Dari".
    expect(credential?.linkModels?.plans).toEqual(["Claude", "ChatGPT", "OpenRouter API Key"]);
    // A verifier the page did not make is refused.
    const forged = await link.server.request("/api/orgs/avyay/credentials/dari-link", {
      method: "POST",
      body: JSON.stringify({ code: "dlk_code_x", codeVerifier: "v".repeat(43) }),
    });
    expect(forged.status).toBe(400);
  });

  test("the Credentials page reads each plan's state and usage from Dari", async () => {
    const response = await link.server.request(
      `/api/orgs/avyay/credentials/${credentialId}/dari-status`,
    );
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      manageUrl: string;
      plans: { title: string; state: string; usage: unknown[] }[];
    };
    expect(status.manageUrl).toStartWith("http");
    expect(status.plans.map((plan) => [plan.title, plan.state])).toEqual([
      ["Claude", "ready"],
      ["ChatGPT", "ready"],
      ["OpenRouter", "ready"],
    ]);
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

  test("connecting again updates the one connection and ends the grant it replaced", async () => {
    const before = await link.vault.credentials.secret(link.orgId, credentialId);
    const old = JSON.parse(before?.value ?? "{}") as { refreshToken: string };
    expect((await link.connect()).status).toBe(201);
    const { credentials } = await link.list();
    expect(credentials.map((credential) => credential.id)).toEqual([credentialId]);
    const after = JSON.parse(
      (await link.vault.credentials.secret(link.orgId, credentialId))?.value ?? "{}",
    ) as { refreshToken: string };
    expect(after.refreshToken).not.toBe(old.refreshToken);
    // The replaced grant is gone on Dari; the credential runs on the new one.
    const replaced = await dariLinkConnection(
      async () => ({ ...link.dari.app, refreshToken: old.refreshToken }),
      { orgId: link.orgId, credentialId, model: GPT, tags: {} },
    ).catch((error: unknown) => error);
    expect(dariRefusal(replaced)).toContain("Connect again");
    expect((await trial(GPT)).env.OPENAI_API_KEY).toStartWith("dlk_ct_");
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
        renew: () => Promise.reject(new Error("Credential limit reached")),
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

  test("deleting the credential ends the grant on Dari: running trials stop", async () => {
    const running = await trial(GPT);
    expect((await link.remove(credentialId)).status).toBe(200);
    const response = await responses(running.env, "gpt-5.5");
    expect(response.status).toBe(401);
    const refused = await trial(GPT).catch((error: unknown) => error);
    expect(dariRefusal(refused)).toContain("Connect again");
    const status = await link.server.request(
      `/api/orgs/avyay/credentials/${credentialId}/dari-status`,
    );
    expect(await status.json()).toMatchObject({ unlinked: true });
  });
});
