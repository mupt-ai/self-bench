import React from "react";
import { Link, useSearchParams } from "react-router";
import type { CredentialDraft, CredentialInfo } from "../../../../src/db/credentials";
import type { DariLinkBrowserConfig } from "../../../../src/gateway/dari-link/connection";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { useSetupStatus } from "../setup/SetupStatus";
import { Button, buttonStyles, Notice, PageFrame, PageHeader } from "../ui";
import { evaluationRequest } from "./api";
import { CredentialEditor } from "./CredentialEditor";
import { CredentialGroup } from "./CredentialGroup";
import { EditCredentialDialog } from "./CredentialSettings";
import { isSandbox } from "./credential-presentation";
import { useDariConnect } from "./DariConnect";
import { DariPlans } from "./DariPlans";
import { DeleteCredentialDialog } from "./DeleteCredentialDialog";

type Editor = { previous?: CredentialInfo; kind?: CredentialDraft["kind"] };
type Credentials = {
  credentials: CredentialInfo[];
  canManage: boolean;
  /** What Connect with Dari needs; null when this deployment has no Dari Link. */
  dariLink: DariLinkBrowserConfig | null;
};

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
  const [changing, setChanging] = React.useState<CredentialInfo>();
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [search] = useSearchParams();
  const setup = useSetupStatus();
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
    void setup.refresh();
    try {
      setData(await evaluationRequest<Credentials>(url));
      setError("");
    } catch {
      setError("Could not refresh credentials. Reload the list to try again.");
    }
  };
  const save = async (draft: CredentialDraft) => {
    await evaluationRequest(url, draft);
    setEditing(undefined);
    setNotice("Credential saved.");
    await refresh();
  };
  const dari = useDariConnect(org, data?.dariLink, async () => {
    setNotice("Dari connected.");
    await refresh();
  });
  const canManage = data?.canManage ?? false;
  const credentials = data?.credentials ?? [];
  const groupProps = { loading: !data && !error, canManage, onDelete: setDeleting };
  const endpoints = credentials.filter((entry) => entry.kind === "custom");
  const keys = credentials.filter(
    (entry) => !isSandbox(entry.kind) && entry.auth !== "dari-link" && entry.kind !== "custom",
  );
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
        <div className="grid gap-10">
          <div>
            <CredentialGroup
              {...groupProps}
              title="AI Subscriptions"
              credentials={credentials.filter((entry) => entry.auth === "dari-link")}
              addLabel={
                dari.connecting
                  ? "Connecting…"
                  : credentials.some((entry) => entry.auth === "dari-link")
                    ? "Update Plans"
                    : "Connect with Dari"
              }
              onEdit={setChanging}
              detail={(credential) => <DariPlans org={org} credentialId={credential.id} />}
              {...(data?.dariLink ? { onAdd: dari.connect } : {})}
            />
            {dari.error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {dari.error}
              </p>
            )}
          </div>
          <CredentialGroup
            {...groupProps}
            title="Sandboxes"
            credentials={credentials.filter((entry) => isSandbox(entry.kind))}
            sandbox
            onEdit={setChanging}
            onReplace={(previous) => setEditing({ previous })}
            onAdd={() => setEditing({ kind: "modal" })}
          />
          {/* Models Dari does not serve: an OpenAI-compatible router or inference host. */}
          <CredentialGroup
            {...groupProps}
            title="Custom Endpoints"
            credentials={endpoints}
            addLabel="Add Endpoint"
            onEdit={setChanging}
            onReplace={(previous) => setEditing({ previous })}
            onAdd={() => setEditing({ kind: "custom" })}
          />
          {/* Provider and gateway keys: what an LLM judge calls with, and models Dari does not connect. */}
          <CredentialGroup
            {...groupProps}
            title="API Keys"
            credentials={keys}
            addLabel="Add API Key"
            onEdit={setChanging}
            onReplace={(previous) => setEditing({ previous })}
            onAdd={() => setEditing({ kind: "openai" })}
          />
        </div>
      )}
      {editing && (
        <CredentialEditor
          {...editing}
          org={org}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {changing && (
        <EditCredentialDialog
          credential={changing}
          onClose={() => setChanging(undefined)}
          onDetect={() => evaluationRequest(`${url}/${changing.id}/infer-limits`, {})}
          onSave={async (settings) => {
            await evaluationRequest(`${url}/${changing.id}/update`, settings);
            setChanging(undefined);
            setNotice("Credential saved.");
            await refresh();
          }}
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
