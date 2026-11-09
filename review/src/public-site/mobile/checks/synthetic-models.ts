import type { PublicSetting } from "../../contract";

/** Models for the synthetic settings, named as the model catalog names them. */
export type Model = PublicSetting["model"];

export const openai = (id: string, label: string): Model => ({
  catalogId: id,
  name: `openai/${id}`,
  label,
});

export const anthropic = (id: string, label: string): Model => ({
  catalogId: id,
  name: `anthropic/${id}`,
  label,
});

/** An OpenRouter model, named "vendor/model" as the catalog names them. */
export const routed = (name: string, label: string): Model => ({
  catalogId: name.split("/")[1] ?? name,
  name,
  label,
});
