import { expect, test } from "bun:test";
import { gatewayCost } from "../src/evaluation/gateway-cost.js";
import {
  OPENROUTER_BILLING,
  OPENROUTER_GENERATIONS,
  openRouterManifest,
} from "../src/gateways/openrouter/billing.js";

const noWait = async () => {};
const files = (id: string, prompt = 10, completion = 5) =>
  new Map([
    [
      "agent/pi.txt",
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          responseId: id,
          usage: { input: prompt, output: completion, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ],
  ]);
const root = {
  id: "gen-root",
  request_id: "req-root",
  session_id: "trial-session",
  router: "example/router",
  created_at: "2026-01-01T00:00:00Z",
  total_cost: 0,
  is_byok: false,
  native_tokens_prompt: 0,
  native_tokens_completion: 0,
};
const ledger = (rows: Record<string, unknown>[]) =>
  (async (url: string) => {
    if (url.endsWith("/analytics/query"))
      return Response.json({
        data: {
          data: rows.map((row) => ({ generation_id: row.id, session_id: row.session_id })),
          metadata: { truncated: false, row_count: rows.length },
        },
      });
    return Response.json({
      data: rows.find((row) => row.id === new URL(url).searchParams.get("id")),
    });
  }) as unknown as typeof fetch;

test("zero placeholders with missing, null or invalid native usage never publish a free bill", async () => {
  for (const value of [undefined, null, -1, "0", 0.5]) {
    for (const field of ["native_tokens_prompt", "native_tokens_completion"]) {
      const incomplete = { ...root, [field]: value };
      for (const provider of ["openrouter", "vercel-ai-gateway"] as const) {
        for (const prompt of [0, 10]) {
          const direct = files(root.id, prompt, prompt ? 5 : 0);
          expect(
            await gatewayCost(
              provider,
              "key",
              "pi",
              direct,
              ledger([{ ...incomplete, router: null }]),
              undefined,
              noWait,
            ),
          ).toBeUndefined();
          expect(direct.has(OPENROUTER_BILLING)).toBe(false);
        }
      }
      const routed = files(root.id);
      expect(
        await gatewayCost(
          "openrouter",
          "key",
          "pi",
          routed,
          ledger([incomplete]),
          "management",
          noWait,
        ),
      ).toBeUndefined();
      expect(routed.has(OPENROUTER_BILLING)).toBe(false);
    }
  }
});

test("an incomplete zero bill in a mixed routed/direct ledger cannot produce a partial price", async () => {
  const priced = {
    ...root,
    id: "gen-priced",
    request_id: "req-priced",
    router: null,
    total_cost: 0.25,
  };
  const input = files(root.id);
  input.set(
    "agent/pi.txt",
    `${input.get("agent/pi.txt")}\n${files(priced.id).get("agent/pi.txt")}`,
  );
  for (const value of [undefined, null]) {
    const fetcher = ledger([{ ...root, native_tokens_prompt: value }, priced]);
    expect(
      await gatewayCost("openrouter", "key", "pi", input, fetcher, "management", noWait),
    ).toBeUndefined();
  }
});

test("archived OpenRouter manifests round-trip both accepted generation ID forms", async () => {
  for (const id of ["gen_01ARZ3NDEKTSV4RRFFQ69G5FAV", "gen-1791855534-example"]) {
    const input = files(id);
    const archived = new Map<string, string>();
    openRouterManifest("pi", input, archived);
    expect(JSON.parse(archived.get(OPENROUTER_GENERATIONS) ?? "{}").generationIds).toEqual([id]);
    archived.set("agent/pi.txt", "[Earlier output truncated]\n");
    expect(
      await gatewayCost(
        "openrouter",
        "key",
        "pi",
        archived,
        ledger([{ ...root, id, router: null, total_cost: 0.25 }]),
        undefined,
        noWait,
      ),
    ).toBe(0.25);
    expect(archived.has(OPENROUTER_BILLING)).toBe(true);
    const container = { ...root, id, upstream_id: null, provider_responses: [] };
    const child = {
      ...root,
      id: `${id}child`,
      router: null,
      total_cost: 0.5,
      native_tokens_prompt: 10,
      native_tokens_completion: 5,
      upstream_id: "provider-id",
      provider_responses: [{ id: "provider-id", status: 200 }],
    };
    expect(
      await gatewayCost(
        "openrouter",
        "key",
        "pi",
        archived,
        ledger([container, child]),
        "management",
        noWait,
      ),
    ).toBe(0.5);
  }
});
