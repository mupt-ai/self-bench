import React from "react";
import { InfoTooltip } from "../primitives/tooltip";
import { fieldStyles, Input } from "../ui";
import { ModelIdsField, parseModelIds } from "./CredentialSettings";

/**
 * A new custom endpoint's address and saved model IDs. Its API is the harness's own: Codex calls it
 * in Responses, Claude Code in Messages, and the rest in Chat Completions.
 */
export function CustomEndpointFields({
  endpoint,
  models,
  onChange,
}: {
  endpoint: string;
  models: string;
  onChange(value: { endpoint: string; models: string[] }): void;
}) {
  // The typed text is kept as typed, so a trailing comma is not lost while the IDs are edited.
  const [text, setText] = React.useState(models);
  return (
    <>
      <label className={fieldStyles} htmlFor="credential-endpoint">
        <span className="flex items-center gap-1.5">
          Base URL
          <InfoTooltip label="An HTTPS endpoint on an approved host. Each agent calls it in its own API: Codex in Responses, Claude Code in Messages, the rest in Chat Completions." />
        </span>
        <Input
          id="credential-endpoint"
          aria-label="Base URL"
          type="url"
          required
          placeholder="https://approved-host.example/v1"
          value={endpoint}
          onChange={(event) =>
            onChange({ endpoint: event.target.value, models: parseModelIds(text) })
          }
        />
      </label>
      <ModelIdsField
        value={text}
        onChange={(next) => {
          setText(next);
          onChange({ endpoint, models: parseModelIds(next) });
        }}
      />
    </>
  );
}
