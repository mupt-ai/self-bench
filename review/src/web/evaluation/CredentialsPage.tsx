import React from "react";
import { Link, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CredentialDraft } from "../../../../src/evaluation/credentials";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, Notice, PageFrame, PageHeader } from "../ui";
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
    setNotice("Credential saved.");
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
    <PageFrame>
      <PageHeader title="Credentials" description={`Shared with ${org}.`}>
        {returnTo && (
          <Link className={buttonStyles.secondary} to={returnTo}>
            Back to Run
          </Link>
        )}
      </PageHeader>
      {error && (
        <Notice className="mb-6">
          <p>{error}</p>
          <Button onClick={() => void refresh()}>Reload List</Button>
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      )}
      {data && !canManage && (
        <p className="mb-6 text-sm text-muted-foreground">Only admins can manage credentials.</p>
      )}
      {(!error || data) && (
        <div className="space-y-8">
          <CredentialGroup
            {...groupProps}
            title="Model Providers"
            credentials={credentials.filter((entry) => !isSandbox(entry.kind))}
            onAdd={() => setEditing({})}
          />
          <CredentialGroup
            {...groupProps}
            title="Sandboxes"
            credentials={credentials.filter((entry) => isSandbox(entry.kind))}
            sandbox
            onAdd={() => setEditing({ kind: "modal" })}
          />
        </div>
      )}
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
    </PageFrame>
  );
}
