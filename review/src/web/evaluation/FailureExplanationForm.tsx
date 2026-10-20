import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { ModelPicker } from "../ModelPicker";
import { Button, Input, Notice, Select } from "../ui";
import { evaluationRequest } from "./api";
import { credentialProvider, isSandbox } from "./credential-presentation";
import { credentialRunsAll, customModel } from "./model-selection";
import type { ExplanationSelection } from "./useFailureExplanation";

/** Saved keys only: an explanation uses Pi, independently of the trial's solver harness. */
function compatibleModels(credential: CredentialInfo, models: CatalogModel[]): CatalogModel[] {
  if (credential.auth !== "api-key" || isSandbox(credential.kind)) return [];
  if (credential.kind === "custom") return [customModel];
  return models.filter(
    (model) => model.id !== "custom" && credentialRunsAll(model, credential, ["pi"]),
  );
}

/** What the form asks for: Explain Failure by default, or Audit Task. */
interface FormLabels {
  action: string;
  busy: string;
  model: string;
}
const EXPLAIN: FormLabels = {
  action: "Explain Failure",
  busy: "Explaining…",
  model: "Explanation Model",
};

/**
 * A saved key and a model, then the button that spends them. Loading metadata and changing
 * selections never start a paid call.
 */
export function FailureExplanationForm({
  baseUrl,
  explaining,
  onExplain,
  labels = EXPLAIN,
}: {
  baseUrl: string;
  explaining: boolean;
  onExplain(selection: ExplanationSelection): Promise<void>;
  labels?: FormLabels;
}) {
  const id = useId();
  const [metadata, setMetadata] = useState<{
    credentials: CredentialInfo[];
    models: CatalogModel[];
  }>();
  const [error, setError] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [modelId, setModelId] = useState("");
  const [rawModel, setRawModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let disposed = false;
    const orgUrl = baseUrl.split(/\/(?:repos|benchmarks)\//)[0];
    Promise.all([
      evaluationRequest<{ credentials: CredentialInfo[] }>(`${orgUrl}/credentials`),
      evaluationRequest<{ models: CatalogModel[] }>(`${baseUrl}/catalog`),
    ]).then(
      ([keys, catalog]) => {
        if (!disposed) setMetadata({ credentials: keys.credentials, models: catalog.models });
      },
      (cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load explanation models.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [baseUrl]);

  const credentials =
    metadata?.credentials.filter((entry) => compatibleModels(entry, metadata.models).length > 0) ??
    [];
  const selectedKey = credentialId || (credentials.length === 1 ? credentials[0]?.id : "");
  const credential = credentials.find((entry) => entry.id === selectedKey);
  const models = credential && metadata ? compatibleModels(credential, metadata.models) : [];
  const model =
    credential?.kind === "custom"
      ? rawModel.trim()
      : models.find((entry) => entry.id === modelId)?.id;
  const busy = explaining || submitting;

  return (
    <section aria-label={labels.action} className="mb-5 min-w-0 space-y-2 [&_.panel]:min-w-0">
      {error ? (
        <Notice>{error}</Notice>
      ) : !metadata ? (
        <p role="status" className="text-sm text-muted-foreground">
          {explaining ? labels.busy : "Loading saved API keys and models…"}
        </p>
      ) : !credentials.length ? (
        <p className="text-sm text-muted-foreground">
          {explaining ? labels.busy : "No compatible saved model API keys are available."}{" "}
          {!explaining && (
            <Link className="underline" to="/settings/credentials">
              Manage Credentials
            </Link>
          )}
        </p>
      ) : (
        <fieldset disabled={busy} className="space-y-2">
          <div className="grid min-w-0 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="min-w-0 space-y-1">
              <label htmlFor={`${id}-key`} className="text-sm font-medium">
                Model API Key
              </label>
              <Select
                id={`${id}-key`}
                value={selectedKey ?? ""}
                onChange={(event) => {
                  setCredentialId(event.target.value);
                  setModelId("");
                  setRawModel("");
                }}
              >
                <option value="" disabled>
                  Select API Key
                </option>
                {credentials.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name === credentialProvider(entry)
                      ? entry.name
                      : `${entry.name} · ${credentialProvider(entry)}`}
                  </option>
                ))}
              </Select>
            </div>
            {credential && (
              <div className="min-w-0 space-y-1">
                <label htmlFor={`${id}-model`} className="text-sm font-medium">
                  {labels.model}
                </label>
                {credential.kind === "custom" ? (
                  <Input
                    id={`${id}-model`}
                    placeholder="Model ID"
                    maxLength={200}
                    value={rawModel}
                    onInput={(event) => setRawModel(event.currentTarget.value)}
                  />
                ) : (
                  <ModelPicker
                    id={`${id}-model`}
                    label={labels.model}
                    models={models}
                    value={modelId}
                    onSelect={(entry) => setModelId(entry.id)}
                  />
                )}
              </div>
            )}
            <Button
              className="sm:col-start-3"
              disabled={busy || !credential || !model}
              onClick={async () => {
                if (inFlight.current || busy || !credential || !model) return;
                inFlight.current = true;
                setSubmitting(true);
                try {
                  await onExplain({ credentialId: credential.id, model });
                } finally {
                  inFlight.current = false;
                  setSubmitting(false);
                }
              }}
            >
              {busy ? labels.busy : labels.action}
            </Button>
          </div>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {busy ? labels.busy : "Provider charges apply."}
          </p>
        </fieldset>
      )}
    </section>
  );
}
