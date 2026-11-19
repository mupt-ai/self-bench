import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { judgeEnvironment } from "../../src/evaluation/judge.js";
import { gatewayConnection } from "../../src/gateway/connection.js";
import { dariJudgeModel } from "../../src/gateway/dari-link/judge.js";
import { recordDariLinkUsage } from "../../src/gateway/dari-link/link.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { servedModelCost } from "../../src/gateways/catalog.js";
import { GPT, startDariLink } from "../support/dari-link.js";
import { responses } from "../support/gateway-trial-api.js";

const SECRET = "s".repeat(40);

// A benchmark's LLM judge on a Dari connection: it calls SelfBench's gateway with its trial key, and
// the gateway, holding the grant, asks Dari for whatever model the judge names.

describe("Dari Link judge", () => {
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
