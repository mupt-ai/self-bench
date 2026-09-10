import { Box, KeyRound, Plus, RefreshCw, Terminal, Trash2 } from "lucide-react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import { ListSkeleton } from "../LoadingSkeleton";
import { Button } from "../ui";
import { credentialAccess, credentialProvider } from "./credential-presentation";

export function CredentialGroup({
  title,
  description,
  credentials,
  loading,
  canManage,
  sandbox = false,
  onAdd,
  onReplace,
  onDelete,
}: {
  title: string;
  description: string;
  credentials: CredentialInfo[];
  loading: boolean;
  canManage: boolean;
  sandbox?: boolean;
  onAdd(): void;
  onReplace(credential: CredentialInfo): void;
  onDelete(credential: CredentialInfo): void;
}) {
  const Icon = sandbox ? Box : KeyRound;
  return (
    <section aria-label={title}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2.5 font-semibold">
            {title}
            <span className="font-mono text-xs font-normal text-dim">
              {loading ? "" : credentials.length}
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
        {canManage && (
          <Button variant="ghost" onClick={onAdd}>
            <Plus size={14} aria-hidden="true" />
            {sandbox ? "Add Sandbox" : "Add Provider"}
          </Button>
        )}
      </div>
      {loading ? (
        <ListSkeleton label={`Loading ${title}`} rows={sandbox ? 2 : 3} />
      ) : credentials.length ? (
        <ul className="divide-y divide-line border border-line bg-surface">
          {credentials.map((credential) => {
            const Mark = credential.auth === "codex-login" ? Terminal : Icon;
            return (
              <li
                key={credential.id}
                className="group flex flex-wrap items-center gap-4 px-4 py-4 sm:px-5"
              >
                <span className="grid size-10 shrink-0 place-items-center border border-line bg-bg text-muted">
                  <Mark size={18} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink" title={credential.name}>
                    {credential.name}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted" title={credential.endpoint}>
                    {credentialProvider(credential)}
                    <span className="px-2 text-dim" aria-hidden="true">
                      /
                    </span>
                    {credentialAccess(credential)}
                    {credential.endpoint && (
                      <span className="ml-2 font-mono">{credential.endpoint}</span>
                    )}
                  </p>
                </div>
                <span className="hidden items-center gap-1.5 font-mono text-xs text-muted sm:inline-flex">
                  <span className="size-1.5 bg-mint/60" aria-hidden="true" />
                  Saved
                </span>
                {canManage && (
                  <div className="flex items-center gap-1 border-l border-line pl-3">
                    <Button
                      variant="ghost"
                      className="px-2"
                      aria-label={`Replace ${credential.name}`}
                      title="Replace Credential"
                      onClick={() => onReplace(credential)}
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 hover:text-danger"
                      aria-label={`Delete ${credential.name}`}
                      title="Delete Credential"
                      onClick={() => onDelete(credential)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-start gap-4 border border-dashed border-line-strong px-5 py-7">
          <Icon
            size={20}
            className="mt-0.5 shrink-0 text-dim"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium">
              {sandbox ? "No Sandbox Credentials" : "No Model Credentials"}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted">
              {sandbox
                ? "Add a cloud sandbox credential to run tasks in isolated environments."
                : "Connect ChatGPT or add a provider API key to use your models."}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
