#!/usr/bin/env bun
/**
 * avyayv — put any docker compose stack behind a subdomain of this machine.
 *
 *   avyayv up [--name S] [--port N] [--build] [dir]   start the stack in dir; it answers at
 *                                                     http://<name>.<domain>
 *   avyayv down [<name>|dir]                          stop the stack and drop its subdomain
 *   avyayv ls                                         what is running, and where
 *
 * The shared door is the dev proxy: Caddy routes <name>.<domain> to the stack's host port on
 * loopback, CoreDNS answers every name under the domain with this machine's address, and
 * `avyayv up` starts the pair if it is not running. Nothing here is reachable off the tailnet.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DOMAIN = process.env.SELFBENCH_DEV_DOMAIN?.trim() || "stack.avyayv.com";
const PROXY_PORT = process.env.SELFBENCH_DEV_PROXY_PORT?.trim() || "8000";
const CONFIG_DIR = process.env.SELFBENCH_CONFIG_DIR?.trim() || join(homedir(), ".selfbench");
const SITES_DIR = join(CONFIG_DIR, "dev-proxy", "sites");
const MAPPINGS_DIR = join(CONFIG_DIR, "dev-proxy", "mappings");
const PROXY_PROJECT = "selfbench-dev-proxy";
const PROXY_FILE = join(import.meta.dir, "compose.yaml");
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

interface Mapping {
  readonly name: string;
  readonly project: string;
  readonly dir: string;
  readonly port: string;
}

function sh(command: string, args: string[], { quiet = false } = {}): string {
  const child = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = child.stdout.toString().trim();
  if (child.exitCode !== 0 && !quiet) {
    const error = child.stderr.toString().trim() || out || `${command} exited ${child.exitCode}`;
    console.error(`avyayv: ${error}`);
    process.exit(1);
  }
  return out;
}

function compose(args: readonly string[], { quiet = false } = {}): string {
  return sh("docker", ["compose", ...args], { quiet });
}

function composeFileOf(dir: string): string {
  const file = COMPOSE_FILES.map((name) => join(dir, name)).find((path) => existsSync(path));
  if (!file) {
    console.error(`avyayv: no compose file in ${dir}`);
    process.exit(1);
  }
  return file;
}

function mappings(): Mapping[] {
  if (!existsSync(MAPPINGS_DIR)) return [];
  return readdirSync(MAPPINGS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(MAPPINGS_DIR, file), "utf8")) as Mapping);
}

function origin(): string {
  return `http://${DOMAIN}${PROXY_PORT === "80" ? "" : `:${PROXY_PORT}`}`;
}

function ensureProxy(): void {
  const running =
    sh("docker", ["ps", "--filter", `name=${PROXY_PROJECT}-caddy`, "--filter", "status=running", "-q"], {
      quiet: true,
    }) !== "";
  if (running) return;
  compose(["--project-name", PROXY_PROJECT, "--file", PROXY_FILE, "up", "-d"]);
}

function registerSite(name: string, port: string): void {
  mkdirSync(SITES_DIR, { recursive: true });
  writeFileSync(
    join(SITES_DIR, `${name}.caddy`),
    `http://${name}.${DOMAIN} {\n\treverse_proxy host.docker.internal:${port}\n}\n`,
  );
  compose([
    "--project-name",
    PROXY_PROJECT,
    "exec",
    "caddy",
    "caddy",
    "reload",
    "--config",
    "/etc/caddy/Caddyfile",
  ]);
}

function publishedPorts(project: string, file: string): string[] {
  const rows = compose(
    ["--project-name", project, "--file", file, "ps", "--format", "json", "--all"],
    { quiet: true },
  );
  const ports = new Set<string>();
  for (const line of rows.split("\n").filter(Boolean)) {
    for (const publisher of (JSON.parse(line).Publishers ?? []) as { PublishedPort: number }[]) {
      if (publisher.PublishedPort > 0) ports.add(String(publisher.PublishedPort));
    }
  }
  return [...ports];
}

async function up(args: string[]): Promise<void> {
  let name = "";
  let port = "";
  let build = false;
  let dir = process.cwd();
  const rest = [...args];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--name") name = rest.shift() ?? "";
    else if (arg === "--port") port = rest.shift() ?? "";
    else if (arg === "--build") build = true;
    else if (arg !== undefined) dir = resolve(arg);
  }
  name = name || randomBytes(3).toString("hex"); // e.g. "9f3ab1"; short, random, disposable
  const existing = mappings().find((mapping) => mapping.name === name);
  if (existing && existing.dir !== dir) {
    console.error(`avyayv: ${name}.${DOMAIN} already serves ${existing.dir}`);
    process.exit(1);
  }
  const file = composeFileOf(dir);
  const project = `avyayv-${name}`;

  compose(["--project-name", project, "--file", file, "up", "-d", ...(build ? ["--build"] : [])]);
  const ports = publishedPorts(project, file);
  if (port === "" && ports.length !== 1) {
    console.error(
      ports.length === 0
        ? `avyayv: ${project} publishes no host port; publish one or pass it with --port`
        : `avyayv: several ports are published (${ports.join(", ")}); pass one with --port`,
    );
    process.exit(1);
  }
  const target = port || ports[0]!;

  ensureProxy();
  registerSite(name, target);
  mkdirSync(MAPPINGS_DIR, { recursive: true });
  writeFileSync(
    join(MAPPINGS_DIR, `${name}.json`),
    `${JSON.stringify({ name, project, dir, port: target }, null, 2)}\n`,
  );
  console.log(`http://${name}.${DOMAIN} -> ${dir} (port ${target})`);
  console.log(`stop it: avyayv down ${name}`);
}

function down(args: string[]): void {
  const target = args[0] ?? process.cwd();
  const absolute = resolve(target);
  const mapping = mappings().find((m) => m.dir === absolute || m.name === basename(absolute));
  if (!mapping) {
    console.error(`avyayv: nothing running for ${target}`);
    process.exit(1);
  }
  compose(["--project-name", mapping.project, "--file", composeFileOf(mapping.dir), "down"], {
    quiet: true,
  });
  rmSync(join(SITES_DIR, `${mapping.name}.caddy`), { force: true });
  rmSync(join(MAPPINGS_DIR, `${mapping.name}.json`), { force: true });
  if (existsSync(join(PROXY_FILE))) registerSite(mapping.name, mapping.port); // reloads without the site
  console.log(`avyayv: ${mapping.name}.${DOMAIN} stopped`);
}

function ls(): void {
  for (const mapping of mappings()) {
    console.log(`${mapping.name}.${DOMAIN}\t${mapping.dir} (port ${mapping.port})`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "up") await up(args);
else if (command === "down") down(args);
else if (command === "ls") ls();
else {
  console.error(
    "usage: avyayv up [--name S] [--port N] [--build] [dir]\n       avyayv down [<name>|dir]\n       avyayv ls",
  );
  process.exit(1);
}
