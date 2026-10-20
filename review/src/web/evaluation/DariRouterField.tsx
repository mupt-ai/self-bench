import type { CredentialDraft } from "../../../../src/db/credentials";
import { fieldStyles, Input } from "../ui";

/** Dari's router: none for the default router, else the router the credential names. */
export function DariRouterField({
  value,
  onChange,
}: {
  value: CredentialDraft["endpoint"];
  onChange(endpoint: string): void;
}) {
  return (
    <label className={fieldStyles} htmlFor="credential-endpoint">
      Router URL
      <Input
        id="credential-endpoint"
        type="url"
        placeholder="https://routing.dari.dev/v1"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="text-xs font-normal leading-5 text-muted-foreground">
        Leave blank for the default router, or name one as https://routing.dari.dev/rtr_… without
        /chat/completions.
      </span>
    </label>
  );
}
