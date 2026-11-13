import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { Harness } from "../../../../src/evaluation/models";
import { providerServesSubagent } from "../../../../src/evaluation/subagents";
import { credentialRunsAll } from "../evaluation/model-selection";
import { ModelPicker } from "../ModelPicker";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Select } from "../ui";
import { type HarnessDraft, subagentOn } from "./harness-draft";

/**
 * The workspace credentials that can serve a subagent model to `agent`, through SelfBench's
 * gateway: a credential whose provider serves subagents and routes the model to that agent.
 */
export function subagentCredentials(
  catalogId: string,
  agent: Harness,
  credentials: readonly CredentialInfo[],
  /** The catalog as the server serves it, with the gateways that list each model. */
  models: readonly CatalogModel[],
): CredentialInfo[] {
  const model = models.find((entry) => entry.id === catalogId);
  if (!model) return [];
  return credentials.filter(
    (credential) =>
      providerServesSubagent(credential.kind) && credentialRunsAll(model, credential, [agent]),
  );
}

/** Whether the draft's subagent credential no longer serves its model, or is gone. */
export function staleSubagentCredential(
  draft: Pick<HarnessDraft, "agent" | "subagent">,
  credentials: readonly CredentialInfo[] | undefined,
  models: readonly CatalogModel[],
): boolean {
  const { subagent, agent } = draft;
  if (!subagent?.credentialId || !credentials || !agent) return false;
  // Nothing is flagged for a model the catalog hasn't listed yet, or no longer lists.
  if (!models.some((model) => model.id === subagent.catalogId)) return false;
  return !subagentCredentials(subagent.catalogId, agent, credentials, models).some(
    (credential) => credential.id === subagent.credentialId,
  );
}

/**
 * A saved harness's subagent model and the credential that serves it. With a model, the agent's
 * delegated agents call it instead of the run's own, on that credential wherever the harness runs.
 */
export function SubagentFields({
  agent,
  models,
  credentials,
  value,
  disabled,
  onChange,
}: {
  agent: Harness;
  models: CatalogModel[];
  /** The workspace's credentials; undefined until they load. */
  credentials: readonly CredentialInfo[] | undefined;
  value: HarnessDraft["subagent"];
  disabled: boolean;
  onChange: (value: HarnessDraft["subagent"]) => void;
}) {
  // A model the catalog no longer lists still shows, by its id, until another is picked.
  const listed =
    value && !models.some((model) => model.id === value.catalogId)
      ? [{ id: value.catalogId, label: value.catalogId }, ...models]
      : models;
  const able =
    value && credentials ? subagentCredentials(value.catalogId, agent, credentials, models) : [];
  // A credential saved earlier that no longer serves the model, or was deleted.
  const stale = staleSubagentCredential({ agent, subagent: value }, credentials, models);
  return (
    <fieldset
      disabled={disabled}
      aria-label="Subagents"
      className="grid min-w-0 gap-4 border-0 p-0"
    >
      <div className={fieldStyles}>
        <span className="flex items-center gap-1.5">
          Subagent Model
          <InfoTooltip label="The model the agent's subagents run on, through SelfBench's gateway, at that model's default reasoning level. A trial's cost covers both models. A harness with one runs only on Claude Code and Codex, and skips a row whose own model it is." />
        </span>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <ModelPicker
              label="Subagent Model"
              placeholder="Same as the Run's Model"
              models={listed}
              value={value?.catalogId ?? ""}
              onSelect={(model) => {
                const first =
                  credentials && subagentCredentials(model.id, agent, credentials, models)[0]?.id;
                onChange(subagentOn(model.id, value?.prompt, first || undefined));
              }}
            />
          </div>
          {value && (
            <Button variant="ghost" onClick={() => onChange(undefined)}>
              Clear
            </Button>
          )}
        </div>
      </div>
      {value && (
        <label htmlFor="harness-subagent-credential" className={fieldStyles}>
          <span className="flex items-center gap-1.5">
            Subagent Credential
            <InfoTooltip label="The credential that serves the subagent model in every run of this harness. Only credentials that serve it to this agent are listed." />
          </span>
          <Select
            id="harness-subagent-credential"
            aria-label="Subagent Credential"
            value={stale ? "" : (value.credentialId ?? "")}
            onChange={(event) =>
              onChange(subagentOn(value.catalogId, value.prompt, event.target.value || undefined))
            }
          >
            <option value="">
              {able.length ? "First That Serves It" : "No Credential Serves It"}
            </option>
            {able.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </Select>
          {stale && (
            <span role="alert" className="text-sm text-warning">
              Its saved credential no longer serves this model. Choose another.
            </span>
          )}
        </label>
      )}
    </fieldset>
  );
}
