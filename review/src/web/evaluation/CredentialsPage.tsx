import React from "react";
import { Link, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, DataTable, PageContent, PageHeader } from "../ui";
import { evaluationRequest } from "./api";
import { CredentialEditor } from "./CredentialEditor";

export function CredentialsPage() {
  const { org } = useOrg();
  return <CredentialsContent key={org.login} org={org.login} />;
}
function CredentialsContent({ org }: { org: string }) {
  useDocumentTitle(`Credentials · ${org}`);
  const url = `/api/orgs/${encodeURIComponent(org)}`;
  const [loaded, setLoaded] = React.useState(false);
  const [canManage, setCanManage] = React.useState(false);
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([]);
  const [editing, setEditing] = React.useState<CredentialInfo | "new">();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [search] = useSearchParams();
  const target = search.get("return");
  const returnTo =
    target && /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/run$/.test(target) ? target : undefined;
  const refresh = async () => {
    const result = await evaluationRequest<{ credentials: CredentialInfo[]; canManage: boolean }>(
      `${url}/credentials`,
    );
    setLoaded(true);
    setCredentials(result.credentials);
    setCanManage(result.canManage);
  };
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{ credentials: CredentialInfo[]; canManage: boolean }>(
      `${url}/credentials`,
    ).then(
      (result) => {
        if (!disposed) {
          setLoaded(true);
          setCredentials(result.credentials);
          setCanManage(result.canManage);
        }
      },
      (cause) => {
        if (!disposed) setError(`Could not load credentials: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [url]);
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Credential operation failed");
    } finally {
      setBusy(false);
    }
  };
  const save = async (draft: CredentialDraft) => {
    await evaluationRequest(`${url}/credentials`, draft);
    setEditing(undefined);
    await refresh();
  };
  return (
    <main className="w-full min-w-0 flex-1 px-4 pt-8 pb-12 sm:px-[var(--site-gutter)]">
      <PageContent>
        <PageHeader
          title="Credentials"
          description={`Shared across ${org} repositories. Organization admins manage credentials.`}
        >
          {returnTo && (
            <Link className={buttonStyles.secondary} to={returnTo}>
              Back to Run
            </Link>
          )}
        </PageHeader>
        {error && (
          <p className="my-4 font-mono text-base text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
          <Button
            type="button"
            variant="primary"
            disabled={busy || !canManage}
            onClick={() => setEditing("new")}
          >
            Add Credential
          </Button>
        </div>
        {editing && (
          <CredentialEditor
            key={typeof editing === "string" ? "new" : editing.id}
            previous={typeof editing === "string" ? undefined : editing}
            onSave={save}
            onCancel={() => setEditing(undefined)}
          />
        )}
        <div className="min-w-0">
          <DataTable className="min-w-[850px]">
            <thead>
              <tr>
                <th>Name</th>
                <th>Provider / Sandbox</th>
                <th>Authentication</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.id}>
                  <td>{credential.name}</td>
                  <td>{credential.kind}</td>
                  <td>
                    {credential.auth === "codex-login" ? "Codex Sign-In" : "API Key"}
                    <small>{credential.endpoint}</small>
                  </td>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || !canManage}
                      onClick={() => setEditing(credential)}
                    >
                      Replace
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || !canManage}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete ${credential.name}? Active comparisons prevent deletion.`,
                          )
                        )
                          void action(() =>
                            evaluationRequest(`${url}/credentials/${credential.id}/delete`, {}),
                          );
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {!loaded && !error && (
            <p className="px-4 py-7 text-base text-muted" role="status">
              Loading credentials…
            </p>
          )}
          {loaded && !error && !credentials.length && (
            <p className="px-4 py-7 text-base text-muted">
              No credentials saved. Add a provider credential and a sandbox credential to run
              evaluations.
            </p>
          )}
        </div>
      </PageContent>
    </main>
  );
}
