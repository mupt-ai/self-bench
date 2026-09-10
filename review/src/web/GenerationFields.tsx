import { Link } from "react-router";
import type { CredentialInfo } from "../../../src/evaluation/account";
import {
  type ExecutionBackend,
  executionBackendLabels,
  type HarborEnvironment,
} from "../../../src/providers";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { Input, Select } from "./ui";

export interface GenerationOptions {
  models: string[];
  sandboxes: ExecutionBackend[];
  credentials: CredentialInfo[];
  available: boolean;
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
    kind: Exclude<ExecutionBackend, "docker">;
    label: string;
  }[] = [];
  if (value.sandbox !== "docker")
    sandboxFields.push({
      field: "sandboxCredentialId",
      kind: value.sandbox,
      label: `${executionBackendLabels[value.sandbox]} Credential`,
    });
  if (hosted && value.harborEnvironment === "modal")
    sandboxFields.push({
      field: "harborCredentialId",
      kind: "modal",
      label: "Harbor Modal Credential",
    });
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-6 border-0 p-0 sm:grid-cols-2">
      {!options?.available && (
        <p role="alert" className="text-sm text-danger sm:col-span-2">
          Generation credentials are not available. Configure credential storage before generating
          tasks.
        </p>
      )}
      {(["authorModel", "verifierModel"] as const).map((field) => (
        <label
          key={field}
          htmlFor={`generation-${field}`}
          className="grid gap-2 font-mono text-[13px] text-muted"
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
      <label htmlFor="generation-reasoning" className="grid gap-2 font-mono text-[13px] text-muted">
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
      <label htmlFor="generation-sandbox" className="grid gap-2 font-mono text-[13px] text-muted">
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
              harborEnvironment: sandbox === "e2b" || sandbox === "vercel" ? "docker" : undefined,
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
      <label htmlFor="generation-model-key" className="grid gap-2 font-mono text-[13px] text-muted">
        OpenAI Credential
        <Select
          id="generation-model-key"
          aria-label="OpenAI Credential"
          value={value.modelCredentialId}
          onChange={(event) => onChange({ ...value, modelCredentialId: event.target.value })}
        >
          <option value="">Choose an API Key</option>
          {options?.credentials
            .filter((item) => item.kind === "openai" && item.auth === "api-key")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </Select>
      </label>
      {hosted && (
        <>
          <label className="grid gap-2 font-mono text-[13px] text-muted" htmlFor="generation-image">
            {value.sandbox === "e2b" ? "E2B Template" : "Vercel Runtime Image"}
            <Input
              id="generation-image"
              required
              value={value.sandboxImage ?? ""}
              onChange={(event) => onChange({ ...value, sandboxImage: event.target.value })}
              placeholder={
                value.sandbox === "e2b" ? "Template Name or ID" : "registry/image@sha256:…"
              }
            />
            <span className="text-xs leading-5">
              {value.sandbox === "e2b"
                ? "Use a SelfBench template built with self-bench setup e2b, not the base template."
                : "Use the digest-pinned image from self-bench setup vercel."}
            </span>
          </label>
          <label
            className="grid gap-2 font-mono text-[13px] text-muted"
            htmlFor="generation-harbor"
          >
            Harbor Verification
            <Select
              id="generation-harbor"
              aria-label="Harbor Verification"
              value={value.harborEnvironment ?? ""}
              onChange={(event) =>
                onChange({
                  ...value,
                  harborEnvironment: event.target.value as HarborEnvironment,
                  harborCredentialId: undefined,
                })
              }
            >
              <option value="">Choose an Environment</option>
              <option value="docker">Docker</option>
              <option value="modal">Modal</option>
            </Select>
            <span className="text-xs leading-5">
              Generation runs in {executionBackendLabels[value.sandbox]}; verification uses Docker
              on the worker or your Modal account.
            </span>
          </label>
        </>
      )}
      {sandboxFields.map(({ field, kind, label }) => (
        <label
          key={field}
          htmlFor={`generation-${field}`}
          className="grid gap-2 font-mono text-[13px] text-muted"
        >
          {label}
          <Select
            id={`generation-${field}`}
            aria-label={label}
            value={value[field] ?? ""}
            onChange={(event) => onChange({ ...value, [field]: event.target.value })}
          >
            <option value="">Choose a Credential</option>
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
      <div className="font-mono text-[13px] leading-6 text-muted sm:col-span-2">
        <Link
          className="text-mint hover:text-mint-bright"
          to="/settings/credentials"
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage Credentials
        </Link>
        <p className="mt-3">
          Each PR starts a separate workflow. Model and sandbox usage may incur charges.
        </p>
      </div>
    </fieldset>
  );
}
