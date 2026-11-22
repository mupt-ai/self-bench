import { parseArgs } from "node:util";
import { fail } from "../../lib/util.js";
import { download, passthrough } from "./api-client.js";
import { requiredArgument } from "./values.js";

const RUN_USAGE = "usage: self-bench operator run list | operator run show|cancel|download RUN_ID";

/**
 * `operator run|grant`: deployment-level commands on SELFBENCH_API_TOKEN, the deployment's own
 * token. `status`, `cancel`, `list`, `download`, and `grant` were once top-level commands.
 */
export async function operatorCommand(args: string[]): Promise<void> {
  const [noun, ...rest] = args;
  if (noun === "run") return await runCommand(rest);
  if (noun === "grant") return await grantCommand(rest);
  throw new Error("usage: self-bench operator run|grant … (see self-bench operator --help)");
}

/** `operator run list|show|cancel|download`: generation runs, and a batch's Harbor export. */
export async function runCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "list") return await passthrough("GET", "/v1/runs");
  const runId = encodeURIComponent(requiredArgument(rest, "RUN_ID"));
  if (action === "show") return await passthrough("GET", `/v1/runs/${runId}`);
  if (action === "cancel") return await passthrough("POST", `/v1/runs/${runId}/cancel`);
  if (action === "download")
    return await download(
      requiredArgument(rest, "RUN_ID"),
      rest[1] ?? fail("OUT.tar.gz is required"),
    );
  throw new Error(RUN_USAGE);
}

/** `grant create|list|revoke`: customers' pull grants for tasks' images (registry-grants.ts). */
export async function grantCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "list") return await passthrough("GET", "/v1/registry-grants");
  if (action === "revoke")
    return await passthrough(
      "POST",
      `/v1/registry-grants/${encodeURIComponent(requiredArgument(rest, "grant ID"))}/revoke`,
    );
  if (action !== "create")
    throw new Error(
      "usage: self-bench operator grant create|list | operator grant revoke GRANT_ID",
    );
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
