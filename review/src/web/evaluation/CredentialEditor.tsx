import React from "react";
import type { CredentialDraft, CredentialInfo } from "../../../../src/db/credentials";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Input, Select } from "../ui";
import { CredentialSecret } from "./CredentialSecret";
import { CredentialLimitFields } from "./CredentialSettings";
import { CustomEndpointFields } from "./CustomEndpointFields";
import { isSandbox, providers, sandboxes } from "./credential-presentation";
import { DariRouterField } from "./DariRouterField";

/** Provider and gateway keys, which a saved one is replaced with. */
const keyProviders = providers.filter((entry) => entry.id !== "custom" && entry.id !== "dari-link");

/**
 * Adds a sandbox account or a custom endpoint, or replaces one (or a saved provider or gateway API
 * key) with a new one. Plans and keys connect with Connect with Dari, never here.
 */
export function CredentialEditor({
  previous,
  kind = "modal",
  org,
  onSave,
  onCancel,
}: {
  previous?: CredentialInfo;
  kind?: CredentialDraft["kind"];
  org: string;
  onSave(value: CredentialDraft): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = React.useState<CredentialDraft>({
    name: previous ? `${previous.name} replacement`.slice(0, 80) : "",
    kind: previous?.kind ?? kind,
    auth: "api-key",
    value: "",
    endpoint: previous?.endpoint,
    maxSandboxes: previous?.maxSandboxes,
    maxBuilds: previous?.maxBuilds,
    resourceLimits: previous?.resourceLimits,
    ...(previous?.models ? { models: previous.models } : {}),
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const name = React.useRef<HTMLInputElement>(null);
  const endpoint = draft.kind === "custom";
  const sandbox = isSandbox(draft.kind);
  const choices = sandbox ? sandboxes : keyProviders;
  const keyLabel =
    draft.kind === "modal"
      ? "Modal Token Secret"
      : draft.kind === "vercel"
        ? "Vercel Token"
        : "API Key";
  return (
    <Dialog
      initialFocus={name}
      onDismiss={onCancel}
      busy={busy}
      aria-labelledby="credential-title"
      aria-describedby="credential-description"
    >
      <DialogHeader
        title={previous ? "Replace Credential" : endpoint ? "Add Endpoint" : "Add Sandbox"}
        titleId="credential-title"
        descriptionId="credential-description"
        description={<>Shared with {org}.</>}
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
            await onSave(draft);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save credential");
          } finally {
            setBusy(false);
          }
        }}
      >
        <DialogBody>
          {previous && (
            <p className="rounded-md border border-brand/40 bg-brand/10 p-3 text-sm">
              Creates a new credential. Existing runs keep the original.
            </p>
          )}
          <fieldset disabled={busy} className="space-y-5">
            {!endpoint && (
              <label className={fieldStyles} htmlFor="credential-provider">
                {sandbox ? "Sandbox" : "Provider"}
                <Select
                  id="credential-provider"
                  value={draft.kind}
                  onChange={(event) => {
                    setDraft({
                      name: draft.name,
                      kind: event.target.value as CredentialDraft["kind"],
                      auth: "api-key",
                      value: "",
                      maxSandboxes: draft.maxSandboxes,
                    });
                    setError("");
                  }}
                >
                  {choices.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className={fieldStyles} htmlFor="credential-name">
              Name
              <Input
                ref={name}
                id="credential-name"
                required
                maxLength={80}
                placeholder={endpoint ? "e.g. Fireworks" : "e.g. Team account"}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
          </fieldset>
          <fieldset className="space-y-5" disabled={busy}>
            {draft.kind === "dari" && (
              <DariRouterField
                value={draft.endpoint}
                onChange={(value) => setDraft({ ...draft, endpoint: value })}
              />
            )}
            {endpoint && (
              <CustomEndpointFields
                endpoint={draft.endpoint ?? ""}
                models={(draft.models ?? []).join(", ")}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    endpoint: value.endpoint,
                    ...(value.models.length ? { models: value.models } : { models: undefined }),
                  })
                }
              />
            )}
            {draft.kind === "modal" && (
              <label className={fieldStyles} htmlFor="credential-token-id">
                Modal Token ID
                <Input
                  id="credential-token-id"
                  required
                  autoComplete="off"
                  maxLength={4096}
                  value={draft.tokenId ?? ""}
                  onChange={(event) => setDraft({ ...draft, tokenId: event.target.value })}
                />
              </label>
            )}
            {draft.kind === "vercel" &&
              (["teamId", "projectId"] as const).map((key) => (
                <label key={key} className={fieldStyles} htmlFor={`credential-${key}`}>
                  {key === "teamId" ? "Vercel Team ID" : "Vercel Project ID"}
                  <Input
                    id={`credential-${key}`}
                    required
                    autoComplete="off"
                    maxLength={256}
                    value={draft[key] ?? ""}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </label>
              ))}
            <CredentialLimitFields
              kind={draft.kind}
              limits={draft}
              onChange={(limits) => setDraft({ ...draft, ...limits })}
            />
            <CredentialSecret
              draft={draft}
              setDraft={setDraft}
              keyLabel={keyLabel}
              key={draft.kind}
            />
          </fieldset>
          {error && (
            <p role="alert" className="text-sm leading-6 text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !draft.value || !draft.name.trim()}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
