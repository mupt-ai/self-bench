import { renderPromptFile } from "../../lib/prompts.js";

/** Renders `prompts/<name>.md`, replacing each `{{key}}` with its value. */
export function renderPrompt(
  name: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return renderPromptFile(new URL("./prompts/", import.meta.url), name, values);
}
