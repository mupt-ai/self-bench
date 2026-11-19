import { dariModelId, dariRequestName } from "../../gateway/dari-link/connection.js";
import { type DariLinkGrants, dariLinkConnection } from "../../gateway/dari-link/link.js";
import { catalogEntry } from "../../gateways/catalog.js";
import { modelApiKeyVariable } from "../../gateways/index.js";
import type { PiModelsFiles } from "./settings.js";

/** Pi's provider for a generation stage's Dari connection: its models.json entry names the gateway. */
const DARI_LINK_PI_PROVIDER = "dari-link";

export interface GenerationDariLink {
  /** The child token the stage's Pi calls the gateway with. */
  readonly key: string;
  /** Pi's models.json: the gateway as this provider, serving the stage's model by its request name. */
  readonly piModels: PiModelsFiles;
}

/**
 * A generation stage's model on a Dari connection: a child token for that model alone, pinned to
 * the run's reasoning level (as Pi's trials are), and Pi's models.json naming the gateway the token
 * calls. Each activity mints its own, which lives twelve hours.
 */
export async function generationDariLink(
  grants: DariLinkGrants,
  stage: {
    orgId: number;
    credentialId: string;
    runId: string;
    role: "author" | "verifier";
    /** The stage's model as the run names it, `dari/model/<id>`. */
    model: string;
    reasoning: string;
  },
): Promise<GenerationDariLink> {
  const model = dariModelId(stage.model);
  const connection = await dariLinkConnection(grants, {
    orgId: stage.orgId,
    credentialId: stage.credentialId,
    model,
    thinking: stage.reasoning,
    tags: { run: stage.runId, stage: stage.role },
  });
  const known = catalogEntry(model);
  const models = JSON.stringify({
    providers: {
      [DARI_LINK_PI_PROVIDER]: {
        baseUrl: connection.openAiBase,
        // Pi reads the token from the variable its sandbox is given it under (piModelAuthSecrets).
        apiKey: `$${modelApiKeyVariable(DARI_LINK_PI_PROVIDER)}`,
        api: "openai-completions",
        models: [
          {
            id: dariRequestName(model),
            name: known?.name ?? model,
            input: known?.input_modalities.includes("image") ? ["text", "image"] : ["text"],
            ...(known?.context_window ? { contextWindow: known.context_window } : {}),
            ...(known?.max_output_tokens ? { maxTokens: known.max_output_tokens } : {}),
          },
        ],
      },
    },
  });
  return { key: connection.key, piModels: { models } };
}
