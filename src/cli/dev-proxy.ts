import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCommand } from "../process.js";
import { projectRoot as packageRoot } from "../project-paths.js";
import { selfBenchConfigDirectory } from "../setup/vercel/profile.js";
import { fail } from "./values.js";

const PROJECT = "selfbench-dev-proxy";

/** The machine-wide proxy settings, all from the environment (usually the checkout's `.env`). */
export interface DevProxy {
  /** Stacks answer at `http://<project>.<domain>`; the DNS service answers everything under it. */
  readonly domain: string;
  /** This machine's address on the network browsers use, e.g. its tailnet IP. */
  readonly ip: string;
  /** The host port Caddy listens on; 80 unless the runtime keeps it (OrbStack does). */
  readonly port: string;
  /** Where `self-bench up` writes one Caddy site file per stack. */
  readonly sites: string;
}

export function devProxyFor(environment: Record<string, string>): DevProxy | undefined {
  const domain = environment.SELFBENCH_DEV_DOMAIN?.trim().toLowerCase();
  if (!domain) return undefined;
  const ip = environment.SELFBENCH_DEV_PROXY_IP?.trim();
  if (!ip) fail("SELFBENCH_DEV_PROXY_IP is required with SELFBENCH_DEV_DOMAIN");
  return {
    domain,
    ip,
    port: environment.SELFBENCH_DEV_PROXY_PORT?.trim() || "80",
    sites: join(selfBenchConfigDirectory(environment), "dev-proxy", "sites"),
  };
}

/** The origin browsers open for a hostname behind the proxy. */
export function proxiedOrigin(proxy: Pick<DevProxy, "port">, hostname: string): string {
  return proxy.port === "80" ? `http://${hostname}` : `http://${hostname}:${proxy.port}`;
}

/** The Caddy site block that forwards one stack's hostname to its API port on the host. */
export function renderSite(hostname: string, port: string): string {
  return `http://${hostname} {\n\treverse_proxy host.docker.internal:${port}\n}\n`;
}

/** Registers a running stack with the proxy; a reload failure only means the proxy is not up. */
export async function registerSite(
  proxy: DevProxy,
  project: string,
  hostname: string,
  port: string,
): Promise<void> {
  await mkdir(proxy.sites, { recursive: true });
  await writeFile(join(proxy.sites, `${project}.caddy`), renderSite(hostname, port));
  if (!(await reload(proxy))) {
    console.log(`The dev proxy is not running; start it with: self-bench proxy up`);
  }
}

export async function unregisterSite(proxy: DevProxy, project: string): Promise<void> {
  await rm(join(proxy.sites, `${project}.caddy`), { force: true });
  await reload(proxy);
}

async function reload(proxy: DevProxy): Promise<boolean> {
  try {
    await runCommand("docker", [
      ...compose(),
      "exec",
      "caddy",
      "caddy",
      "reload",
      "--config",
      "/etc/caddy/Caddyfile",
    ]);
    return true;
  } catch {
    return false;
  }
}

function compose(): string[] {
  const file = resolve(packageRoot(import.meta.url), "dev-proxy", "compose.yaml");
  return ["compose", "--project-name", PROJECT, "--file", file];
}

/** `self-bench proxy up|down`: the shared Caddy + CoreDNS pair for this machine. */
export async function proxy(args: string[], environment: Record<string, string>): Promise<void> {
  const [action] = args;
  const settings = devProxyFor(environment);
  if (!settings) fail("set SELFBENCH_DEV_DOMAIN and SELFBENCH_DEV_PROXY_IP (see .env.example)");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SELFBENCH_DEV_DOMAIN: settings.domain,
    SELFBENCH_DEV_PROXY_IP: settings.ip,
    SELFBENCH_DEV_PROXY_PORT: settings.port,
    SELFBENCH_DEV_PROXY_SITES: settings.sites,
  };
  switch (action) {
    case "up": {
      await mkdir(settings.sites, { recursive: true });
      await runCommand("docker", [...compose(), "up", "-d"], { env });
      console.log(
        `SelfBench dev proxy is up: ${proxiedOrigin(settings, `<project>.${settings.domain}`)} -> this machine`,
      );
      console.log(
        `Point split DNS for ${settings.domain} at ${settings.ip} (Tailscale admin: DNS, add nameserver, restrict to domain).`,
      );
      console.log(
        `Register one GitHub OAuth callback with wildcard matching: ${proxiedOrigin(settings, settings.domain)}/auth/github/callback`,
      );
      return;
    }
    case "down":
      await runCommand("docker", [...compose(), "down"], { env });
      return;
    default:
      fail("proxy supports: self-bench proxy up | self-bench proxy down");
  }
}
