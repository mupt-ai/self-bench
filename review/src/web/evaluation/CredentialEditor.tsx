import { LockKeyhole, X } from "lucide-react";
import React from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { Button, Input, Select } from "../ui";
import { useModalDialog } from "../useModalDialog";
import { CodexSignIn } from "./CodexSignIn";
import { CredentialSecret } from "./CredentialSecret";
import { providers, sandboxes } from "./credential-presentation";

const field = "grid gap-2 text-sm font-medium text-ink";
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
  const dialog = useModalDialog(name);
  const isLogin = draft.auth === "codex-login" && !importing;
  const keyLabel =
    draft.kind === "modal"
      ? "Modal Token Secret"
      : sandboxes.some((entry) => entry.id === draft.kind)
        ? "Sandbox API Key"
        : "Model API Key";
  return (
    <dialog
      ref={dialog}
      aria-labelledby="credential-title"
      aria-describedby="credential-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto border border-line-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/65"
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <h2 id="credential-title" className="text-lg font-semibold">
            {previous ? "Replace Credential" : "Add Credential"}
          </h2>
          <p id="credential-description" className="mt-1 text-sm text-muted">
            Available to repositories in <span className="font-medium text-ink">{org}</span>.
          </p>
        </div>
        <Button
          variant="ghost"
          className="-mr-2 px-2"
          aria-label="Close"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={18} aria-hidden="true" />
        </Button>
      </header>
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
        <div className="space-y-5 px-6 py-6">
          {previous && (
            <p className="border-l-2 border-line-strong pl-3 text-xs leading-5 text-muted">
              This creates a new credential. Existing runs keep the original; delete it when it’s no
              longer needed.
            </p>
          )}
          <fieldset disabled={busy || signingIn} className="space-y-5">
            <label className={field} htmlFor="credential-provider">
              Provider or Sandbox
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
                <optgroup label="Model Providers">
                  {providers.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Sandboxes">
                  {sandboxes.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </label>
            {draft.kind === "openai" && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Authentication</legend>
                <div className="grid grid-cols-2 border border-line-strong p-1">
                  {[
                    { id: "api-key", label: "API Key" },
                    { id: "codex-login", label: "ChatGPT Sign-In" },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={draft.auth === option.id}
                      className={`px-2 py-2 text-sm transition-colors ${draft.auth === option.id ? "bg-surface-3 font-medium text-mint" : "text-muted hover:text-ink"}`}
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
            <label className={field} htmlFor="credential-name">
              Credential Name
              <Input
                ref={name}
                id="credential-name"
                required
                maxLength={80}
                placeholder={
                  draft.auth === "codex-login" ? "e.g. Team Codex" : "e.g. Evaluation API key"
                }
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <span className="text-xs font-normal text-muted">
                A name your team will recognize when choosing credentials.
              </span>
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
                <label className={field} htmlFor="credential-endpoint">
                  Endpoint
                  <Input
                    id="credential-endpoint"
                    type="url"
                    required
                    placeholder="https://approved-host.example/v1"
                    value={draft.endpoint ?? ""}
                    onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                  />
                  <span className="text-xs font-normal leading-5 text-muted">
                    An OpenAI-compatible HTTPS endpoint on an approved host.
                  </span>
                </label>
              )}
              {draft.kind === "modal" && (
                <label className={field} htmlFor="credential-token-id">
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
              <CredentialSecret
                draft={draft}
                setDraft={setDraft}
                importing={importing}
                org={org}
                setError={setError}
                keyLabel={keyLabel}
                key={`${draft.kind}-${draft.auth}`}
              />
            </fieldset>
          )}
          {draft.auth === "codex-login" && !signingIn && (
            <button
              type="button"
              className="text-xs text-muted underline underline-offset-4 hover:text-mint"
              onClick={() => {
                setImporting((value) => !value);
                setDraft({ ...draft, value: "" });
                setError("");
              }}
            >
              {importing ? "Use Browser Sign-In" : "Import an Existing auth.json"}
            </button>
          )}
          {error && (
            <p role="alert" className="text-sm leading-6 text-danger">
              {error}
            </p>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line bg-bg/50 px-6 py-4">
          <p className="flex items-center gap-2 text-xs text-muted">
            <LockKeyhole size={13} aria-hidden="true" />
            Encrypted Storage
          </p>
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
                {busy ? "Saving…" : "Save Credential"}
              </Button>
            )}
          </div>
        </footer>
      </form>
    </dialog>
  );
}
