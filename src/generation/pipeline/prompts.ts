import { readFileSync } from "node:fs";

/** Renders `prompts/<name>.md`, replacing each `{{key}}` with its value. */
export function renderPrompt(
  name: string,
  values: Readonly<Record<string, string | number>>,
): string {
  const template = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
  return template
    .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`prompt ${name} is missing {{${key}}}`);
      return String(value);
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
