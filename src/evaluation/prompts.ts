import { renderPromptFile } from "../lib/prompts.js";

/**
 * The system prompt of one of the evaluation's model calls, from `prompts/<name>.md`: Explain
 * Failure, Audit Task, and Model Summaries.
 */
export function evaluationPrompt(
  name: "explain-failure" | "audit-task" | "model-summaries",
): string {
  return renderPromptFile(new URL("./prompts/", import.meta.url), name);
}
