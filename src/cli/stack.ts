import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadWorkerConfig } from "../config.js";
import { runCommand } from "../process.js";
import { projectRoot as packageRoot } from "../project-paths.js";
import {
  isExecutionBackend,
  isHarborEnvironment,
  matchingHarborEnvironment,
} from "../providers.js";
import { setupE2B } from "../setup/e2b/index.js";
import { applyVercelProfile, setupVercel } from "../setup/vercel/index.js";
import { SetupCanceledError } from "../terminal-prompts.js";
import { resolveSelfBenchCommit } from "./repository.js";
import { readEnvFile, stackEnvironment } from "./stack-environment.js";
import { fail } from "./values.js";

export async function setup(args: string[]): Promise<void> {
  const [provider, ...providerArgs] = args;
  switch (provider) {
    case "e2b":
      await setupE2B(providerArgs);
      return;
    case "vercel":
      await setupVercelProvider(providerArgs);
      return;
    default:
      fail("setup supports: self-bench setup vercel | self-bench setup e2b");
  }
}

async function setupVercelProvider(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      profile: { type: "string", default: "default" },
      verbose: { type: "boolean", default: false },
    },
    strict: true,
  });
  try {
    await setupVercel({
      profileName: parsed.values.profile,
      verbose: parsed.values.verbose,
    });
  } catch (error) {
    if (error instanceof SetupCanceledError) {
      process.exitCode = 130;
      return;
    }
    throw error;
  }
}

export async function up(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      backend: { type: "string", default: "docker" },
      "harbor-environment": { type: "string" },
      "modal-config": { type: "string" },
      "vercel-profile": { type: "string" },
    },
    strict: true,
  });
  if (!isExecutionBackend(parsed.values.backend)) {
    fail('--backend must be "docker", "modal", "vercel", or "e2b"');
  }
  if (
    parsed.values["harbor-environment"] !== undefined &&
    !isHarborEnvironment(parsed.values["harbor-environment"])
  ) {
    fail('--harbor-environment must be "docker", "modal", "vercel", "e2b", or "daytona"');
  }

  const root = packageRoot(import.meta.url);
  const composeFile = resolve(root, "compose.yaml");
  const backend = parsed.values.backend;
  const harborEnvironment =
    parsed.values["harbor-environment"] ??
    matchingHarborEnvironment(backend) ??
    fail(`--harbor-environment is required with --backend ${backend}`);
  const usesModal = backend === "modal" || harborEnvironment === "modal";
  if (!usesModal && parsed.values["modal-config"] !== undefined) {
    fail("--modal-config requires Modal generation or Harbor");
  }
  if (backend !== "vercel" && parsed.values["vercel-profile"] !== undefined) {
    fail("--vercel-profile requires Vercel generation");
  }
  const stack = stackEnvironment(root);
  let environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...stack,
    SELFBENCH_BUILD_COMMIT: await resolveSelfBenchCommit(),
    SELFBENCH_EXECUTION_BACKEND: backend,
    SELFBENCH_HARBOR_ENVIRONMENT: harborEnvironment,
    ...(usesModal
      ? {
          SELFBENCH_MODAL_CONFIG_PATH: resolve(
            parsed.values["modal-config"] ?? resolve(homedir(), ".modal.toml"),
          ),
        }
      : {}),
  };
  if (backend === "vercel") {
    environment = await applyVercelProfile(environment, parsed.values["vercel-profile"]);
  }
  if (backend === "vercel" || backend === "e2b") {
    loadWorkerConfig(environment);
  }

  if (backend === "docker") {
    await runCommand(
      "docker",
      [
        "build",
        "-f",
        resolve(root, "Dockerfile.sandbox"),
        "-t",
        stack.SELFBENCH_DOCKER_IMAGE,
        root,
      ],
      { env: environment },
    );
  }
  await runCommand("docker", ["compose", "--file", composeFile, "up", "-d", "--build"], {
    env: environment,
  });
  console.log(
    `SelfBench is running with ${backend} generation and ${harborEnvironment} Harbor at ${stack.SELFBENCH_PUBLIC_URL}`,
  );
  console.log(
    `Compose project ${stack.COMPOSE_PROJECT_NAME}; Temporal on 127.0.0.1:${stack.SELFBENCH_TEMPORAL_PORT}`,
  );
  if (checkoutEnvironment(root).GITHUB_OAUTH_CLIENT_ID) {
    console.log(
      `GitHub sign-in callback: ${stack.SELFBENCH_PUBLIC_URL}/auth/github/callback (register it on the OAuth app)`,
    );
  }
  await registerTunnelRoute(stack);
}

/**
 * With a dev domain, the stack's public URL is the tunnel proxy's hostname, so it must be
 * registered there. The route is best effort: without the `tunnel` tool, or for stacks that
 * are not worktree-derived, the loopback URL keeps working.
 */
async function registerTunnelRoute(stack: ReturnType<typeof stackEnvironment>): Promise<void> {
  if (stack.SELFBENCH_SITE_HOSTNAME === "127.0.0.1") return;
  const route = await runCommand(
    "tunnel",
    [
      "up",
      "--local",
      "--name",
      stack.COMPOSE_PROJECT_NAME,
      "--port",
      stack.SELFBENCH_SITE_PORT,
      process.cwd(),
    ],
    { allowFailure: true },
  );
  const registered = route.exitCode === 0 && route.stdout.trim().length > 0;
  if (registered) {
    console.log(`Dev proxy route: ${route.stdout.trim().split("\n")[0]}`);
    return;
  }
  console.log(
    `Tunnel route was not registered (install the tunnel tool, or run: tunnel up --local --name ${stack.COMPOSE_PROJECT_NAME} --port ${stack.SELFBENCH_SITE_PORT})`,
  );
}

export async function down(): Promise<void> {
  const root = packageRoot(import.meta.url);
  const stack = stackEnvironment(root);
  await runCommand("docker", ["compose", "--file", resolve(root, "compose.yaml"), "down"], {
    env: { ...process.env, ...stack },
  });
  // The stack was started by this CLI, so its dev-proxy route (if any) is ours to drop.
  if (stack.SELFBENCH_SITE_HOSTNAME !== "127.0.0.1")
    await runCommand("tunnel", ["down", stack.COMPOSE_PROJECT_NAME], { allowFailure: true });
}

/** What Compose will see: the checkout's `.env` under the process environment. */
function checkoutEnvironment(root: string): Record<string, string> {
  const fromProcess = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { ...readEnvFile(resolve(root, ".env")), ...fromProcess };
}
