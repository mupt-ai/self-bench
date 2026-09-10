import { matchingHarborEnvironment } from "../providers.js";
import type { GenerationSettings } from "./generation-settings.js";

const imageVariables = {
  docker: "SELFBENCH_DOCKER_IMAGE",
  modal: "SELFBENCH_MODAL_IMAGE",
  vercel: "SELFBENCH_VERCEL_IMAGE",
  e2b: "SELFBENCH_E2B_TEMPLATE",
} as const;

/** Generation agents and Harbor verification have independent provider contracts. */
export function generationConfigEnvironment(
  settings: GenerationSettings,
  base: NodeJS.ProcessEnv,
  image = settings.sandboxImage,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SELFBENCH_EXECUTION_BACKEND: settings.sandbox,
    SELFBENCH_HARBOR_ENVIRONMENT:
      matchingHarborEnvironment(settings.sandbox) ?? settings.harborEnvironment,
    ...(image ? { [imageVariables[settings.sandbox]]: image } : {}),
  };
}
