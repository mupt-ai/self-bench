import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input } from "../ui";
import { isSandbox } from "./credential-presentation";

/**
 * A credential's optional limit on sandboxes using it at once; blank means none, or `fallback` for
 * a new credential that has a default. A model credential's limit counts the sandboxes whose agent
 * calls it.
 */
function SandboxLimitField({
  sandbox,
  value,
  fallback,
  onChange,
}: {
  sandbox: boolean;
  value: number | undefined;
  /** What a new credential gets when this is left blank (a ChatGPT sign-in's default). */
  fallback: number | undefined;
  onChange(value: number | undefined): void;
}) {
  return (
    <label className={fieldStyles} htmlFor="credential-max-sandboxes">
      <span className="flex items-center gap-1.5">
        Max Concurrent Sandboxes
        <InfoTooltip
          label={`${
            sandbox
              ? "Generation and evaluations share this credential's sandbox limit. Use your plan's limit, such as 20 on E2B Hobby."
              : "Evaluation trials and generation sandboxes calling this credential share this limit. Lower it if the provider rate-limits you."
          } Leave blank for ${fallback ? `${fallback}, which you can change later` : "no limit"}. A new limit leaves started work running.`}
        />
      </span>
      <Input
        id="credential-max-sandboxes"
        aria-label="Max Concurrent Sandboxes"
        type="number"
        inputMode="numeric"
        min={1}
        max={1000}
        step={1}
        placeholder={fallback ? String(fallback) : "No Limit"}
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    </label>
  );
}

/** Model IDs as typed: separated by commas, spaces or new lines. */
function parseModelIds(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/**
 * A custom endpoint's saved model IDs, which the Run page offers with the credential, so a router
 * such as Shift-1 or Switchyard need not be typed each time.
 */
function ModelIdsField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label className={fieldStyles} htmlFor="credential-models">
      <span className="flex items-center gap-1.5">
        Model IDs
        <InfoTooltip label="Separate IDs with commas. The Run page lists each one with this credential." />
      </span>
      <Input
        id="credential-models"
        aria-label="Model IDs"
        autoComplete="off"
        placeholder="shift-1, switchyard"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** A new custom endpoint's address and saved model IDs. */
export function CustomEndpointFields({
  endpoint,
  models,
  onChange,
}: {
  endpoint: string;
  models: string;
  onChange(value: { endpoint: string; models: string[] }): void;
}) {
  // The typed text is kept as typed, so a trailing comma is not lost while the IDs are edited.
  const [text, setText] = React.useState(models);
  return (
    <>
      <label className={fieldStyles} htmlFor="credential-endpoint">
        <span className="flex items-center gap-1.5">
          Endpoint
          <InfoTooltip label="An OpenAI-compatible HTTPS endpoint on an approved host." />
        </span>
        <Input
          id="credential-endpoint"
          aria-label="Endpoint"
          type="url"
          required
          placeholder="https://approved-host.example/v1"
          value={endpoint}
          onChange={(event) =>
            onChange({ endpoint: event.target.value, models: parseModelIds(text) })
          }
        />
      </label>
      <ModelIdsField
        value={text}
        onChange={(next) => {
          setText(next);
          onChange({ endpoint, models: parseModelIds(next) });
        }}
      />
    </>
  );
}

/**
 * A sandbox account's optional limit on image builds at once; blank means none. E2B counts
 * template builds apart from sandboxes.
 */
type Limits = { maxSandboxes?: number | undefined; maxBuilds?: number | undefined };

/** A credential's limits: on sandboxes, and on an E2B account's template builds. */
export function CredentialLimitFields({
  kind,
  limits,
  fallback,
  onChange,
}: {
  kind: CredentialInfo["kind"];
  limits: Limits;
  /** A new credential's sandbox limit when the field is left blank; editing has none. */
  fallback?: number | undefined;
  onChange(limits: Limits): void;
}) {
  return (
    <>
      <SandboxLimitField
        sandbox={isSandbox(kind)}
        value={limits.maxSandboxes}
        fallback={fallback}
        onChange={(maxSandboxes) => onChange({ ...limits, maxSandboxes })}
      />
      {kind === "e2b" && (
        <BuildLimitField
          value={limits.maxBuilds}
          onChange={(maxBuilds) => onChange({ ...limits, maxBuilds })}
        />
      )}
    </>
  );
}

function BuildLimitField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange(value: number | undefined): void;
}) {
  return (
    <label className={fieldStyles} htmlFor="credential-max-builds">
      <span className="flex items-center gap-1.5">
        Max Concurrent Builds
        <InfoTooltip label="Evaluations build each task's template once before its trials, and E2B counts those builds apart from sandboxes. Use your plan's limit, such as 20 on E2B Hobby. Leave blank for no limit. A new limit leaves started work running." />
      </span>
      <Input
        id="credential-max-builds"
        aria-label="Max Concurrent Builds"
        type="number"
        inputMode="numeric"
        min={1}
        max={1000}
        step={1}
        placeholder="No Limit"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    </label>
  );
}

/** What the edit dialog saves: the name, and limits where null clears one (builds: E2B only). */
export interface CredentialSettings {
  name: string;
  maxSandboxes: number | null;
  maxBuilds?: number | null;
  /** A custom endpoint's model IDs; an empty list clears them. */
  models?: string[];
}

export function EditCredentialDialog({
  credential,
  onSave,
  onClose,
}: {
  credential: CredentialInfo;
  onSave(settings: CredentialSettings): Promise<void>;
  onClose(): void;
}) {
  const field = React.useRef<HTMLInputElement>(null);
  const [limits, setLimits] = React.useState<Limits>({
    maxSandboxes: credential.maxSandboxes,
    maxBuilds: credential.maxBuilds,
  });
  const [name, setName] = React.useState(credential.name);
  const [models, setModels] = React.useState((credential.models ?? []).join(", "));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <Dialog
      initialFocus={field}
      onDismiss={onClose}
      busy={busy}
      size="small"
      aria-labelledby="edit-credential-title"
      aria-describedby="edit-credential-description"
    >
      <DialogHeader
        title="Edit Credential"
        titleId="edit-credential-title"
        descriptionId="edit-credential-description"
        description={<span className="break-all">{credential.name}</span>}
        onClose={onClose}
        busy={busy}
      />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onSave({
              name: name.trim(),
              maxSandboxes: limits.maxSandboxes ?? null,
              ...(credential.kind === "e2b" ? { maxBuilds: limits.maxBuilds ?? null } : {}),
              ...(credential.kind === "custom" ? { models: parseModelIds(models) } : {}),
            });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save the credential");
          } finally {
            setBusy(false);
          }
        }}
      >
        <DialogBody>
          <fieldset disabled={busy} className="space-y-5">
            <label className={fieldStyles} htmlFor="edit-credential-name">
              Name
              <Input
                ref={field}
                id="edit-credential-name"
                required
                maxLength={80}
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {credential.kind === "custom" && <ModelIdsField value={models} onChange={setModels} />}
            <CredentialLimitFields kind={credential.kind} limits={limits} onChange={setLimits} />
          </fieldset>
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
