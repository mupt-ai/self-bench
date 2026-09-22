import { managedE2BTemplateReference } from "../setup/e2b/managed.js";
import type { GenerationSettings } from "./settings.js";
import { generationExecutionBackend, generationHarborEnvironment } from "./settings.js";

const imageVariables = {
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
  const backend = generationExecutionBackend(settings.sandbox);
  return {
    ...base,
    SELFBENCH_EXECUTION_BACKEND: backend,
    SELFBENCH_HARBOR_ENVIRONMENT: generationHarborEnvironment(settings),
    ...(backend === "e2b"
      ? { SELFBENCH_E2B_TEMPLATE: image ?? managedE2BTemplateReference() }
      : image
        ? { [imageVariables[backend]]: image }
        : {}),
  };
}
