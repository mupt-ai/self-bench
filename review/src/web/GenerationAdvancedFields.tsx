import { Link } from "react-router";
import {
  executionBackendLabels,
  HOSTED_HARBOR_ENVIRONMENTS,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../../../src/config/providers";
import type { CredentialInfo } from "../../../src/evaluation/account";
import { generationModelLabel } from "../../../src/generation/models";
import {
  type GenerationSandbox,
  type GenerationSettings,
  generationExecutionBackend,
  generationSandboxLabels,
} from "../../../src/generation/settings";
import type { GenerationOptions } from "./GenerationFields";
import { modelCredentialMatches } from "./generation-defaults";
import { InfoTooltip } from "./primitives/tooltip";
import { fieldStyles, Input, Select } from "./ui";

const pairRow = "grid min-w-0 gap-6 sm:grid-cols-2";

/** The advanced panel: every model, sandbox, and credential selection for a generation run. */
export function AdvancedFields({
  value,
  onChange,
  options,
  managed,
}: {
  value: GenerationSettings;
  onChange: (value: GenerationSettings) => void;
  options: GenerationOptions | null;
  /** Managed models and managed sandboxes are gated by independent platform keys. */
  managed: { models: boolean; sandbox: boolean };
}) {
  const hosted = value.sandbox !== "managed";
  const compatible = (credential: CredentialInfo) =>
    modelCredentialMatches(credential, value.authorModel, value.verifierModel);
  return (
    <div className="grid min-w-0 gap-6">
      {!options?.available && (
        <p role="alert" className="text-sm text-destructive">
          Generation credentials are not available. Configure credential storage before generating
          tasks.
        </p>
      )}
      <div className={pairRow}>
        {(["authorModel", "verifierModel"] as const).map((field) => (
          <label
            key={field}
            htmlFor={`generation-${field}`}
            className={`${fieldStyles} content-start`}
          >
            {field === "authorModel" ? "Author Model" : "Verifier Model"}
            <Select
              id={`generation-${field}`}
              aria-label={field === "authorModel" ? "Author Model" : "Verifier Model"}
              value={value[field]}
              onChange={(event) => onChange({ ...value, [field]: event.target.value })}
            >
              {options?.models.map((model) => (
                <option key={model} value={model}>
                  {generationModelLabel(model)}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>
      <div className={pairRow}>
        <label htmlFor="generation-reasoning" className={`${fieldStyles} content-start`}>
          Reasoning
          <Select
            id="generation-reasoning"
            aria-label="Reasoning"
            value={value.reasoning}
            onChange={(event) =>
              onChange({
                ...value,
                reasoning: event.target.value as GenerationSettings["reasoning"],
              })
            }
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </Select>
        </label>
      </div>
      <div className={pairRow}>
        <label htmlFor="generation-model-access" className={`${fieldStyles} content-start`}>
          <span className="flex items-center gap-1.5">
            Model Access
            <InfoTooltip label="Managed runs on SelfBench's account — no credential needed, and usage is tracked per run. With My Credentials, the models run on a credential you store." />
          </span>
          <Select
            id="generation-model-access"
            aria-label="Model Access"
            value={value.modelAccess}
            onChange={(event) =>
              onChange({
                ...value,
                modelAccess: event.target.value as GenerationSettings["modelAccess"],
                modelCredentialId: undefined,
              })
            }
          >
            {managed.models && <option value="managed">Managed</option>}
            <option value="credential">My Credentials</option>
          </Select>
        </label>
        {value.modelAccess === "credential" && (
          <label htmlFor="generation-model-key" className={`${fieldStyles} content-start`}>
            Model Credential
            <Select
              id="generation-model-key"
              aria-label="Model Credential"
              value={value.modelCredentialId ?? ""}
              onChange={(event) =>
                onChange({ ...value, modelCredentialId: event.target.value || undefined })
              }
            >
              <option value="">Choose a Credential</option>
              {value.modelCredentialId && !options?.credentials.some(compatible) && (
                <option value={value.modelCredentialId}>Unavailable Credential</option>
              )}
              {options?.credentials.filter(compatible).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      <div className={pairRow}>
        <label htmlFor="generation-sandbox" className={`${fieldStyles} content-start`}>
          <span className="flex items-center gap-1.5">
            Sandbox
            <InfoTooltip label="Managed sandboxes run on SelfBench's account — nothing to configure, usage tracked per run. The other options run on a credential you store." />
          </span>
          <Select
            id="generation-sandbox"
            aria-label="Sandbox"
            value={value.sandbox}
            onChange={(event) => {
              const sandbox = event.target.value as GenerationSandbox;
              onChange({
                ...value,
                sandbox,
                sandboxCredentialId: undefined,
                sandboxImage: undefined,
                harborEnvironment: sandbox === "managed" ? undefined : sandbox,
                harborCredentialId: undefined,
              });
            }}
          >
            {managed.sandbox && <option value="managed">{generationSandboxLabels.managed}</option>}
            {options?.sandboxes
              .filter((sandbox) => sandbox !== "managed")
              .map((sandbox) => (
                <option key={sandbox} value={sandbox}>
                  {executionBackendLabels[sandbox as keyof typeof executionBackendLabels]}
                </option>
              ))}
          </Select>
        </label>
        {value.sandbox !== "managed" && (
          <label htmlFor="generation-sandbox-key" className={`${fieldStyles} content-start`}>
            {generationSandboxLabels[value.sandbox]} Credential
            <Select
              id="generation-sandbox-key"
              aria-label={`${generationSandboxLabels[value.sandbox]} Credential`}
              value={value.sandboxCredentialId ?? ""}
              onChange={(event) =>
                onChange({ ...value, sandboxCredentialId: event.target.value || undefined })
              }
            >
              <option value="">Choose a Credential</option>
              {value.sandboxCredentialId &&
                !options?.credentials.some(
                  (item) =>
                    item.id === value.sandboxCredentialId &&
                    item.kind === generationExecutionBackend(value.sandbox),
                ) && <option value={value.sandboxCredentialId}>Unavailable Credential</option>}
              {options?.credentials
                .filter(
                  (item) =>
                    item.kind === generationExecutionBackend(value.sandbox) &&
                    item.auth === "api-key",
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </Select>
          </label>
        )}
      </div>
      {value.sandbox === "vercel" && (
        <label className={`${fieldStyles} content-start`} htmlFor="generation-image">
          <span className="flex items-center gap-1.5">
            Vercel Runtime Image
            <InfoTooltip label="Use the digest-pinned image published from Dockerfile.sandbox." />
          </span>
          <Input
            id="generation-image"
            required
            value={value.sandboxImage ?? ""}
            onChange={(event) => onChange({ ...value, sandboxImage: event.target.value })}
            placeholder="registry/image@sha256:…"
          />
        </label>
      )}
      {hosted && (
        <div className={pairRow}>
          <label htmlFor="generation-harbor" className={`${fieldStyles} content-start`}>
            <span className="flex items-center gap-1.5">
              Harbor Verification
              <InfoTooltip
                label={`Generation runs in ${generationSandboxLabels[value.sandbox]}; Harbor verification runs in your ${HOSTED_HARBOR_ENVIRONMENTS.map((environment) => harborEnvironmentLabels[environment]).join(", ")} account.`}
              />
            </span>
            <Select
              id="generation-harbor"
              aria-label="Harbor Verification"
              value={value.harborEnvironment ?? ""}
              onChange={(event) =>
                onChange({
                  ...value,
                  harborEnvironment: event.target.value as HostedHarborEnvironment,
                  harborCredentialId: undefined,
                })
              }
            >
              <option value="">Choose an Environment</option>
              {HOSTED_HARBOR_ENVIRONMENTS.map((environment) => (
                <option key={environment} value={environment}>
                  {harborEnvironmentLabels[environment]}
                </option>
              ))}
            </Select>
          </label>
          {value.harborEnvironment && (
            <label htmlFor="generation-harbor-key" className={`${fieldStyles} content-start`}>
              Harbor {harborEnvironmentLabels[value.harborEnvironment]} Credential
              <Select
                id="generation-harbor-key"
                aria-label={`Harbor ${harborEnvironmentLabels[value.harborEnvironment]} Credential`}
                value={value.harborCredentialId ?? ""}
                onChange={(event) =>
                  onChange({ ...value, harborCredentialId: event.target.value || undefined })
                }
              >
                <option value="">Choose a Credential</option>
                {value.harborCredentialId &&
                  !options?.credentials.some(
                    (item) =>
                      item.id === value.harborCredentialId && item.kind === value.harborEnvironment,
                  ) && <option value={value.harborCredentialId}>Unavailable Credential</option>}
                {options?.credentials
                  .filter(
                    (item) => item.kind === value.harborEnvironment && item.auth === "api-key",
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </Select>
            </label>
          )}
        </div>
      )}
      <div className="text-sm leading-6 text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Link
            className="font-medium text-foreground underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground"
            to="/settings/credentials"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage Credentials
          </Link>
          <InfoTooltip label="Each PR starts a separate workflow. Managed model and sandbox usage is tracked per run; stored credentials may incur charges on your own accounts." />
        </span>
      </div>
    </div>
  );
}
