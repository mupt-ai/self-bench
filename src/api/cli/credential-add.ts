import { readFileSync } from "node:fs";
import { gateways } from "../../gateways/index.js";
import { requestJson } from "./api-client.js";
import { flag, type Values } from "./args.js";
import { signIn } from "./credential-sign-in.js";
import { ask, Cancelled, choose, grayLine, interactive, step } from "./tui.js";

const SUBTITLE = "Connect a credential";

/** Something a workspace can connect: a pasted key, or a provider sign-in. */
interface Provider {
  label: string;
  kind: string;
  description: string;
  sandbox?: true;
  signIn?: "codex-login" | "claude-login" | "muse-login";
  /** Fields asked for besides the secret, as the API names them. */
  extra?: { field: "tokenId" | "teamId" | "projectId" | "endpoint"; prompt: string }[];
  secretPrompt?: string;
}

const PROVIDERS: Provider[] = [
  {
    label: "ChatGPT Sign-In",
    kind: "openai",
    signIn: "codex-login",
    description: "Runs Codex on your ChatGPT plan; generates tasks too",
  },
  { label: "OpenAI API Key", kind: "openai", description: "GPT models through any harness" },
  {
    label: "Claude Sign-In",
    kind: "anthropic",
    signIn: "claude-login",
    description: "Runs Claude Code on your Claude plan; evaluations only",
  },
  {
    label: "Anthropic API Key",
    kind: "anthropic",
    description: "Claude models through any harness",
  },
  {
    label: "Meta Sign-In",
    kind: "meta",
    signIn: "muse-login",
    description: "Runs Muse Code on your Meta account; evaluations only",
  },
  { label: "Meta API Key", kind: "meta", description: "Meta models through any harness" },
  ...Object.entries(gateways).map(([kind, gateway]) => ({
    label: `${gateway.label} Key`,
    kind,
    description: "Every vendor's models with one key",
  })),
  { label: "Dari Key", kind: "dari", description: "Your Dari router" },
  {
    label: "Custom Endpoint",
    kind: "custom",
    description: "An OpenAI-compatible router or gateway",
    extra: [{ field: "endpoint", prompt: "Base URL (https://…/v1)" }],
  },
  { label: "E2B", kind: "e2b", description: "Runs tasks in its cloud sandboxes", sandbox: true },
  {
    label: "Modal",
    kind: "modal",
    description: "Runs tasks in its cloud sandboxes",
    sandbox: true,
    extra: [{ field: "tokenId", prompt: "Modal token ID (ak-…)" }],
    secretPrompt: "Modal token secret (as-…)",
  },
  {
    label: "Daytona",
    kind: "daytona",
    description: "Runs tasks in its cloud sandboxes",
    sandbox: true,
  },
  {
    label: "Vercel Sandbox",
    kind: "vercel",
    description: "Runs tasks in its cloud sandboxes",
    sandbox: true,
    extra: [
      { field: "teamId", prompt: "Vercel team ID" },
      { field: "projectId", prompt: "Vercel project ID" },
    ],
  },
];

/**
 * `credential add`: interactively, a page per choice; otherwise from flags. Secrets come from a
 * masked prompt, `--value-env NAME`, or `--value-stdin`, never from an argument.
 */
export async function addCredential(
  base: string,
  values: Values,
): Promise<Record<string, unknown>> {
  const provider = await pickProvider(values);
  const name =
    flag(values, "name") ??
    (interactive() && !flag(values, "kind")
      ? await ask(SUBTITLE, "Name this credential", {
          placeholder: `${provider.label} (enter to keep)`,
          fallback: provider.label,
        })
      : undefined) ??
    provider.label;
  if (provider.signIn) return await signIn(base, provider.signIn, provider.label, name);
  const extra: Record<string, string> = {};
  for (const { field, prompt } of provider.extra ?? []) {
    const given = flag(
      values,
      field.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`),
    );
    const value =
      given ?? (interactive() ? await ask(SUBTITLE, prompt, { placeholder: prompt }) : undefined);
    if (!value)
      throw new Error(
        `${provider.label} needs --${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
    extra[field] = value;
  }
  const body = (value: string) => ({ name, kind: provider.kind, auth: "api-key", value, ...extra });
  const supplied = await suppliedSecret(values);
  if (supplied) return await requestJson(base, "POST", body(supplied));
  if (!interactive()) throw new Error("pass the secret with --value-env NAME or --value-stdin");
  let saved: Record<string, unknown> | undefined;
  const entered = await ask(SUBTITLE, provider.secretPrompt ?? `${provider.label}`, {
    secret: true,
    details: [grayLine("Stored encrypted in your workspace; only its admins can change it.")],
    submit: async (value) => {
      saved = await requestJson(base, "POST", body(value));
    },
  });
  if (!entered || !saved) throw new Cancelled();
  return saved;
}

async function pickProvider(values: Values): Promise<Provider> {
  const kind = flag(values, "kind");
  const signIn = flag(values, "sign-in");
  if (signIn) {
    const auth = { chatgpt: "codex-login", claude: "claude-login", meta: "muse-login" }[signIn];
    const found = PROVIDERS.find((provider) => provider.signIn === auth);
    if (!found) throw new Error("--sign-in is chatgpt, claude, or meta");
    return found;
  }
  if (kind) {
    const found = PROVIDERS.find((provider) => provider.kind === kind && !provider.signIn);
    if (!found)
      throw new Error(
        `unknown --kind ${kind}; one of ${[...new Set(PROVIDERS.map((p) => p.kind))].join(", ")}`,
      );
    return found;
  }
  if (!interactive())
    throw new Error("credential add needs --kind or --sign-in when not in a terminal");
  const sandbox =
    (await choose(SUBTITLE, "What do you want to connect?", [
      { label: "Model Access", description: "A sign-in or API key that runs models" },
      {
        label: "Sandbox",
        description: "A cloud account that runs tasks: E2B, Modal, Daytona, Vercel",
      },
    ])) === 1;
  const offered = PROVIDERS.filter((provider) => (provider.sandbox === true) === sandbox);
  const index = await choose(
    SUBTITLE,
    sandbox ? "Which sandbox?" : "Which model access?",
    offered.map((provider) => ({ label: provider.label, description: provider.description })),
  );
  return offered[index] as Provider;
}

async function suppliedSecret(values: Values): Promise<string | undefined> {
  const variable = flag(values, "value-env");
  if (variable) {
    const value = process.env[variable]?.trim();
    if (!value) throw new Error(`${variable} is empty`);
    return value;
  }
  if (values["value-stdin"] === true) return readFileSync(0, "utf8").trim() || undefined;
  return undefined;
}

export const savedLine = (credential: Record<string, unknown>) =>
  step(`Connected ${String(credential.name ?? "credential")} (${String(credential.id ?? "")})`);
