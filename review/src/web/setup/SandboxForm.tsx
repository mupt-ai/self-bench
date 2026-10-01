import { ArrowUpRight } from "lucide-react";
import React from "react";
import type { CredentialDraft } from "../../../../src/db/credentials";
import { Button, fieldStyles, Input } from "../ui";

/** Where each sandbox provider issues the token the form asks for. */
const providers = {
  modal: { name: "Modal", tokens: "https://modal.com/settings/tokens" },
  e2b: { name: "E2B", tokens: "https://e2b.dev/dashboard?tab=keys" },
} as const;

/** The Modal or E2B fields of the credential editor, inline in the setup popup. */
export function SandboxForm({
  kind,
  onSave,
}: {
  kind: keyof typeof providers;
  onSave(draft: CredentialDraft): Promise<void>;
}) {
  const provider = providers[kind];
  const [tokenId, setTokenId] = React.useState("");
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const complete = !!value.trim() && (kind !== "modal" || !!tokenId.trim());
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !complete) return;
        setBusy(true);
        setError("");
        try {
          await onSave({
            name: provider.name,
            kind,
            auth: "api-key",
            value: value.trim(),
            ...(kind === "modal" ? { tokenId: tokenId.trim() } : {}),
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save the sandbox.");
          setBusy(false);
        }
      }}
    >
      <a
        className="inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-4"
        href={provider.tokens}
        target="_blank"
        rel="noreferrer"
      >
        Create a Token on {provider.name}
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </a>
      <fieldset disabled={busy} className="grid gap-4">
        {kind === "modal" && (
          <label className={fieldStyles} htmlFor="setup-token-id">
            Token ID
            <Input
              id="setup-token-id"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              className="font-mono"
              value={tokenId}
              onChange={(event) => setTokenId(event.target.value)}
            />
          </label>
        )}
        <label className={fieldStyles} htmlFor="setup-secret">
          {kind === "modal" ? "Token Secret" : "API Key"}
          <Input
            id="setup-secret"
            type="password"
            autoComplete="new-password"
            maxLength={4096}
            className="font-mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" disabled={busy || !complete}>
        {busy ? "Saving…" : `Save ${provider.name}`}
      </Button>
    </form>
  );
}
