import React from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { Button, Input, Select } from "../ui";

const providerOptions = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "custom", label: "Custom" },
];
const sandboxOptions = [
  { id: "e2b", label: "E2B" },
  { id: "modal", label: "Modal" },
  { id: "daytona", label: "Daytona" },
  { id: "vercel", label: "Vercel" },
];

export function CredentialEditor({
  previous,
  onSave,
  onCancel,
}: {
  previous?: CredentialInfo;
  onSave(value: CredentialDraft): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = React.useState<CredentialDraft>({
    name: previous ? `${previous.name} replacement` : "",
    kind: previous?.kind ?? "openai",
    auth: previous?.auth ?? "api-key",
    value: "",
    endpoint: previous?.endpoint,
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <section className="my-6 max-w-2xl border border-line bg-surface p-5 [&_h2]:mb-4 [&_small]:text-sm">
      <h2>{previous ? "Replace Credential" : "Add Credential"}</h2>
      {previous && (
        <p className="mt-2 text-base text-muted">
          Creates a new credential. Existing runs keep their original reference; delete the old
          credential when no longer needed.
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onSave(draft);
            setDraft({ ...draft, value: "", tokenId: "" });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save credential");
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="min-w-0 border-0 p-0" disabled={busy}>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6">
            <label
              htmlFor="credentialeditor-field-0"
              className="grid gap-2 font-mono text-sm text-muted"
            >
              Name
              <Input
                id="credentialeditor-field-0"
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label
              htmlFor="credentialeditor-field-1"
              className="grid gap-2 font-mono text-sm text-muted"
            >
              Provider or Sandbox
              <Select
                id="credentialeditor-field-1"
                aria-label="Provider or Sandbox"
                value={draft.kind}
                onChange={(event) =>
                  setDraft({
                    name: draft.name,
                    kind: event.target.value as CredentialDraft["kind"],
                    auth: "api-key",
                    value: "",
                  })
                }
              >
                <optgroup label="Model Providers">
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Sandboxes">
                  {sandboxOptions.map((sandbox) => (
                    <option key={sandbox.id} value={sandbox.id}>
                      {sandbox.label}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </label>
            {draft.kind === "openai" && (
              <label
                htmlFor="credentialeditor-field-2"
                className="col-span-full grid gap-2 font-mono text-sm text-muted"
              >
                Authentication
                <Select
                  id="credentialeditor-field-2"
                  value={draft.auth}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      auth: event.target.value as CredentialDraft["auth"],
                      value: "",
                    })
                  }
                >
                  <option value="api-key">OpenAI API Key (Usage Billed)</option>
                  <option value="codex-login">Codex / ChatGPT Sign-In (Codex Only)</option>
                </Select>
              </label>
            )}
            {draft.kind === "custom" && (
              <label
                htmlFor="credentialeditor-field-3"
                className="col-span-full grid gap-2 font-mono text-sm text-muted"
              >
                Endpoint
                <Input
                  id="credentialeditor-field-3"
                  required
                  type="url"
                  placeholder="https://approved-host.example/v1"
                  value={draft.endpoint ?? ""}
                  onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                />
                <small>HTTPS OpenAI-compatible endpoint on an operator-approved host.</small>
              </label>
            )}
            {draft.kind === "modal" && (
              <label
                htmlFor="credentialeditor-field-4"
                className="col-span-full grid gap-2 font-mono text-sm text-muted"
              >
                Modal Token ID
                <Input
                  id="credentialeditor-field-4"
                  required
                  type="password"
                  autoComplete="new-password"
                  value={draft.tokenId ?? ""}
                  onChange={(event) => setDraft({ ...draft, tokenId: event.target.value })}
                />
              </label>
            )}
            {draft.kind === "vercel" &&
              (["teamId", "projectId"] as const).map((field) => (
                <label
                  key={field}
                  htmlFor={`credentialeditor-${field}`}
                  className="grid gap-2 font-mono text-sm text-muted"
                >
                  {field === "teamId" ? "Vercel Team ID" : "Vercel Project ID"}
                  <Input
                    id={`credentialeditor-${field}`}
                    required
                    autoComplete="off"
                    maxLength={256}
                    value={draft[field] ?? ""}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                  />
                </label>
              ))}
            {draft.auth === "codex-login" ? (
              <label
                htmlFor="credentialeditor-field-5"
                className="col-span-full grid gap-2 font-mono text-sm text-muted"
              >
                Codex auth.json
                <Input
                  id="credentialeditor-field-5"
                  required
                  type="file"
                  accept="application/json,.json"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 24000) {
                      setError("Auth file exceeds 24 KB");
                      return;
                    }
                    setDraft({ ...draft, value: await file.text() });
                  }}
                />
                <small>
                  Explicitly saves your sign-in encrypted for use in the selected sandbox.
                  Subscription limits still apply. No API-key fallback.
                </small>
              </label>
            ) : (
              <label
                htmlFor="credentialeditor-field-6"
                className="col-span-full grid gap-2 font-mono text-sm text-muted"
              >
                {["e2b", "daytona"].includes(draft.kind)
                  ? "Sandbox API Key"
                  : draft.kind === "modal"
                    ? "Modal Token Secret"
                    : draft.kind === "vercel"
                      ? "Vercel Token"
                      : "Model API Key"}
                <Input
                  id="credentialeditor-field-6"
                  required
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                />
              </label>
            )}
          </div>
          {error && (
            <p className="my-4 font-mono text-base text-danger" role="alert">
              {error}
            </p>
          )}
          <p className="mt-2 text-base text-muted">
            Saved secrets are never shown again. Saving does not run a model or validate account
            access.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!draft.value}>
              {busy ? "Saving…" : "Save Credential"}
            </Button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
