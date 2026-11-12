import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { harborAgentOptions } from "../../src/contracts/harbor-agent-options.js";
import { HARBOR_VERSION, harborPython } from "../../src/harnesses/harbor/command.js";
import { runCommand } from "../../src/lib/process.js";

/**
 * The harness options a condition can set (harbor-agent-options.ts) are read from Harbor's agents
 * by scripts/harbor_agent_options.py. After a Harbor upgrade this fails until the file is written
 * again, so whoever upgrades sees each new option. Runs where harbor-contract.test.ts does.
 */
const python = await harborPython(process.env).catch(() => undefined);
const version = python
  ? (await runCommand(python, ["-c", "import harbor; print(harbor.__version__)"])).stdout.trim()
  : undefined;
if (process.env.SELFBENCH_REQUIRE_HARBOR === "1" && version !== HARBOR_VERSION)
  throw new Error(`Harbor ${HARBOR_VERSION} is required; found ${version ?? "none"}`);

test.skipIf(version !== HARBOR_VERSION)(
  "the harness options a condition can set are the installed Harbor's",
  async () => {
    const script = fileURLToPath(new URL("../../scripts/harbor_agent_options.py", import.meta.url));
    const result = await runCommand(python ?? "python3", [script], {
      env: { PATH: process.env.PATH, HOME: tmpdir(), HARBOR_TELEMETRY: "off" },
    });
    const generated = result.stdout;
    const body = generated.slice(generated.indexOf("= ") + 2, generated.lastIndexOf(" as const"));
    expect(JSON.parse(body)).toEqual(harborAgentOptions);
  },
  60_000,
);
