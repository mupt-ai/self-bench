import { z } from "zod";

/**
 * What one sandbox may use: vCPUs, memory and disk (MiB). A sandbox credential saves the most its
 * account allows (its plan's per-sandbox limits), typed in or inferred from the provider with its
 * key (resource-inference.ts). A task asking for more is refused before any trial of it starts,
 * rather than failing partway through, after its image builds or its agent has spent.
 */
export const resourceLimitsSchema = z
  .object({
    cpus: z.number().positive().max(1024).optional(),
    memoryMb: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024)
      .optional(),
    storageMb: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

/** Limits to save: checked, and null without any dimension. */
export function savedResourceLimits(limits: ResourceLimits | undefined): ResourceLimits | null {
  const parsed = limits && resourceLimitsSchema.parse(limits);
  return parsed && Object.keys(parsed).length ? parsed : null;
}

/** What a task's `[environment]` asks for; an absent value takes the provider's default. */
export type ResourceRequest = ResourceLimits;

export interface ResourceCheck {
  /** A request over a limit: the task cannot run on this credential. */
  errors: string[];
  /** A request the provider will change (rounding), or one that leaves no headroom. */
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Harbor's size strings (`"4G"`, `"512M"`, `"2Gi"`) in MiB; a bare number is MiB. */
function mebibytes(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(value);
  if (!match) return undefined;
  const scale = { "": 1, k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[
    (match[2] ?? "").toLowerCase() as "" | "k" | "m" | "g" | "t"
  ];
  const size = Number(match[1]) * scale;
  return size > 0 ? Math.ceil(size) : undefined;
}

/** A parsed task.toml's requested resources (`cpus`, `memory_mb`/`memory`, `storage_mb`/`storage`). */
export function requestedResources(config: Record<string, unknown>): ResourceRequest {
  const environment = isRecord(config.environment) ? config.environment : {};
  const cpus =
    typeof environment.cpus === "number" && environment.cpus > 0 ? environment.cpus : undefined;
  const memoryMb = mebibytes(environment.memory_mb) ?? mebibytes(environment.memory);
  const storageMb = mebibytes(environment.storage_mb) ?? mebibytes(environment.storage);
  return {
    ...(cpus !== undefined ? { cpus } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(storageMb !== undefined ? { storageMb } : {}),
  };
}

const size = (mib: number) =>
  mib >= 1024 ? `${Number((mib / 1024).toFixed(1))} GiB` : `${mib} MiB`;

const DIMENSIONS = [
  { key: "cpus", label: "CPUs", format: (value: number) => `${value}` },
  { key: "memoryMb", label: "memory", format: size },
  { key: "storageMb", label: "storage", format: size },
] as const;

/** A request within this share of a limit leaves too little room for the agent's own work. */
const HEADROOM = 0.9;

/**
 * Checks what a task asks for against a sandbox credential's limits. `provider` names the sandbox,
 * for what it does to a request (E2B and Daytona take whole CPUs).
 */
export function checkResources(
  request: ResourceRequest,
  limits: ResourceLimits | undefined,
  provider?: string,
): ResourceCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const { key, label, format } of DIMENSIONS) {
    const asked = request[key];
    const limit = limits?.[key];
    if (asked === undefined || limit === undefined) continue;
    if (asked > limit)
      errors.push(`asks for ${format(asked)} ${label}; the limit is ${format(limit)}`);
    else if (asked >= limit * HEADROOM && asked < limit)
      warnings.push(`asks for ${format(asked)} ${label}, close to the limit of ${format(limit)}`);
  }
  const cpus = request.cpus;
  if (
    cpus !== undefined &&
    !Number.isInteger(cpus) &&
    (provider === "e2b" || provider === "daytona")
  )
    warnings.push(
      `asks for ${cpus} CPUs; ${provider === "e2b" ? "E2B" : "Daytona"} gives whole CPUs, so it gets ${Math.max(1, Math.floor(cpus))}`,
    );
  return { errors, warnings };
}

/** A refusal naming each task over a limit, at most five of them. */
export function resourceRefusal(
  problems: readonly { task: string; errors: readonly string[] }[],
): string | undefined {
  const failing = problems.filter((problem) => problem.errors.length);
  if (!failing.length) return undefined;
  const lines = failing
    .slice(0, 5)
    .map((problem) => `${problem.task} ${problem.errors.join(", ")}`);
  const more = failing.length > 5 ? `; and ${failing.length - 5} more tasks` : "";
  return `Over the sandbox credential's resource limits: ${lines.join("; ")}${more}. Raise the credential's limits if the account allows more, or pick another sandbox.`;
}
