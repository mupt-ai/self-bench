import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** The project name plain `docker compose up` has always used; its volumes are `selfbench_*`. */
export const DEFAULT_STACK = "selfbench";
const DEFAULT_SITE_PORT = 8080;
const DEFAULT_TEMPORAL_PORT = 7233;
const DEFAULT_IMAGE = "selfbench:local";
const DEFAULT_SANDBOX_IMAGE = "selfbench-sandbox:local";
/** Derived ports land in 8100-8899 (site) and 7300-8099 (Temporal), clear of the defaults. */
const DERIVED_SITE_PORTS = { first: 8100, count: 800 };
const DERIVED_TEMPORAL_PORTS = { first: 7300, count: 800 };

export interface StackEnvironment {
  readonly COMPOSE_PROJECT_NAME: string;
  /** The stack's hostname behind the dev proxy, when `SELFBENCH_DEV_DOMAIN` is set. */
  readonly SELFBENCH_SITE_HOSTNAME: string;
  readonly SELFBENCH_IMAGE: string;
  readonly SELFBENCH_DOCKER_IMAGE: string;
  readonly SELFBENCH_SITE_PORT: string;
  readonly SELFBENCH_SITE_BIND: string;
  readonly SELFBENCH_TEMPORAL_PORT: string;
  readonly SELFBENCH_PUBLIC_URL: string;
}

/**
 * One Compose project per checkout, so several worktrees can run side by side. The project
 * name comes from the checkout directory (or `COMPOSE_PROJECT_NAME`); every other value is
 * derived from it unless the environment sets it explicitly. The canonical `self-bench`
 * checkout and packaged installs keep the historical `selfbench` project on 8080 and 7233.
 * Values in the checkout's `.env` count as environment, as they do for Compose itself.
 */
export function stackEnvironment(
  root: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): StackEnvironment {
  const environment = { ...readEnvFile(resolve(root, ".env")), ...defined(processEnvironment) };
  const project = environment.COMPOSE_PROJECT_NAME || projectNameFor(root);
  const derived = project !== DEFAULT_STACK;
  // Behind the dev proxy every stack has its own name under the domain and no port in its URL;
  // the API port itself stays on loopback for the proxy to reach.
  const devDomain = environment.SELFBENCH_DEV_DOMAIN?.trim().toLowerCase();
  const hostname =
    environment.SELFBENCH_SITE_HOSTNAME || (devDomain ? `${project}.${devDomain}` : "127.0.0.1");
  const sitePort =
    environment.SELFBENCH_SITE_PORT ||
    String(derived ? derivePort(project, DERIVED_SITE_PORTS) : DEFAULT_SITE_PORT);
  const proxyPort = environment.SELFBENCH_DEV_PROXY_PORT?.trim() || "80";
  const publicUrl = (
    environment.SELFBENCH_PUBLIC_URL ||
    (devDomain
      ? `http://${hostname}${proxyPort === "80" ? "" : `:${proxyPort}`}`
      : `http://${hostname}:${sitePort}`)
  ).replace(/\/+$/, "");
  return {
    COMPOSE_PROJECT_NAME: project,
    SELFBENCH_SITE_HOSTNAME: hostname,
    SELFBENCH_IMAGE:
      environment.SELFBENCH_IMAGE || (derived ? `${project}-selfbench:local` : DEFAULT_IMAGE),
    SELFBENCH_DOCKER_IMAGE:
      environment.SELFBENCH_DOCKER_IMAGE ||
      (derived ? `${project}-sandbox:local` : DEFAULT_SANDBOX_IMAGE),
    SELFBENCH_SITE_PORT: sitePort,
    SELFBENCH_SITE_BIND:
      environment.SELFBENCH_SITE_BIND ||
      (isLoopback(hostname) || devDomain ? "127.0.0.1" : "0.0.0.0"),
    SELFBENCH_TEMPORAL_PORT:
      environment.SELFBENCH_TEMPORAL_PORT ||
      String(derived ? derivePort(project, DERIVED_TEMPORAL_PORTS) : DEFAULT_TEMPORAL_PORT),
    SELFBENCH_PUBLIC_URL: publicUrl,
  };
}

/** Compose project names are lowercase `[a-z0-9_-]`; the canonical checkout maps to the default. */
export function projectNameFor(root: string): string {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return slug === "" || slug === "self-bench" ? DEFAULT_STACK : slug;
}

/** A stable port for the project: the same worktree gets the same port on every start. */
function derivePort(project: string, range: { first: number; count: number }): number {
  // 32-bit FNV-1a; small, dependency-free, and spreads similar branch names apart.
  let hash = 0x811c9dc5;
  for (const char of new TextEncoder().encode(project)) {
    hash ^= char;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return range.first + (hash % range.count);
}

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

function defined(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
