import type { EvaluationPricing, Harness } from "./types.js";

export const catalogVersion = "2026-09-14.1";
const supportedProviders = ["openai", "anthropic", "openrouter", "custom"] as const;
export type CatalogProvider = (typeof supportedProviders)[number];
export interface CatalogModel {
  id: string;
  provider: CatalogProvider;
  model: string;
  label: string;
  harnesses: Harness[];
  source: string;
  pricing?: EvaluationPricing;
}
export const catalog: CatalogModel[] = [
  {
    id: "openai-astra6",
    provider: "openai",
    model: "gpt-6-astra",
    label: "GPT-6 Astra",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
  },
  {
    id: "openai-sol56",
    provider: "openai",
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  {
    id: "openai-terra56",
    provider: "openai",
    model: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  {
    id: "openai-luna56",
    provider: "openai",
    model: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  },
  {
    id: "anthropic-fable51",
    provider: "anthropic",
    model: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    harnesses: ["claude-code", "pi"],
    source: "https://platform.claude.com/docs/en/models/overview",
  },
  {
    id: "anthropic-opus5",
    provider: "anthropic",
    model: "claude-opus-5",
    label: "Claude Opus 5",
    harnesses: ["claude-code", "pi"],
    source: "https://platform.claude.com/docs/en/models/overview",
  },
  {
    id: "anthropic-sonnet5",
    provider: "anthropic",
    model: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    harnesses: ["claude-code", "pi"],
    source: "https://platform.claude.com/docs/en/models/overview",
  },
  {
    id: "router-gemini38",
    provider: "openrouter",
    model: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    harnesses: ["pi"],
    source: "https://openrouter.ai/google/gemini-3.8-flash",
  },
  {
    id: "router-glm53",
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    label: "GLM-5.3",
    harnesses: ["pi"],
    source: "https://openrouter.ai/z-ai/glm-5.3",
  },
  {
    id: "router-kimi3",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    label: "Kimi K3",
    harnesses: ["pi"],
    source: "https://openrouter.ai/moonshotai/kimi-k3",
  },
  {
    id: "router-deepseek4",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    harnesses: ["pi"],
    source: "https://openrouter.ai/deepseek/deepseek-v4-pro",
  },
  {
    id: "router-glm53flash",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    harnesses: ["pi"],
    source: "https://openrouter.ai/z-ai/glm-5.3-flash",
  },
  {
    id: "router-deepseek41flash",
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    harnesses: ["pi"],
    source: "https://openrouter.ai/deepseek/deepseek-v4.1-flash",
  },
  {
    id: "router-deepseek4flash0731",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    harnesses: ["pi"],
    source: "https://openrouter.ai/deepseek/deepseek-v4-flash-0731",
  },
  {
    id: "router-minimax3",
    provider: "openrouter",
    model: "minimax/minimax-m3",
    label: "MiniMax M3",
    harnesses: ["pi"],
    source: "https://openrouter.ai/minimax/minimax-m3",
  },
];
export const hostedSandboxes = ["e2b", "modal", "daytona"] as const;
export type HostedSandbox = (typeof hostedSandboxes)[number];
