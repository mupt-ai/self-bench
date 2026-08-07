import { readFile, writeFile } from "node:fs/promises";
import { reviewCouplingWithCodex } from "./codex-review.js";

const authJson = process.env.SELFBENCH_PI_AUTH_JSON;
const outputPath = process.env.SELFBENCH_REVIEW_OUTPUT;
if (!authJson) {
  throw new Error("SELFBENCH_PI_AUTH_JSON is required");
}
if (!outputPath) {
  throw new Error("SELFBENCH_REVIEW_OUTPUT is required");
}

const review = await reviewCouplingWithCodex({
  authJson,
  prompt: await readFile("/work/review-input.md", "utf8"),
});
await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx" });
