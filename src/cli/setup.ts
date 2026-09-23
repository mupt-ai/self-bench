import { parseArgs } from "node:util";
import { setupE2B } from "../setup/e2b/index.js";
import { setupVercel } from "../setup/vercel/index.js";
import { SetupCanceledError } from "./terminal-prompts.js";
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
