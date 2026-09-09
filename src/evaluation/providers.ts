import type { Harness } from "./types.js";

export const providerIds = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "huggingface",
  "mistral",
  "openrouter",
  "xai",
] as const;
export type EvaluationProvider = (typeof providerIds)[number];
export const providers: Record<
  EvaluationProvider,
  { label: string; credential: string; harnesses: Harness[] }
> = {
  openai: { label: "OpenAI", credential: "OPENAI_API_KEY", harnesses: ["codex", "pi"] },
  anthropic: {
    label: "Anthropic",
    credential: "ANTHROPIC_API_KEY",
    harnesses: ["claude-code", "pi"],
  },
  google: { label: "Google Gemini", credential: "GEMINI_API_KEY", harnesses: ["pi"] },
  groq: { label: "Groq", credential: "GROQ_API_KEY", harnesses: ["pi"] },
  huggingface: { label: "Hugging Face", credential: "HF_TOKEN", harnesses: ["pi"] },
  mistral: { label: "Mistral", credential: "MISTRAL_API_KEY", harnesses: ["pi"] },
  openrouter: { label: "OpenRouter", credential: "OPENROUTER_API_KEY", harnesses: ["pi"] },
  xai: { label: "xAI", credential: "XAI_API_KEY", harnesses: ["pi"] },
};
export const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
export function modelProvider(modelName: string): EvaluationProvider | undefined {
  const prefix = modelName.split("/", 1)[0];
  return providerIds.find((id) => id === prefix);
}
