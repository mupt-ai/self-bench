import type { GatewayConnection } from "../gateway/connection.js";
import type { SolverTrial } from "./gateway-trial.js";
import { thinkingArguments } from "./models.js";
import type { EvaluationInput } from "./types.js";

/**
 * Muse Code on a Dari connection (a Muse plan, or a Meta key's models), which alone serves it: Muse
 * reads its model list from Dari's origin, and sends its key, the trial's token, only to a base URL
 * its settings name and pin to bearer auth (SelfBenchMuseCode's `bearer_base_url`). Harbor reads
 * `meta/` as Muse's own provider and passes the rest, Dari's request name, as Muse's model.
 * `child` is the trial's environment without any other model key; `requestModel` is Dari's
 * request name for the model (`dari/model/meta/muse-spark-1.3`).
 */
export function linkedMuseTrial(
  input: Pick<EvaluationInput, "thinking">,
  connection: GatewayConnection,
  child: NodeJS.ProcessEnv,
  requestModel: string,
): SolverTrial {
  const base = connection.openAiBase;
  return {
    model: `meta/${requestModel}`,
    agent: "harbor_muse:SelfBenchMuseCode",
    agentArguments: [
      ...thinkingArguments("muse-code", input.thinking),
      "--agent-kwarg",
      `base_url=${base}`,
      "--agent-kwarg",
      `bearer_base_url=${base}`,
    ],
    child: { ...child, META_API_KEY: connection.key },
    extraAllowedHosts: [connection.host],
  };
}
