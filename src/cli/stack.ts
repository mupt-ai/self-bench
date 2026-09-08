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
import { devProxyFor, registerSite, unregisterSite } from "./dev-proxy.js";
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
    fail('--harbor-environment must be "docker" or "modal"');
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
  const proxy = devProxyFor(checkoutEnvironment(root));
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
  if (proxy) {
    await registerSite(
      proxy,
      stack.COMPOSE_PROJECT_NAME,
      stack.SELFBENCH_SITE_HOSTNAME,
      stack.SELFBENCH_SITE_PORT,
    );
  }
  console.log(
    `SelfBench is running with ${backend} generation and ${harborEnvironment} Harbor at ${stack.SELFBENCH_PUBLIC_URL}`,
  );
  console.log(
    `Compose project ${stack.COMPOSE_PROJECT_NAME}; Temporal on 127.0.0.1:${stack.SELFBENCH_TEMPORAL_PORT}`,
  );
  // Behind the proxy one wildcard callback on the domain covers every stack.
  if (checkoutEnvironment(root).GITHUB_OAUTH_CLIENT_ID && !proxy) {
    console.log(
      `GitHub sign-in callback: ${stack.SELFBENCH_PUBLIC_URL}/auth/github/callback (register it on the OAuth app)`,
    );
  }
}

export async function down(): Promise<void> {
  const root = packageRoot(import.meta.url);
  const stack = stackEnvironment(root);
  await runCommand("docker", ["compose", "--file", resolve(root, "compose.yaml"), "down"], {
    env: { ...process.env, ...stack },
  });
  const proxy = devProxyFor(checkoutEnvironment(root));
  if (proxy) await unregisterSite(proxy, stack.COMPOSE_PROJECT_NAME);
}

/** What Compose will see: the checkout's `.env` under the process environment. */
export function checkoutEnvironment(root: string): Record<string, string> {
  const fromProcess = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { ...readEnvFile(resolve(root, ".env")), ...fromProcess };
}
