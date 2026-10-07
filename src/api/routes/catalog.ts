import {
  catalogVersion,
  evaluationCatalog,
  hostedSandboxes,
  withReferencePricing,
} from "../../evaluation/catalog.js";
import { managedHarborEnvironment, managedOffer } from "../../generation/billing/managed.js";

/** The models and sandboxes evaluations can use; the same for every repository. */
export function catalogOf(env: NodeJS.ProcessEnv) {
  return {
    version: catalogVersion,
    models: evaluationCatalog().map(withReferencePricing),
    sandboxes: hostedSandboxes,
    customHosts: (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean),
    managed: {
      ...managedOffer(env),
      sandbox: managedHarborEnvironment(env) === "modal",
    },
  };
}
