import { readFile, writeFile } from "node:fs/promises";
import { reviewCouplingWithCodex } from "./codex-review.js";

const apiKey = process.env.OPENAI_API_KEY;
const authJson = process.env.SELFBENCH_PI_AUTH_JSON;
const outputPath = process.env.SELFBENCH_REVIEW_OUTPUT;
if (!apiKey && !authJson) {
  throw new Error("OPENAI_API_KEY or SELFBENCH_PI_AUTH_JSON is required");
}
if (!outputPath) {
  throw new Error("SELFBENCH_REVIEW_OUTPUT is required");
}

const review = await reviewCouplingWithCodex({
  ...(apiKey ? { apiKey } : {}),
  ...(authJson ? { authJson } : {}),
  prompt: await readFile("/work/review-input.md", "utf8"),
});
await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx" });
