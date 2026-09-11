import { Plus } from "lucide-react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import { Skeleton } from "../LoadingSkeleton";
import { Button, SectionHeader } from "../ui";
import { CredentialActions } from "./CredentialActions";
import { credentialAccess, credentialProvider } from "./credential-presentation";

export function CredentialGroup({
  title,
  credentials,
  loading,
  canManage,
  sandbox = false,
  onAdd,
  onReplace,
  onDelete,
}: {
  title: string;
  credentials: CredentialInfo[];
  loading: boolean;
  canManage: boolean;
  sandbox?: boolean;
  onAdd(): void;
  onReplace(credential: CredentialInfo): void;
  onDelete(credential: CredentialInfo): void;
}) {
  return (
    <section aria-label={title}>
      <SectionHeader
        title={
          <>
            {title}
            {!loading && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {credentials.length}
              </span>
            )}
          </>
        }
      >
        {canManage && (
          <Button variant="ghost" size="small" onClick={onAdd}>
            <Plus aria-hidden="true" />
            {sandbox ? "Add Sandbox" : "Add Provider"}
          </Button>
        )}
        {loading && <Skeleton className="h-8 w-28" />}
      </SectionHeader>
      {loading ? (
        <div
          role="status"
          aria-label={`Loading ${title}`}
          className="divide-y divide-border border border-border bg-card"
        >
          {Array.from({ length: sandbox ? 2 : 3 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed, stateless loading placeholders.
            <div key={index} className="px-4 py-3.5">
              <Skeleton className="h-5 w-36 max-w-full" />
              <Skeleton className="mt-1 h-4 w-48 max-w-full" />
            </div>
          ))}
        </div>
      ) : credentials.length ? (
        <ul className="divide-y divide-border border border-border bg-card">
          {credentials.map((credential) => (
            <li key={credential.id} className="flex items-center gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={credential.name}>
                  {credential.name}
                </p>
                <p
                  className="mt-1 truncate text-xs text-muted-foreground"
                  title={credential.endpoint}
                >
                  {credentialProvider(credential)} · {credentialAccess(credential)}
                  {credential.endpoint && <> · {credential.endpoint}</>}
                </p>
              </div>
              {canManage && (
                <CredentialActions
                  name={credential.name}
                  onReplace={() => onReplace(credential)}
                  onDelete={() => onDelete(credential)}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          No credentials yet.
        </p>
      )}
    </section>
  );
}
