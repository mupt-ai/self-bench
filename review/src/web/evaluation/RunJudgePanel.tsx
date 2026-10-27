import { Scale } from "lucide-react";
import { Link } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { judgeCredentialRefusal } from "../../../../src/evaluation/judge";
import type { JudgeNeeds } from "../../../../src/harnesses/harbor/host-variables";
import { fieldStyles, Select } from "../ui";

/** The org's credentials that can call a benchmark's LLM judge (judgeCredentialRefusal). */
export function judgeCredentials(credentials: readonly CredentialInfo[]): CredentialInfo[] {
  return credentials.filter(
    (credential) => credential.id !== "managed-model" && !judgeCredentialRefusal(credential),
  );
}

/**
 * Picks the credential a benchmark's LLM judge calls with, for tasks graded (or played against)
 * by a model: their `env` reads `needs.variables`, which the run fills from this key alone.
 */
export function RunJudgePanel({
  pages,
  needs,
  credentials,
  value,
  onChange,
  disabled,
}: {
  pages: string;
  needs: JudgeNeeds;
  credentials: readonly CredentialInfo[];
  value: string | undefined;
  onChange(credentialId: string): void;
  disabled: boolean;
}) {
  const eligible = judgeCredentials(credentials);
  return (
    <section className="panel mb-5 p-4" aria-labelledby="judge-heading">
      <div className="flex items-start gap-3">
        <Scale className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="judge-heading" className="text-sm font-semibold">
            LLM Judge
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These tasks are graded by a model, which reads{" "}
            <span className="font-mono">{needs.variables.join(", ")}</span>. Its calls use the key
            you pick here, and cost extra on that key.
          </p>
        </div>
      </div>
      {eligible.length ? (
        <label className={`${fieldStyles} mt-3 max-w-sm`} htmlFor="judge-credential">
          Judge Credential
          <Select
            id="judge-credential"
            value={value ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="" disabled>
              Select Credential
            </option>
            {eligible.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </Select>
        </label>
      ) : (
        <p className="mt-3 text-sm">
          None of your credentials can call this judge.{" "}
          <Link
            className="font-semibold underline underline-offset-4"
            to={`/settings/credentials?return=${encodeURIComponent(`${pages}/run`)}`}
          >
            Add an API Key
          </Link>{" "}
          for its provider, or for OpenRouter or Vercel AI Gateway.
        </p>
      )}
    </section>
  );
}
