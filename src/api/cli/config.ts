import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What `self-bench login` keeps: the deployment, its key, and the chosen workspace. */
export interface CliConfig {
  apiUrl?: string;
  apiKey?: string;
  /** The key's id, so `logout` can revoke it. */
  keyId?: number;
  login?: string;
  org?: string;
}

function directory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "self-bench");
}

export const configPath = () => join(directory(), "config.json");

export function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

/** Saves the config readable by its owner only, since it holds an API key. */
export function writeConfig(config: CliConfig): void {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}
