import { Link } from "react-router";
import type { CredentialInfo } from "../../../src/evaluation/account";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { Select } from "./ui";

export interface GenerationOptions {
  models: string[];
  sandboxes: string[];
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
          onChange={(event) =>
            onChange({ ...value, sandbox: event.target.value as GenerationSettings["sandbox"] })
          }
        >
          <option value="modal">Modal</option>
          <option value="docker">Docker</option>
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
      {value.sandbox === "modal" && (
        <label
          htmlFor="generation-sandbox-key"
          className="grid gap-2 font-mono text-[13px] text-muted"
        >
          Modal Credential
          <Select
            id="generation-sandbox-key"
            aria-label="Modal Credential"
            value={value.sandboxCredentialId ?? ""}
            onChange={(event) => onChange({ ...value, sandboxCredentialId: event.target.value })}
          >
            <option value="">Choose a Credential</option>
            {options?.credentials
              .filter((item) => item.kind === "modal")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </Select>
        </label>
      )}
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
