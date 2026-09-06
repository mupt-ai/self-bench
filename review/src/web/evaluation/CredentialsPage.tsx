import React from "react";
import { Link, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, DataTable, PageContent, PageHeader } from "../ui";
import { evaluationRequest } from "./api";
import { CredentialEditor } from "./CredentialEditor";
import { useEvaluationScope } from "./useEvaluationScope";

export function CredentialsPage() {
  const scope = useEvaluationScope();
  return <CredentialsContent key={scope.url} {...scope} />;
}
function CredentialsContent({ repo, url }: { repo: string; url: string }) {
  useDocumentTitle(`Settings · ${repo}`);
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([]);
  const [editing, setEditing] = React.useState<CredentialInfo | "new">();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [search] = useSearchParams();
  const returnTo = search.get("return") === "run" ? `/repos/${repo}/run` : undefined;
  const refresh = async () => {
    const result = await evaluationRequest<{ credentials: CredentialInfo[] }>(`${url}/credentials`);
    setCredentials(result.credentials);
  };
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{ credentials: CredentialInfo[] }>(`${url}/credentials`).then(
      (result) => {
        if (!disposed) setCredentials(result.credentials);
      },
      (cause) => {
        if (!disposed) setError(cause.message);
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
    <PageContent>
      <PageHeader
        title="Credentials"
        description="Private to you. Reusable across your repositories. Encrypted at rest."
      >
        {returnTo && (
          <Link className={buttonStyles.secondary} to={returnTo}>
            Back to Run
          </Link>
        )}
      </PageHeader>
      {error && (
        <p className="my-4 font-mono text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
        <Button type="button" variant="primary" disabled={busy} onClick={() => setEditing("new")}>
          Add credential
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void action(() => evaluationRequest(`${url}/credentials/migrate`, {}))}
        >
          Import previous setups
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
              <th>Provider / sandbox</th>
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
                  {credential.auth === "codex-login" ? "Codex sign-in" : "API key"}
                  <small>{credential.endpoint}</small>
                </td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(credential)}
                  >
                    Replace
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
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
        {!credentials.length && (
          <p className="px-4 py-7 text-[13px] text-muted">
            No credentials saved. Add a provider credential and a sandbox credential to run
            evaluations.
          </p>
        )}
      </div>
    </PageContent>
  );
}
