import { existsSync, readFileSync } from "node:fs";

/** KEY=value lines, `#` comments, optional surrounding quotes; the subset Compose and dev-site read. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (key) values[key] = value;
  }
  return values;
}

/**
 * Fills `environment` from env-files in precedence order (later files win), without replacing
 * values already set. A missing or empty file is an error: a deploy mounted the wrong secret.
 */
export function loadEnvFiles(paths: readonly string[], environment: NodeJS.ProcessEnv): void {
  const merged: Record<string, string> = {};
  for (const path of paths) {
    const values = readEnvFile(path);
    if (Object.keys(values).length === 0) throw new Error(`env file ${path} is missing or empty`);
    Object.assign(merged, values);
  }
  for (const [key, value] of Object.entries(merged)) environment[key] ??= value;
}
