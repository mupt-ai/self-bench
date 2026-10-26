import { parseArgs } from "node:util";
import { fail } from "../../lib/util.js";
import { download, passthrough } from "./api-client.js";
import { printHelp } from "./help.js";
import { requiredArgument } from "./values.js";

export async function runCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "status":
      await passthrough("GET", `/v1/runs/${requiredArgument(rest, "run ID")}`);
      break;
    case "cancel":
      await passthrough("POST", `/v1/runs/${requiredArgument(rest, "run ID")}/cancel`);
      break;
    case "list":
      await passthrough("GET", "/v1/runs");
      break;
    case "download":
      await download(requiredArgument(rest, "run ID"), rest[1] ?? fail("output path is required"));
      break;
    case "grant":
      await grantCommand(rest);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/** `grant create|list|revoke`: customers' pull grants for tasks' images (registry-grants.ts). */
async function grantCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "list") return await passthrough("GET", "/v1/registry-grants");
  if (action === "revoke")
    return await passthrough(
      "POST",
      `/v1/registry-grants/${encodeURIComponent(requiredArgument(rest, "grant ID"))}/revoke`,
    );
  if (action !== "create") throw new Error("usage: self-bench grant create|list|revoke");
  const { values } = parseArgs({
    args: rest,
    options: {
      label: { type: "string" },
      task: { type: "string", multiple: true },
      days: { type: "string" },
      "with-verifier": { type: "boolean", default: false },
    },
    strict: true,
  });
  const taskIds = (values.task ?? []).map(Number);
  if (!values.label || taskIds.length === 0 || taskIds.some((id) => !Number.isSafeInteger(id)))
    throw new Error("grant create needs --label and at least one numeric --task");
  await passthrough("POST", "/v1/registry-grants", {
    label: values.label,
    taskIds,
    withVerifier: values["with-verifier"],
    ...(values.days ? { days: Number(values.days) } : {}),
  });
}
