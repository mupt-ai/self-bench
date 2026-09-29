import { buildCommit } from "../../contracts/config/build-metadata.js";

type Env = Readonly<Record<string, string | undefined>>;

/** `dev` or `prod` as Terraform deploys it; anything else, such as a Compose stack, is `local`. */
export function telemetryEnvironment(env: Env = process.env): string {
  return env.SELFBENCH_ENVIRONMENT?.trim() || "local";
}

/** The build's commit, or undefined for a checkout built without one. */
export function telemetryRelease(): string | undefined {
  return /^0+$/.test(buildCommit) ? undefined : buildCommit;
}

export function envValue(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}
