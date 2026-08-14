import { describe, expect, test } from "bun:test";
import { parseCodexReviewEvents, reviewCouplingWithCodex } from "../src/codex-review.js";

describe("Codex coupling review", () => {
  test("uses the public Responses API with API-key authentication", async () => {
    let requestedUrl = "";
    let authorization = "";
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "submit_review",
            arguments: JSON.stringify({
              verdict: "clean",
              reason: "base contract",
              findings: [
                {
                  artifact: "route",
                  category: "endpoint_path",
                  disposition: "base_contract",
                  evidence: "Present in base.",
                },
              ],
              counterexample: "An alternative implementation would pass.",
            }),
          },
        })}\n\ndata: [DONE]\n`,
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    await reviewCouplingWithCodex({ apiKey: "api-key", prompt: "review", fetch });

    expect(requestedUrl).toBe("https://api.openai.com/v1/responses");
    expect(authorization).toBe("Bearer api-key");
  });

  test("prefers the API key when both auth forms are supplied", async () => {
    let requestedUrl = "";
    const fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "submit_review",
            arguments: JSON.stringify({
              verdict: "clean",
              reason: "base contract",
              findings: [
                {
                  artifact: "route",
                  category: "endpoint_path",
                  disposition: "base_contract",
                  evidence: "Present.",
                },
              ],
              counterexample: "Alternative passes.",
            }),
          },
        })}\ndata: [DONE]\n`,
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    await reviewCouplingWithCodex({
      apiKey: "api-key",
      authJson: JSON.stringify({ "openai-codex": { access: "not-used" } }),
      prompt: "review",
      fetch,
    });

    expect(requestedUrl).toBe("https://api.openai.com/v1/responses");
  });

  test("parses the forced submit_review tool call", () => {
    const review = parseCodexReviewEvents(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "submit_review",
          arguments: JSON.stringify({
            verdict: "coupled",
            reason: "gold-only field",
            findings: [
              {
                artifact: "routing_strategy",
                category: "field_name",
                disposition: "gold_only",
                evidence: "Absent from prompt and base.",
              },
            ],
            counterexample: "A strategy field with another name would fail.",
          }),
        },
      })}\n\ndata: [DONE]\n`,
    );

    expect(review.verdict).toBe("coupled");
    expect(review.findings[0]?.artifact).toBe("routing_strategy");
  });
});
