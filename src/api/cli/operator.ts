import { parseArgs } from "node:util";
import { passthrough } from "./api-client.js";
import { requiredArgument } from "./values.js";

/** `grant create|list|revoke`: customers' pull grants for tasks' images (registry-grants.ts). */
export async function grantCommand(args: string[]): Promise<void> {
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
