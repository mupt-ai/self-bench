import React from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { InfoTooltip } from "../primitives/tooltip";
import { rememberOrg } from "../session";
import { Button, fieldStyles, Input } from "../ui";
import { createWorkspace } from "./members";

/** Makes a shared workspace, then reloads into its Members page, since the session lists orgs. */
export function CreateWorkspaceDialog({ onCancel }: { onCancel(): void }) {
  const [login, setLogin] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const field = React.useRef<HTMLInputElement>(null);
  return (
    <Dialog
      initialFocus={field}
      onDismiss={onCancel}
      busy={busy}
      size="small"
      aria-labelledby="create-workspace-title"
    >
      <DialogHeader
        title="Create Workspace"
        titleId="create-workspace-title"
        onClose={onCancel}
        busy={busy}
      />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const created = await createWorkspace(login.trim(), name.trim());
            rememberOrg(created.login);
            window.location.assign("/settings/members");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not create the workspace");
            setBusy(false);
          }
        }}
      >
        <DialogBody>
          <label className={fieldStyles} htmlFor="workspace-login">
            <span className="flex items-center gap-1.5">
              Address
              <InfoTooltip label="Letters, numbers, and hyphens. It names the workspace on public releases and can't be a GitHub account's name or change later." />
            </span>
            <Input
              id="workspace-login"
              ref={field}
              aria-label="Address"
              value={login}
              maxLength={39}
              required
              pattern="[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*"
              placeholder="acme-evals"
              onChange={(event) => setLogin(event.target.value)}
            />
          </label>
          <label className={fieldStyles} htmlFor="workspace-name">
            Display Name
            <Input
              id="workspace-name"
              value={name}
              maxLength={80}
              placeholder="Acme Evals"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !login.trim()}>
            {busy ? "Creating…" : "Create Workspace"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
