import { z } from "zod";
import type { CouplingEvidence } from "./coupling.js";

export const COUPLING_REVIEW_MODEL = "gpt-5.6-sol";

export const couplingReviewSchema = z.object({
  verdict: z.enum(["clean", "coupled"]),
  reason: z.string().min(1),
  findings: z
    .array(
      z.object({
        artifact: z.string().min(1),
        category: z.enum(["endpoint_path", "field_name", "header_name", "media_type", "other"]),
        disposition: z.enum([
          "base_contract",
          "prompt_contract",
          "external_contract",
          "gold_only",
          "not_contract",
        ]),
        evidence: z.string().min(1),
      }),
    )
    .min(1),
  counterexample: z.string().min(1),
});

export type CouplingReview = z.infer<typeof couplingReviewSchema>;

export async function reviewCouplingWithCodex(input: {
  readonly apiKey?: string;
  readonly authJson?: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}): Promise<CouplingReview> {
  const subscription =
    !input.apiKey && input.authJson ? parseCredential(input.authJson) : undefined;
  if (!input.apiKey && !subscription) {
    throw new Error("OpenAI model authentication is required");
  }
  const request = input.fetch ?? fetch;
  const response = await request(
    subscription
      ? "https://chatgpt.com/backend-api/codex/responses"
      : "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subscription?.access ?? input.apiKey}`,
        ...(subscription ? { "ChatGPT-Account-Id": accountIdFromToken(subscription.access) } : {}),
        Originator: "selfbench",
        "OpenAI-Beta": "responses=experimental",
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: COUPLING_REVIEW_MODEL,
        store: false,
        stream: true,
        instructions:
          "You are an independent benchmark-quality reviewer. Analyze the supplied evidence and call submit_review exactly once.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: input.prompt }],
          },
        ],
        reasoning: { effort: "high", summary: "auto" },
        text: { verbosity: "low" },
        include: ["reasoning.encrypted_content"],
        tools: [reviewTool()],
        tool_choice: { type: "function", name: "submit_review" },
        parallel_tool_calls: false,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex coupling review failed (${response.status}): ${responseText.slice(0, 500)}`,
    );
  }
  return parseCodexReviewEvents(responseText);
}

function parseCredential(value: string): { access: string } {
  const parsed = JSON.parse(value) as unknown;
  const credential = isRecord(parsed) ? parsed["openai-codex"] : undefined;
  if (!isRecord(credential) || typeof credential.access !== "string") {
    throw new Error("Pi auth does not contain an OpenAI Codex subscription access token");
  }
  return { access: credential.access };
}

function accountIdFromToken(token: string): string {
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as unknown;
  const auth = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("OpenAI Codex subscription token has no ChatGPT account ID");
  }
  return accountId;
}

export function parseCodexReviewEvents(value: string): CouplingReview {
  for (const line of value.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice("data: ".length);
    if (data === "[DONE]") {
      continue;
    }
    const event = JSON.parse(data) as unknown;
    if (!isRecord(event)) {
      continue;
    }
    const item = event.item;
    if (
      event.type === "response.output_item.done" &&
      isRecord(item) &&
      item.type === "function_call" &&
      item.name === "submit_review" &&
      typeof item.arguments === "string"
    ) {
      return couplingReviewSchema.parse(JSON.parse(item.arguments));
    }
    if (event.type === "error") {
      throw new Error(`Codex coupling review stream failed: ${JSON.stringify(event)}`);
    }
  }
  throw new Error("Codex coupling review returned no submit_review tool call");
}

export function couplingReviewPrompt(): string {
  return `Independently review this hard benchmark for test-to-gold coupling.

For every exact endpoint path, response/request field, header, media type, helper/module, error string, schema/index name, UI copy/order, or other implementation artifact asserted by the held-out tests, cite either the authentic prompt text that requires it or deterministic evidence that the exact base repository already establishes it. A name merely appearing in the gold patch is not evidence. Reject a test that would fail a coherent implementation of the request using different names, file boundaries, payload presentation, or internal structure.

Resolve every artifact listed in couplingEvidence.blockers with a finding whose artifact exactly matches it. Use external_contract only when the authentic request names a standard protocol that fixes the exact artifact independently of the gold patch, and cite that protocol. Use not_contract only for incidental test-language or framework syntax that is not an asserted product contract. A clean verdict with a missing blocker finding or a gold_only finding is rejected automatically.

Your findings must identify the artifact, classify it, give its disposition, and cite concrete evidence. The counterexample must describe a plausible alternative correct implementation and whether the tests would accept it. Also reject prompt leakage of PRs, commits, test names, or the solution.`;
}

export function couplingReviewInput(
  prompt: string,
  testPatch: string,
  goldPatch: string,
  evidence: CouplingEvidence,
): string {
  return `${couplingReviewPrompt()}

# Authentic request

${prompt}

# Deterministic base-contract evidence

The exact-artifact scan compared the held-out tests with the authentic request, gold additions, and exact base snapshot. Every blocker below is asserted by tests and introduced by gold, but absent verbatim from both request and base. Resolve each blocker explicitly.

${JSON.stringify(evidence, null, 2)}

# Held-out test patch

\`\`\`diff
${testPatch}
\`\`\`

# Gold implementation patch

\`\`\`diff
${goldPatch}
\`\`\`
`;
}

function reviewTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "submit_review",
    description: "Submit the final independent test-coupling verdict exactly once.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "reason", "findings", "counterexample"],
      properties: {
        verdict: { type: "string", enum: ["clean", "coupled"] },
        reason: { type: "string", minLength: 1 },
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["artifact", "category", "disposition", "evidence"],
            properties: {
              artifact: { type: "string", minLength: 1 },
              category: {
                type: "string",
                enum: ["endpoint_path", "field_name", "header_name", "media_type", "other"],
              },
              disposition: {
                type: "string",
                enum: [
                  "base_contract",
                  "prompt_contract",
                  "external_contract",
                  "gold_only",
                  "not_contract",
                ],
              },
              evidence: { type: "string", minLength: 1 },
            },
          },
        },
        counterexample: { type: "string", minLength: 1 },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
