/**
 * Local loop for selfbench.dev: Postgres in Docker, the API with GitHub sign-in on one port,
 * Vite on another proxying /v1, /api and /auth to it. GitHub's callback lands on the Vite
 * origin, so the OAuth app's callback URL is http://localhost:<vite port>/auth/github/callback.
 *
 *   bun run dev:site
 *
 * Secrets come from .env.site next to package.json (gitignored):
 *   GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, SELFBENCH_SESSION_SECRET,
 *   optional SELFBENCH_ALLOWED_GITHUB_ORGS.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const VITE_PORT = Number(process.env.SELFBENCH_SITE_PORT ?? 5173);
const API_PORT = Number(process.env.SELFBENCH_SITE_API_PORT ?? 8087);
const PG_PORT = Number(process.env.SELFBENCH_SITE_PG_PORT ?? 5433);
const PG_CONTAINER = "selfbench-site-postgres";
const PG_IMAGE = "postgres:17.6-bookworm";

const env: NodeJS.ProcessEnv = { ...process.env, ...readEnvFile(resolve(root, ".env.site")) };
const missing = ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"].filter(
  (name) => !env[name],
);
if (missing.length > 0) {
  console.error(`missing ${missing.join(", ")}; put them in ${resolve(root, ".env.site")}`);
  process.exit(1);
}
if (!env.SELFBENCH_SESSION_SECRET) {
  console.error(
    "missing SELFBENCH_SESSION_SECRET (32+ characters); generate one with\n" +
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
  );
  process.exit(1);
}

await ensurePostgres();

const apiEnv: NodeJS.ProcessEnv = {
  ...env,
  SELFBENCH_API_HOST: "127.0.0.1",
  SELFBENCH_API_PORT: String(API_PORT),
  SELFBENCH_PUBLIC_URL: env.SELFBENCH_PUBLIC_URL ?? `http://localhost:${VITE_PORT}`,
  SELFBENCH_DATABASE_URL:
    env.SELFBENCH_DATABASE_URL ??
    `postgres://selfbench:selfbench@127.0.0.1:${PG_PORT}/selfbench`,
  // The login loop does not need Temporal; connect only if a run route is ever hit.
  SELFBENCH_TEMPORAL_CONNECT: env.SELFBENCH_TEMPORAL_CONNECT ?? "lazy",
};
const api = spawn("bunx", ["tsx", "src/api-main.ts"], { cwd: root, env: apiEnv, stdio: "inherit" });
const vite = spawn(
  "bunx",
  ["vite", "--config", "review/vite.config.ts", "--port", String(VITE_PORT), "--strictPort"],
  {
    cwd: root,
    env: { ...env, SELFBENCH_VIEW_PROXY: `http://127.0.0.1:${API_PORT}` },
    stdio: "inherit",
  },
);

console.log(`
selfbench.dev dev loop
  site        http://localhost:${VITE_PORT}
  api         http://127.0.0.1:${API_PORT}
  postgres    ${apiEnv.SELFBENCH_DATABASE_URL}
  callback    ${apiEnv.SELFBENCH_PUBLIC_URL}/auth/github/callback
`);

const shutdown = () => {
  api.kill("SIGTERM");
  vite.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
for (const child of [api, vite]) {
  child.once("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
}

/** Starts (or creates) the site's own Postgres container and waits until it accepts connections. */
async function ensurePostgres(): Promise<void> {
  const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", PG_CONTAINER]);
  if (state.code !== 0) {
    console.log(`creating ${PG_CONTAINER} (${PG_IMAGE}) on 127.0.0.1:${PG_PORT}`);
    const created = await run("docker", [
      "run",
      "-d",
      "--name",
      PG_CONTAINER,
      "-p",
      `127.0.0.1:${PG_PORT}:5432`,
      "-e",
      "POSTGRES_USER=selfbench",
      "-e",
      "POSTGRES_PASSWORD=selfbench",
      "-e",
      "POSTGRES_DB=selfbench",
      PG_IMAGE,
    ]);
    if (created.code !== 0) throw new Error(`docker run failed: ${created.stderr}`);
  } else if (state.stdout.trim() !== "true") {
    const started = await run("docker", ["start", PG_CONTAINER]);
    if (started.code !== 0) throw new Error(`docker start failed: ${started.stderr}`);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await run("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", "selfbench"]);
    if (ready.code === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${PG_CONTAINER} did not become ready`);
}

function run(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => resolveRun({ code: null, stdout, stderr: error.message }));
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** KEY=value lines; quotes stripped, comments and blanks skipped. Never logged. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key) values[key] = value;
  }
  return values;
}
