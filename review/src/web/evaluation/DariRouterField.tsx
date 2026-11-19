import type { CredentialDraft } from "../../../../src/db/credentials";
import { InfoTooltip } from "../primitives/tooltip";
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
      <span className="flex items-center gap-1.5">
        Router URL
        <InfoTooltip label="Leave blank for the default router, or name one as https://routing.dari.dev/rtr_… without /chat/completions." />
      </span>
      <Input
        id="credential-endpoint"
        aria-label="Router URL"
        type="url"
        placeholder="https://routing.dari.dev/v1"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
