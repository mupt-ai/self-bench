import type { SubagentThinking } from "../../../../src/contracts/conditions";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { defaultThinking, type Harness } from "../../../../src/evaluation/models";
import { subagentCredentials, subagentThinkingLevels } from "../../../../src/evaluation/subagents";
import { ModelPicker } from "../ModelPicker";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Select } from "../ui";
import { type HarnessDraft, subagentOn } from "./harness-draft";

/** The credentials that can serve a subagent model to `agent`, on the served catalog. */
function servingCredentials(
  catalogId: string,
  agent: Harness,
  credentials: readonly CredentialInfo[],
  models: readonly CatalogModel[],
): CredentialInfo[] {
  const model = models.find((entry) => entry.id === catalogId);
  return model ? subagentCredentials(model, [agent], credentials) : [];
}

/**
 * The level a subagent model starts on among those its credential offers: the one a row of the
 * model runs at when none is chosen, which is the one a harness saved without a level runs at.
 */
const startingLevel = (levels: readonly SubagentThinking[]) =>
  levels.find((level) => level === defaultThinking(levels));

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
  return !servingCredentials(subagent.catalogId, agent, credentials, models).some(
    (credential) => credential.id === subagent.credentialId,
  );
}

/**
 * A saved harness's subagent model, the credential that serves it, and the thinking level its
 * calls are served at. With a model, the agent's delegated agents call it instead of the run's
 * own, on that credential and at that level wherever the harness runs.
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
    value && credentials ? servingCredentials(value.catalogId, agent, credentials, models) : [];
  // A credential saved earlier that no longer serves the model, or was deleted.
  const stale = staleSubagentCredential({ agent, subagent: value }, credentials, models);
  // The levels a model has on the credential that serves it: the one named, else the first.
  const levelsOn = (catalogId: string | undefined, credentialId: string | undefined) => {
    const model = models.find((entry) => entry.id === catalogId);
    if (!model || !credentials) return [];
    const serving = subagentCredentials(model, [agent], credentials);
    const picked = serving.find((credential) => credential.id === credentialId) ?? serving[0];
    return picked ? subagentThinkingLevels(model, picked.kind) : [];
  };
  const levels = levelsOn(value?.catalogId, value?.credentialId);
  // A level saved earlier that the model no longer has there still shows, until another is picked.
  const unoffered = !!value?.thinking && !!able.length && !levels.includes(value.thinking);
  return (
    <fieldset
      disabled={disabled}
      aria-label="Subagents"
      className="grid min-w-0 gap-4 border-0 p-0"
    >
      <div className={fieldStyles}>
        <span className="flex items-center gap-1.5">
          Subagent Model
          <InfoTooltip label="The model the agent's subagents run on, through SelfBench's gateway. A trial's cost covers both models. A harness with one runs only on Claude Code and Codex, and skips a row whose own model it is." />
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
                  credentials && servingCredentials(model.id, agent, credentials, models)[0]?.id;
                // A newly picked model starts on its default level there, as a level of its own.
                const level = startingLevel(levelsOn(model.id, first || undefined));
                onChange(subagentOn(model.id, value?.prompt, first || undefined, level));
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
            onChange={(event) => {
              const credentialId = event.target.value || undefined;
              // A picked level is kept where the newly picked credential has it too, and is the
              // model's default there otherwise.
              const offered = levelsOn(value.catalogId, credentialId);
              const level =
                value.thinking &&
                (offered.find((entry) => entry === value.thinking) ?? startingLevel(offered));
              onChange(subagentOn(value.catalogId, value.prompt, credentialId, level));
            }}
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
            <span role="alert" className="text-[13px] font-normal text-warning">
              Its saved credential no longer serves this model. Choose another.
            </span>
          )}
        </label>
      )}
      {value && (levels.length > 0 || value.thinking) && (
        <label htmlFor="harness-subagent-thinking" className={fieldStyles}>
          <span className="flex items-center gap-1.5">
            Subagent Thinking Level
            <InfoTooltip label="The thinking level every subagent call is served at, whatever level the agent asks its subagents for. Only levels the model has on its credential are listed." />
          </span>
          <Select
            id="harness-subagent-thinking"
            aria-label="Subagent Thinking Level"
            // One saved without a level shows the level it runs at: the model's default.
            value={value.thinking ?? startingLevel(levels) ?? ""}
            onChange={(event) => {
              const level = levels.find((entry) => entry === event.target.value);
              onChange(subagentOn(value.catalogId, value.prompt, value.credentialId, level));
            }}
          >
            {value.thinking && !levels.includes(value.thinking) && (
              <option value={value.thinking} disabled>
                {value.thinking}
              </option>
            )}
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
          {unoffered && (
            <span role="alert" className="text-[13px] font-normal text-warning">
              The model no longer has this level on its credential. Choose another.
            </span>
          )}
        </label>
      )}
    </fieldset>
  );
}
