import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Input } from "../ui";

/** A sandbox credential's optional limit on sandboxes running at once; blank means none. */
export function SandboxLimitField({
  value,
  onChange,
  inputRef,
}: {
  value: number | undefined;
  onChange(value: number | undefined): void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className={fieldStyles} htmlFor="credential-max-sandboxes">
      Max Concurrent Sandboxes
      <Input
        ref={inputRef}
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
        Evaluations on this account run at most this many trials at once. Use your plan's limit,
        such as 20 on E2B Hobby. Leave blank for no limit.
      </span>
    </label>
  );
}

export function SandboxLimitDialog({
  credential,
  onSave,
  onClose,
}: {
  credential: CredentialInfo;
  onSave(maxSandboxes: number | null): Promise<void>;
  onClose(): void;
}) {
  const field = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState(credential.maxSandboxes);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <Dialog
      initialFocus={field}
      onDismiss={onClose}
      busy={busy}
      size="small"
      aria-labelledby="sandbox-limit-title"
      aria-describedby="sandbox-limit-description"
    >
      <DialogHeader
        title="Set Sandbox Limit"
        titleId="sandbox-limit-title"
        descriptionId="sandbox-limit-description"
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
            await onSave(value ?? null);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save the limit");
          } finally {
            setBusy(false);
          }
        }}
      >
        <DialogBody>
          <fieldset disabled={busy} className="space-y-5">
            <SandboxLimitField value={value} onChange={setValue} inputRef={field} />
          </fieldset>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Evaluations already running keep the limit they started with.
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
