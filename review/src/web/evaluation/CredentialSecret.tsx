import { Eye, EyeOff } from "lucide-react";
import React from "react";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { Input } from "../ui";

const field = "grid gap-2 text-sm font-medium text-ink";
export function CredentialSecret({
  draft,
  setDraft,
  importing,
  org,
  setError,
  keyLabel,
}: {
  draft: CredentialDraft;
  setDraft: React.Dispatch<React.SetStateAction<CredentialDraft>>;
  importing: boolean;
  org: string;
  setError(error: string): void;
  keyLabel: string;
}) {
  const [visible, setVisible] = React.useState(false);
  const fileVersion = React.useRef(0);
  React.useEffect(
    () => () => {
      fileVersion.current++;
    },
    [],
  );
  return (
    <>
      {importing ? (
        <label className={field} htmlFor="credential-auth-file">
          Codex auth.json
          <Input
            id="credential-auth-file"
            type="file"
            required
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              const version = ++fileVersion.current;
              setDraft((current) => ({ ...current, value: "" }));
              setError("");
              if (!file) return;
              if (file.size > 24000) {
                setError("Auth file exceeds 24 KB.");
                return;
              }
              try {
                const value = await file.text();
                if (version !== fileVersion.current) return;
                const parsed = JSON.parse(value);
                if (
                  !parsed.tokens?.access_token ||
                  !parsed.tokens?.refresh_token ||
                  parsed.OPENAI_API_KEY
                )
                  throw new Error();
                setDraft((current) => ({ ...current, value }));
              } catch {
                if (version !== fileVersion.current) return;
                setError("Choose a Codex ChatGPT auth.json containing a subscription sign-in.");
              }
            }}
          />
          <span className="text-xs font-normal leading-5 text-muted">
            Import a sign-in from the Codex CLI. This saves access for Codex runs across {org}.
          </span>
        </label>
      ) : (
        <div className={field}>
          <label htmlFor="credential-secret">{keyLabel}</label>
          <div className="relative">
            <Input
              id="credential-secret"
              className="pr-12"
              required
              type={visible ? "text" : "password"}
              autoComplete="new-password"
              maxLength={4096}
              value={draft.value}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
            <button
              type="button"
              aria-label={visible ? "Hide Secret" : "Show Secret"}
              className="absolute inset-y-0 right-0 px-3 text-muted hover:text-ink"
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
