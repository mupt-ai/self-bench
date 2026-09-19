import { Info } from "lucide-react";
import { Link } from "react-router";
import type { CredentialInfo } from "../../../src/evaluation/account";
import {
  executionBackendLabels,
  HOSTED_HARBOR_ENVIRONMENTS,
  type HostedExecutionBackend,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../../../src/providers";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { fieldStyles, Input, Select } from "./ui";

export interface GenerationOptions {
  models: string[];
  sandboxes: HostedExecutionBackend[];
  credentials: CredentialInfo[];
  available: boolean;
}

function Hint({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex cursor-help text-muted-foreground/70">
      <Info aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

export function GenerationFields({
  value,
  onChange,
  options,
  disabled,
}: {
  value: GenerationSettings;
  onChange: (value: GenerationSettings) => void;
  options: GenerationOptions | null;
  disabled: boolean;
}) {
  const hosted = value.sandbox === "e2b" || value.sandbox === "vercel";
  const sandboxFields: {
    field: "sandboxCredentialId" | "harborCredentialId";
    kind: HostedExecutionBackend | HostedHarborEnvironment;
    label: string;
  }[] = [
    {
      field: "sandboxCredentialId",
      kind: value.sandbox,
      label: `${executionBackendLabels[value.sandbox]} Credential`,
    },
  ];
  if (hosted && value.harborEnvironment)
    sandboxFields.push({
      field: "harborCredentialId",
      kind: value.harborEnvironment,
      label: `Harbor ${harborEnvironmentLabels[value.harborEnvironment]} Credential`,
    });
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-6 border-0 p-0 sm:grid-cols-2">
      {!options?.available && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          Generation credentials are not available. Configure credential storage before generating
          tasks.
        </p>
      )}
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
                {model}
              </option>
            ))}
          </Select>
        </label>
      ))}
      <label htmlFor="generation-reasoning" className={`${fieldStyles} content-start`}>
        Reasoning
        <Select
          id="generation-reasoning"
          aria-label="Reasoning"
          value={value.reasoning}
          onChange={(event) =>
            onChange({ ...value, reasoning: event.target.value as GenerationSettings["reasoning"] })
          }
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      </label>
      <label htmlFor="generation-sandbox" className={`${fieldStyles} content-start`}>
        Sandbox
        <Select
          id="generation-sandbox"
          aria-label="Sandbox"
          value={value.sandbox}
          onChange={(event) => {
            const sandbox = event.target.value as GenerationSettings["sandbox"];
            onChange({
              ...value,
              sandbox,
              sandboxCredentialId: undefined,
              sandboxImage: undefined,
              harborEnvironment: sandbox === "e2b" || sandbox === "vercel" ? sandbox : undefined,
              harborCredentialId: undefined,
            });
          }}
        >
          {options?.sandboxes.map((sandbox) => (
            <option key={sandbox} value={sandbox}>
              {executionBackendLabels[sandbox]}
            </option>
          ))}
        </Select>
      </label>
      <label htmlFor="generation-model-key" className={`${fieldStyles} content-start`}>
        OpenAI Credential
        <Select
          id="generation-model-key"
          aria-label="OpenAI Credential"
          value={value.modelCredentialId}
          onChange={(event) => onChange({ ...value, modelCredentialId: event.target.value })}
        >
          <option value="">Choose an API Key</option>
          {options?.credentials
            .filter(
              (item) => item.kind === "openai" && ["api-key", "codex-login"].includes(item.auth),
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </Select>
      </label>
      {hosted && (
        <>
          {value.sandbox === "vercel" && (
            <label className={`${fieldStyles} content-start`} htmlFor="generation-image">
              <span className="flex items-center gap-1.5">
                Vercel Runtime Image
                <Hint text="Use the digest-pinned image from self-bench setup vercel." />
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
          {value.sandbox === "e2b" && (
            <div className="flex items-center gap-1.5 self-start pt-1 text-sm font-medium text-foreground">
              E2B Template
              <Hint text="The E2B template is built automatically in your account on first use." />
            </div>
          )}
          <label className={`${fieldStyles} content-start`} htmlFor="generation-harbor">
            <span className="flex items-center gap-1.5">
              Harbor Verification
              <Hint
                text={`Generation runs in ${executionBackendLabels[value.sandbox]}; Harbor verification runs in your Modal, Vercel, E2B, or Daytona account.`}
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
        </>
      )}
      {sandboxFields.map(({ field, kind, label }) => (
        <label
          key={field}
          htmlFor={`generation-${field}`}
          className={`${fieldStyles} content-start`}
        >
          {label}
          <Select
            id={`generation-${field}`}
            aria-label={label}
            value={value[field] ?? ""}
            onChange={(event) => onChange({ ...value, [field]: event.target.value })}
          >
            <option value="">Choose a Credential</option>
            {value[field] &&
              !options?.credentials.some(
                (item) => item.id === value[field] && item.kind === kind,
              ) && <option value={value[field]}>Unavailable Credential</option>}
            {options?.credentials
              .filter((item) => item.kind === kind && item.auth === "api-key")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </Select>
        </label>
      ))}
      <div className="text-sm leading-6 text-muted-foreground sm:col-span-2">
        <span className="inline-flex items-center gap-1.5">
          <Link
            className="text-brand hover:text-brand"
            to="/settings/credentials"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage Credentials
          </Link>
          <Hint text="Each PR starts a separate workflow. Model and sandbox usage may incur charges." />
        </span>
      </div>
    </fieldset>
  );
}
