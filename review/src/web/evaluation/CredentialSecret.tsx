import { Eye, EyeOff } from "lucide-react";
import React from "react";
import type { CredentialDraft } from "../../../../src/db/credentials";
import { fieldStyles, Input } from "../ui";

export function CredentialSecret({
  draft,
  setDraft,
  keyLabel,
}: {
  draft: CredentialDraft;
  setDraft: React.Dispatch<React.SetStateAction<CredentialDraft>>;
  keyLabel: string;
}) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className={fieldStyles}>
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
          className="absolute inset-y-0 right-0 rounded-md px-3 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
