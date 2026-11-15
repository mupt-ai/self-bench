import { isRecord } from "../../lib/util.js";

/**
 * The host variables a published Harbor task may read for an LLM judge (or a simulated user), as
 * `${NAME}` in an `env` table: SelfBench fills them from the benchmark's judge credential, never
 * from the worker's own environment.
 */
export const JUDGE_VARIABLES: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
]);

/** Harbor's own template (harbor/utils/env.py): a whole value of `${NAME}` or `${NAME:-default}`. */
const TEMPLATE = /^\$\{([^}:]+)(?::-(.*))?\}$/s;

/** One host variable a task's `env` table reads, where, and whether it has a default. */
export interface HostVariable {
  name: string;
  /** The `env` key it fills (`EVAL_BASE_URL = "${OPENAI_API_BASE}"`), which --verifier-env sets. */
  key: string;
  /** `verifier.env`, which a run can set directly (--verifier-env); others read the host's. */
  verifierOnly: boolean;
  required: boolean;
  /** The value it takes when the host does not set it (`${NAME:-fallback}`). */
  fallback?: string;
}

/** Every host variable the task.toml's `env` tables read; literal values read none. */
export function hostVariables(config: Record<string, unknown>): HostVariable[] {
  const found: HostVariable[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) for (const item of value) visit(item, path);
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (key === "env" && isRecord(child))
        for (const [envKey, text] of Object.entries(child)) {
          const match = typeof text === "string" ? TEMPLATE.exec(text) : null;
          if (match?.[1])
            found.push({
              name: match[1],
              key: envKey,
              verifierOnly: at === "verifier.env",
              required: match[2] === undefined,
              ...(match[2] !== undefined ? { fallback: match[2] } : {}),
            });
        }
      else if (at !== "metadata") visit(child, at);
    }
  };
  visit(config, "");
  return found;
}

/**
 * A `${NAME}` or `${NAME:-default}` anywhere outside `env` tables, such as an MCP server's
 * `headers`: Harbor interpolates those from the worker's environment too, and no run fills them.
 */
const INLINE_TEMPLATE = /\$\{([^}:]+)(?::-[^}]*)?\}/g;

function unreadHostVariable(config: Record<string, unknown>): string | undefined {
  const visit = (value: unknown, path: string): string | undefined => {
    if (typeof value === "string") {
      if (path.split(".").includes("env")) return undefined;
      for (const match of value.matchAll(INLINE_TEMPLATE)) if (match[1]) return match[1];
      return undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, path);
        if (found) return found;
      }
      return undefined;
    }
    if (!isRecord(value)) return undefined;
    for (const [key, child] of Object.entries(value)) {
      if (key === "metadata") continue;
      const found = visit(child, path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return undefined;
  };
  return visit(config, "");
}

/**
 * Why a published task's `env` tables can't run, if they can't: each value is literal, a judge
 * variable, or another variable with a default (which applies, since runs never set it).
 */
export function hostVariableRefusal(config: Record<string, unknown>): string | undefined {
  const unknown = hostVariables(config).find(
    (variable) => variable.required && !JUDGE_VARIABLES.has(variable.name),
  );
  if (unknown) return `task.toml reads the host variable ${unknown.name}`;
  const elsewhere = unreadHostVariable(config);
  return elsewhere && `task.toml reads the host variable ${elsewhere} outside its env tables`;
}

/**
 * What a task's LLM judge (or simulated user) reads: every judge variable, which a judge credential
 * fills, and those with no default, which it must.
 */
export interface JudgeNeeds {
  variables: string[];
  required: string[];
}

export function judgeNeeds(config: Record<string, unknown>): JudgeNeeds {
  return mergeJudgeNeeds([
    {
      variables: hostVariables(config)
        .filter((variable) => JUDGE_VARIABLES.has(variable.name))
        .map((variable) => variable.name),
      required: hostVariables(config)
        .filter((variable) => variable.required && JUDGE_VARIABLES.has(variable.name))
        .map((variable) => variable.name),
    },
  ]);
}

/** All of `needs` together, each list sorted without repeats. */
export function mergeJudgeNeeds(needs: readonly (JudgeNeeds | undefined)[]): JudgeNeeds {
  const sorted = (names: string[]) => [...new Set(names)].sort();
  return {
    variables: sorted(needs.flatMap((need) => need?.variables ?? [])),
    required: sorted(needs.flatMap((need) => need?.required ?? [])),
  };
}
