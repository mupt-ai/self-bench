import React from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Input, Select } from "../ui";
import { type ApiKeyScope, type CreatedApiKey, createApiKey, scopeLabels } from "./api-keys";

export function CreateApiKeyDialog({
  onCreated,
  onCancel,
}: {
  onCreated(created: CreatedApiKey): void;
  onCancel(): void;
}) {
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState<ApiKeyScope>("write");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const nameField = React.useRef<HTMLInputElement>(null);
  return (
    <Dialog
      initialFocus={nameField}
      onDismiss={onCancel}
      busy={busy}
      size="small"
      aria-labelledby="create-api-key-title"
      aria-describedby="create-api-key-description"
    >
      <DialogHeader
        title="Create API Key"
        titleId="create-api-key-title"
        descriptionId="create-api-key-description"
        description="The key acts as you in every organization you belong to."
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
            onCreated(await createApiKey({ name: name.trim(), scope }));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not create the key");
          } finally {
            setBusy(false);
          }
        }}
      >
        <DialogBody>
          <label className={fieldStyles} htmlFor="api-key-name">
            Name
            <Input
              id="api-key-name"
              ref={nameField}
              value={name}
              maxLength={80}
              required
              placeholder="CI, laptop, notebook…"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className={fieldStyles} htmlFor="api-key-scope">
            Scope
            <Select
              id="api-key-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as ApiKeyScope)}
            >
              <option value="write">{scopeLabels.write}</option>
              <option value="read">{scopeLabels.read}</option>
            </Select>
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            Read-only keys can list and download but never start, change, or delete anything.
          </p>
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
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create Key"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
