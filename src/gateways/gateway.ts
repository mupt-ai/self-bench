import { type Rates, type ThinkingLevel, thinkingLevels } from "../contracts/models.js";

/** A model a gateway lists that a coding agent can drive. */
export interface ListedModel {
  /** The gateway's id for it. */
  readonly id: string;
  readonly label: string;
  /** The reasoning efforts the gateway says it accepts, in display order. */
  readonly thinking?: readonly ThinkingLevel[];
  /**
   * Pi's models.json entry for it, from the gateway's listing, when Pi must be told how the
   * gateway takes the model: Pi guesses at a model its catalog lacks. Its harborPi adapter
   * writes it (harbor_gateway.py).
   */
  readonly pi?: PiModel;
}

/** A model in Pi's models.json (Pi's docs/models.md); what is left out takes Pi's defaults. */
export interface PiModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** $ per million tokens. */
  readonly cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Pi's thinking levels to the efforts the endpoint takes. */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string>>>;
  readonly compat?: Readonly<Record<string, boolean>>;
}

/** A gateway's list price for one model. */
export interface ListedRates {
  readonly rates: Rates;
  readonly asOf: string;
  /** The prompt size at which its long-context rates begin, when it charges more for those. */
  readonly longContextFrom?: number;
}

/** What a gateway's models API says: its agent-capable models, frontier first, and its prices. */
export interface GatewayListing {
  readonly models: readonly ListedModel[];
  /** List prices by the gateway's model id. */
  readonly rates: ReadonlyMap<string, ListedRates>;
}

/**
 * One API key that reaches every vendor's models. Its id (the key of `gateways` in index.ts) is
 * also its credential kind and Pi's provider name for it.
 */
export interface Gateway {
  readonly label: string;
  /** The variable its key travels under, for Pi and every Harbor harness. */
  readonly keyVariable: string;
  /** OpenAI-compatible base: Codex (Responses), Mini-SWE-Agent and Terminus 2 (Chat Completions). */
  readonly openAiBase: string;
  /** Anthropic Messages base, for Claude Code. */
  readonly anthropicBase: string;
  /** Hosts a trial's agent must reach. */
  readonly hosts: readonly string[];
  /** The Harbor agent that runs Pi over it: Harbor's own when Harbor knows its key variable. */
  readonly harborPi: string;
  /**
   * Vendors it spells differently from the catalog, which spells them as OpenRouter does: its
   * spelling to the catalog's ("zai" to "z-ai").
   */
  readonly vendorAliases?: Readonly<Record<string, string>>;
  readonly modelsUrl: string;
  /** The page describing a model, by the gateway's id for it. */
  modelPage(id: string): string;
  /** Reads its models API's response; `asOf` dates the prices. */
  parse(body: unknown, asOf: string): GatewayListing;
}

/** The catalog's levels among those a gateway accepts, which call reasoning turned off "none". */
export function reasoningLevels(efforts: readonly unknown[] | "any"): ThinkingLevel[] {
  return thinkingLevels.filter(
    (level) =>
      level !== "default" &&
      (efforts === "any" || efforts.includes(level === "off" ? "none" : level)),
  );
}

/** Gateways quote $ per token as a decimal string; negative means the price varies. */
function perMillion(value: unknown): number | undefined {
  const perToken = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Number((perToken * 1_000_000).toFixed(6));
}

/**
 * Rates from a gateway's input, output and cache prices. Gateways omit cache prices for providers
 * that do not charge separately for caching, and those fall back to the input price.
 */
export function listRates(
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  cacheWrite: unknown,
): Rates | undefined {
  const inputRate = perMillion(input);
  const outputRate = perMillion(output);
  if (inputRate === undefined || outputRate === undefined) return undefined;
  return [
    inputRate,
    outputRate,
    perMillion(cacheRead) ?? inputRate,
    perMillion(cacheWrite) ?? inputRate,
  ];
}

/** The smallest positive prompt size among `sizes`: where a gateway's long-context rates begin. */
export function longContextFrom(sizes: readonly unknown[]): number | undefined {
  const starts = sizes.filter(
    (size): size is number => typeof size === "number" && Number.isSafeInteger(size) && size > 0,
  );
  return starts.length ? Math.min(...starts) : undefined;
}

/** Every harness is an agent loop over text: a model must read and write text. */
export function readsAndWritesText(input: unknown, output: unknown): boolean {
  const text = (modalities: unknown) => Array.isArray(modalities) && modalities.includes("text");
  return text(input) && text(output);
}
