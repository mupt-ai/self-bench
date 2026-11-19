// What a Dari connection serves, shared with the web app, so no Node imports.
import type { LinkGrant } from "@mupt-ai/dari-gateway/link/client";
import { z } from "zod";

/** Dari's kind for an API key on a grant. */
export const DARI_API_KEY = "api_key";

/**
 * What a Dari Link credential seals: the grant's refresh token, the one string a confidential
 * client keeps (it never changes, and is useless without SelfBench's client secret), and what the
 * grant shared when it was connected, which the Run page offers without asking Dari.
 */
export interface DariLinkSecret {
  readonly refreshToken: string;
  readonly grant: Pick<LinkGrant, "grantId" | "plans" | "models">;
}

const model = z.object({ id: z.string() }).loose();
const secretSchema = z
  .object({
    refreshToken: z.string().startsWith("dlk_rt_"),
    grant: z
      .object({
        grantId: z.string().min(1),
        plans: z.array(z.object({ kind: z.string(), models: z.array(model) }).loose()),
        models: z.array(model),
      })
      .loose(),
  })
  .strict();

export function readDariLinkSecret(value: string): DariLinkSecret | undefined {
  try {
    const parsed = secretSchema.safeParse(JSON.parse(value));
    return parsed.success ? (parsed.data as unknown as DariLinkSecret) : undefined;
  } catch {
    return undefined;
  }
}

/** What a sealed Dari connection serves: the Run page offers these. */
export function linkModelsOf(value: string | undefined): DariLinkModels | undefined {
  const secret = value ? readDariLinkSecret(value) : undefined;
  return secret && grantModels(secret.grant);
}

/**
 * The one harness a plan that serves only its vendor's own coding agent runs on: Claude Code for a
 * Claude plan, Muse Code for a Muse plan.
 */
export type DariLinkOnly = "claude-code" | "muse-code";
const onlyHarness: Readonly<Record<string, DariLinkOnly>> = {
  claude_code_only: "claude-code",
  muse_code_only: "muse-code",
};

/**
 * What one Dari connection lets SelfBench run. `models` are Dari's model ids
 * (`anthropic/claude-sonnet-5-5`, `opencode-go/glm-5.3`); `only` names the one harness a model
 * runs on when only a Claude or Muse plan serves it. `prefixes` are a gateway key's (`openrouter/`):
 * any of that gateway's models.
 */
export interface DariLinkModels {
  readonly models: readonly {
    readonly id: string;
    readonly name?: string;
    readonly only?: DariLinkOnly;
  }[];
  readonly prefixes: readonly string[];
  /** What the user shared, as Dari names it: `Claude`, `ChatGPT`, `OpenRouter API Key`. */
  readonly plans?: readonly string[];
}

/** Dari's model id as SelfBench saves it: a request's name for it without `dari/model/`. */
export const dariModelId = (name: string) => name.replace(/^dari\/model\//, "");

/** The name a request carries for a model on the gateway, `dari/model/<id>`, served exactly. */
export const dariRequestName = (id: string) => `dari/model/${id}`;

/**
 * What a grant serves: every model a plan or key lists, marked with the one harness its plan runs
 * on when nothing serving any app lists it, and each gateway key's prefix.
 */
function grantModels(grant: Pick<LinkGrant, "plans" | "models">): DariLinkModels {
  const names = new Map<string, string>();
  const anyApp = new Set<string>();
  const only = new Map<string, DariLinkOnly>();
  const note = (entry: { id: string; name?: string }) => {
    const id = dariModelId(entry.id);
    if (entry.name && !names.has(id)) names.set(id, entry.name);
    return id;
  };
  for (const entry of grant.models) anyApp.add(note(entry));
  for (const plan of grant.plans) {
    const harness = onlyHarness[plan.serves];
    for (const entry of plan.models) {
      const id = note(entry);
      if (!harness) anyApp.add(id);
      else if (!only.has(id)) only.set(id, harness);
    }
  }
  return {
    models: [...new Set([...anyApp, ...only.keys()])].map((id) => {
      const name = names.get(id);
      const harness = anyApp.has(id) ? undefined : only.get(id);
      return { id, ...(name ? { name } : {}), ...(harness ? { only: harness } : {}) };
    }),
    prefixes: [
      ...new Set(
        grant.plans.flatMap((plan) =>
          plan.model_prefix && !onlyHarness[plan.serves] ? [plan.model_prefix] : [],
        ),
      ),
    ],
    plans: [
      ...new Set(
        grant.plans.map((plan) =>
          plan.kind === DARI_API_KEY ? plan.plan || plan.title : plan.title || plan.kind,
        ),
      ),
    ],
  };
}

/**
 * Whether a connection serves Dari's model `id`, and the one harness it runs on if only a Claude or
 * Muse plan serves it: by name, or as a model of a gateway it holds a key for.
 */
export function linkedModel(
  models: DariLinkModels | undefined,
  id: string,
): { only?: DariLinkOnly } | undefined {
  const named = models?.models.find((entry) => entry.id === id);
  if (named) return named.only ? { only: named.only } : {};
  return models?.prefixes.some((prefix) => id.startsWith(prefix) && id.length > prefix.length)
    ? {}
    : undefined;
}

const purpose = "on your repository's SelfBench benchmark tasks.";
/**
 * What Connect with Dari asks Dari for: the plans SelfBench runs (a Claude plan serves only Claude
 * Code and a Muse plan only Muse Code; ChatGPT and OpenCode Go plans serve any app), every API key
 * Dari connects, and what it does with each.
 */
export const dariLinkRequest = {
  clients: ["claude_code", "codex", "muse_code"],
  plans: ["anthropic_claude_code", "openai_codex", "meta_muse", "opencode_go", DARI_API_KEY],
  purposes: {
    claude_code: `Runs Claude Code ${purpose}`,
    muse_code: `Runs Muse Code ${purpose}`,
    any_app: `Runs Pi, Codex, Claude Code and other agents ${purpose}`,
  },
};

/** What `DariLink.open` needs in the browser: nothing secret. */
export interface DariLinkBrowserConfig {
  readonly gatewayUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
}
