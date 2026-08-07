import { describe, expect, test } from "bun:test";
import { parseCodexReviewEvents } from "../src/codex-review.js";

describe("Codex coupling review", () => {
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
