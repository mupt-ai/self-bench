import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Input } from "../ui";
import { isSandbox } from "./credential-presentation";

/**
 * A credential's optional limit on sandboxes using it at once; blank means none. A model
 * credential's limit counts the sandboxes whose agent calls it.
 */
function SandboxLimitField({
  sandbox,
  value,
  onChange,
}: {
  sandbox: boolean;
  value: number | undefined;
  onChange(value: number | undefined): void;
}) {
  return (
    <label className={fieldStyles} htmlFor="credential-max-sandboxes">
      Max Concurrent Sandboxes
      <Input
        id="credential-max-sandboxes"
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
      <span className="text-xs font-normal leading-5 text-muted-foreground">
        {sandbox
          ? "Generation and evaluations share this credential's sandbox limit. Use your plan's limit, such as 20 on E2B Hobby."
          : "Evaluation trials and generation sandboxes calling this credential share this limit. Lower it if the provider rate-limits you."}{" "}
        Leave blank for no limit.
      </span>
    </label>
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
  onChange,
}: {
  kind: CredentialInfo["kind"];
  limits: Limits;
  onChange(limits: Limits): void;
}) {
  return (
    <>
      <SandboxLimitField
        sandbox={isSandbox(kind)}
        value={limits.maxSandboxes}
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
      Max Concurrent Builds
      <Input
        id="credential-max-builds"
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
      <span className="text-xs font-normal leading-5 text-muted-foreground">
        Evaluations build each task's template once before its trials, and E2B counts those builds
        apart from sandboxes. Use your plan's limit, such as 20 on E2B Hobby. Leave blank for no
        limit.
      </span>
    </label>
  );
}

/** What the edit dialog saves: the name, and limits where null clears one (builds: E2B only). */
export interface CredentialSettings {
  name: string;
  maxSandboxes: number | null;
  maxBuilds?: number | null;
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
            <CredentialLimitFields kind={credential.kind} limits={limits} onChange={setLimits} />
          </fieldset>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            A new limit leaves started work running. New work waits for a free slot.
          </p>
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
