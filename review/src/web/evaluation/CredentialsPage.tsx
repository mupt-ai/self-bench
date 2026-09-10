import { ArrowUpRight, LockKeyhole, Plus, Terminal } from "lucide-react";
import React from "react";
import { Link, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { Skeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, PageHeader } from "../ui";
import { evaluationRequest } from "./api";
import { CredentialEditor } from "./CredentialEditor";
import { CredentialGroup } from "./CredentialGroup";
import { isSandbox } from "./credential-presentation";
import { DeleteCredentialDialog } from "./DeleteCredentialDialog";

type Editor = {
  previous?: CredentialInfo;
  kind?: CredentialDraft["kind"];
  auth?: CredentialDraft["auth"];
};
type Credentials = { credentials: CredentialInfo[]; canManage: boolean };

export function CredentialsPage() {
  const { org } = useOrg();
  return <CredentialsContent key={org.login} org={org.login} />;
}
function CredentialsContent({ org }: { org: string }) {
  useDocumentTitle(`Credentials · ${org}`);
  const url = `/api/orgs/${encodeURIComponent(org)}/credentials`;
  const [data, setData] = React.useState<Credentials>();
  const [editing, setEditing] = React.useState<Editor>();
  const [deleting, setDeleting] = React.useState<CredentialInfo>();
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [search] = useSearchParams();
  const target = search.get("return");
  const returnTo =
    target && /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/run$/.test(target) ? target : undefined;
  React.useEffect(() => {
    let disposed = false;
    setError("");
    evaluationRequest<Credentials>(url).then(
      (result) => {
        if (!disposed) setData(result);
      },
      (cause) => {
        if (!disposed) setError(`Could not load credentials: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [url]);
  const refresh = async () => {
    try {
      setData(await evaluationRequest<Credentials>(url));
      setError("");
    } catch {
      setError("Could not refresh credentials. Reload the list to try again.");
    }
  };
  const saved = async () => {
    setEditing(undefined);
    setNotice("Credential saved. It is now available across this organization.");
    await refresh();
  };
  const save = async (draft: CredentialDraft) => {
    await evaluationRequest(url, draft);
    await saved();
  };
  const canManage = data?.canManage ?? false;
  const credentials = data?.credentials ?? [];
  const groupProps = {
    loading: !data && !error,
    canManage,
    onReplace: (previous: CredentialInfo) => setEditing({ previous }),
    onDelete: setDeleting,
  };
  return (
    <main className="w-full min-w-0 flex-1 px-4 pt-8 pb-12 sm:px-[var(--site-gutter)]">
      <div className="mx-auto w-full max-w-5xl">
        <PageHeader title="Credentials" description={`Shared across ${org} repositories.`}>
          <div className="flex gap-2">
            {returnTo && (
              <Link className={buttonStyles.secondary} to={returnTo}>
                Back to Run
              </Link>
            )}
            {(canManage || !data) && (
              <Button variant="primary" disabled={!canManage} onClick={() => setEditing({})}>
                <Plus size={15} aria-hidden="true" />
                Add Credential
              </Button>
            )}
          </div>
        </PageHeader>
        {error && (
          <div
            role="alert"
            className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
          >
            <p>{error}</p>
            <Button onClick={() => void refresh()}>Reload List</Button>
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="mb-5 border-l-2 border-mint bg-mint/5 px-4 py-3 text-sm text-mint"
          >
            {notice}
          </p>
        )}
        {!data && !error && (
          <div
            role="status"
            aria-label="Loading Account Options"
            className="mb-9 flex flex-wrap items-center gap-5 border border-line bg-surface px-5 py-6 sm:px-6"
          >
            <Skeleton className="size-11 shrink-0" />
            <div className="min-w-0 flex-1 basis-52 space-y-3">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <Skeleton className="h-9 w-48" />
            <span className="sr-only">Loading account options…</span>
          </div>
        )}
        {canManage && (
          <section
            className="mb-9 flex flex-wrap items-center gap-5 border border-line bg-surface px-5 py-6 sm:px-6"
            aria-label="Connect Codex"
          >
            <span className="grid size-11 shrink-0 place-items-center border border-mint/25 bg-mint/5 text-mint">
              <Terminal size={22} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 basis-52">
              <h2 className="text-base font-semibold">Use Your ChatGPT Account</h2>
              <p className="mt-1.5 max-w-lg text-sm leading-6 text-muted">
                Connect Codex for evaluations with your ChatGPT plan. Your subscription limits
                apply.
              </p>
            </div>
            <Button onClick={() => setEditing({ kind: "openai", auth: "codex-login" })}>
              Sign in with ChatGPT
              <ArrowUpRight size={15} aria-hidden="true" />
            </Button>
          </section>
        )}
        {data && !canManage && (
          <p className="mb-7 border-l-2 border-line-strong pl-4 text-sm text-muted">
            You can use these credentials in runs. An organization admin can add, replace, or delete
            them.
          </p>
        )}
        {(!error || data) && (
          <div className="space-y-9">
            <CredentialGroup
              {...groupProps}
              title="Model Providers"
              description="Accounts and API keys for the models you evaluate."
              credentials={credentials.filter((entry) => !isSandbox(entry.kind))}
              onAdd={() => setEditing({})}
            />
            <CredentialGroup
              {...groupProps}
              title="Sandboxes"
              description="Credentials for the environments that run your tasks."
              credentials={credentials.filter((entry) => isSandbox(entry.kind))}
              sandbox
              onAdd={() => setEditing({ kind: "modal" })}
            />
          </div>
        )}
        <div className="mt-8 flex items-start gap-2.5 border-t border-line pt-5 text-xs leading-5 text-muted">
          <LockKeyhole size={14} className="mt-0.5 shrink-0 text-dim" aria-hidden="true" />
          <p>
            Secrets are encrypted and never displayed after saving. API keys are saved without
            checking account access.
          </p>
        </div>
        {editing && (
          <CredentialEditor
            {...editing}
            org={org}
            onSave={save}
            onSaved={saved}
            onCancel={() => setEditing(undefined)}
          />
        )}
        {deleting && (
          <DeleteCredentialDialog
            credential={deleting}
            onClose={() => setDeleting(undefined)}
            onDelete={async () => {
              await evaluationRequest(`${url}/${deleting.id}/delete`, {});
              setDeleting(undefined);
              setNotice("Credential deleted.");
              await refresh();
            }}
          />
        )}
      </div>
    </main>
  );
}
