import { ArrowUpRight } from "lucide-react";
import React from "react";
import type { CredentialDraft } from "../../../../src/db/credentials";
import { Button, fieldStyles, Input } from "../ui";

/** Where each sandbox provider issues the token the form asks for, and the ids it needs beside it. */
const providers = {
  modal: {
    name: "Modal",
    tokens: "https://modal.com/settings/tokens",
    secret: "Token Secret",
    ids: { tokenId: "Token ID" },
  },
  e2b: { name: "E2B", tokens: "https://e2b.dev/dashboard?tab=keys", secret: "API Key", ids: {} },
  daytona: {
    name: "Daytona",
    tokens: "https://app.daytona.io/dashboard/keys",
    secret: "API Key",
    ids: {},
  },
  vercel: {
    name: "Vercel",
    tokens: "https://vercel.com/account/settings/tokens",
    secret: "Vercel Token",
    ids: { teamId: "Vercel Team ID", projectId: "Vercel Project ID" },
  },
} as const satisfies Record<
  string,
  { name: string; tokens: string; secret: string; ids: Partial<Record<IdField, string>> }
>;
type IdField = "tokenId" | "teamId" | "projectId";
export type SandboxKind = keyof typeof providers;

/** A sandbox's fields of the credential editor, inline in the setup popup. */
export function SandboxForm({
  kind,
  onSave,
}: {
  kind: SandboxKind;
  onSave(draft: CredentialDraft): Promise<void>;
}) {
  const provider = providers[kind];
  const fields = Object.entries(provider.ids) as [IdField, string][];
  const [ids, setIds] = React.useState<Partial<Record<IdField, string>>>({});
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const complete = !!value.trim() && fields.every(([key]) => !!ids[key]?.trim());
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
            ...Object.fromEntries(fields.map(([key]) => [key, ids[key]?.trim()])),
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save the sandbox.");
          setBusy(false);
        }
      }}
    >
      <a
        className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline decoration-foreground/35 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        href={provider.tokens}
        target="_blank"
        rel="noreferrer"
      >
        Create a Token on {provider.name}
        <ArrowUpRight className="size-3.5 text-faint" aria-hidden="true" />
      </a>
      <fieldset disabled={busy} className="grid gap-4">
        {fields.map(([key, label]) => (
          <label key={key} className={fieldStyles} htmlFor={`setup-${key}`}>
            {label}
            <Input
              id={`setup-${key}`}
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              className="font-mono"
              value={ids[key] ?? ""}
              onChange={(event) => setIds({ ...ids, [key]: event.target.value })}
            />
          </label>
        ))}
        <label className={fieldStyles} htmlFor="setup-secret">
          {provider.secret}
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
