import React from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Input, Select } from "../ui";
import { CodexSignIn } from "./CodexSignIn";
import { CredentialSecret } from "./CredentialSecret";
import { isSandbox, providers, sandboxes } from "./credential-presentation";

export function CredentialEditor({
  previous,
  kind = "openai",
  auth = "api-key",
  org,
  onSave,
  onSaved,
  onCancel,
}: {
  previous?: CredentialInfo;
  kind?: CredentialDraft["kind"];
  auth?: CredentialDraft["auth"];
  org: string;
  onSave(value: CredentialDraft): Promise<void>;
  onSaved(): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = React.useState<CredentialDraft>({
    name: previous
      ? `${previous.name} replacement`.slice(0, 80)
      : auth === "codex-login"
        ? "Codex"
        : "",
    kind: previous?.kind ?? kind,
    auth: previous?.auth ?? auth,
    value: "",
    endpoint: previous?.endpoint,
  });
  const [busy, setBusy] = React.useState(false);
  const [signingIn, setSigningIn] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState("");
  const name = React.useRef<HTMLInputElement>(null);
  const isLogin = draft.auth === "codex-login" && !importing;
  const sandbox = isSandbox(previous?.kind ?? kind);
  const choices = sandbox ? sandboxes : providers;
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
        title={previous ? "Replace Credential" : sandbox ? "Add Sandbox" : "Add Provider"}
        titleId="credential-title"
        descriptionId="credential-description"
        description={<>Shared with {org}.</>}
        onClose={onCancel}
        busy={busy}
      />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || isLogin) return;
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
            <p className="border-l-2 border-input pl-3 text-xs leading-5 text-muted-foreground">
              Creates a new credential. Existing runs keep the original.
            </p>
          )}
          <fieldset disabled={busy || signingIn} className="space-y-5">
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
                  });
                  setImporting(false);
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
            {draft.kind === "openai" && (
              <fieldset>
                <legend className="sr-only">Authentication</legend>
                <div className="grid grid-cols-2 border border-input p-1">
                  {[
                    { id: "api-key", label: "API Key" },
                    { id: "codex-login", label: "ChatGPT Sign-In" },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={draft.auth === option.id}
                      className={`px-2 py-2 text-sm transition-colors ${draft.auth === option.id ? "bg-accent font-medium text-brand" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          auth: option.id as CredentialDraft["auth"],
                          value: "",
                        });
                        setImporting(false);
                        setError("");
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            <label className={fieldStyles} htmlFor="credential-name">
              Name
              <Input
                ref={name}
                id="credential-name"
                required
                maxLength={80}
                placeholder={draft.auth === "codex-login" ? "e.g. Team Codex" : "e.g. Team account"}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
          </fieldset>
          {isLogin ? (
            <CodexSignIn
              org={org}
              name={draft.name}
              onActiveChange={setSigningIn}
              onSavingChange={setBusy}
              onDone={onSaved}
            />
          ) : (
            <fieldset className="space-y-5" disabled={busy}>
              {draft.kind === "custom" && (
                <label className={fieldStyles} htmlFor="credential-endpoint">
                  Endpoint
                  <Input
                    id="credential-endpoint"
                    type="url"
                    required
                    placeholder="https://approved-host.example/v1"
                    value={draft.endpoint ?? ""}
                    onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                  />
                  <span className="text-xs font-normal leading-5 text-muted-foreground">
                    An OpenAI-compatible HTTPS endpoint on an approved host.
                  </span>
                </label>
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
              <CredentialSecret
                draft={draft}
                setDraft={setDraft}
                importing={importing}
                setError={setError}
                keyLabel={keyLabel}
                key={`${draft.kind}-${draft.auth}`}
              />
            </fieldset>
          )}
          {draft.auth === "codex-login" && !signingIn && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => {
                setImporting((value) => !value);
                setDraft({ ...draft, value: "" });
                setError("");
              }}
            >
              {importing ? "Use Browser Sign-In" : "Import auth.json"}
            </button>
          )}
          {error && (
            <p role="alert" className="text-sm leading-6 text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              {signingIn ? "Cancel Sign-In" : "Cancel"}
            </Button>
            {!isLogin && (
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !draft.value || !draft.name.trim()}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
