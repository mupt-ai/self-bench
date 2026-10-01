import { Plus } from "lucide-react";
import React from "react";
import { Link, useSearchParams } from "react-router";
import type { CredentialDraft } from "../../../../src/db/credentials";
import { evaluationRequest } from "../evaluation/api";
import { CredentialEditor } from "../evaluation/CredentialEditor";
import { isSandbox } from "../evaluation/credential-presentation";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle, useSession } from "../session";
import { Button, buttonStyles, Notice, PageFrame, PageHeader } from "../ui";
import { covered, setupCoverage, setupReturn } from "./readiness";
import { useSetupStatus } from "./SetupStatus";
import { Capability, Connected, Step, SubscriptionCard, subscriptions } from "./SetupSteps";

type Editor = { kind: CredentialDraft["kind"]; auth: CredentialDraft["auth"] };

/**
 * First-run setup: connect a model and a sandbox, then start. Every step reuses the
 * Credentials page's editor and sign-in flows, and the checklist follows the organization's
 * saved credentials, so it is equally a status page once setup is done.
 */
export function SetupPage() {
  const { org } = useOrg();
  useDocumentTitle(`Get Started · ${org.login}`);
  const { credentials, canManage, error, refresh } = useSetupStatus();
  const { session } = useSession();
  const [editing, setEditing] = React.useState<Editor>();
  const [search] = useSearchParams();
  const back = setupReturn(search.get("return"));
  const url = `/api/orgs/${encodeURIComponent(org.login)}/credentials`;
  const saved = async () => {
    setEditing(undefined);
    await refresh();
  };
  const models = credentials?.filter((entry) => !isSandbox(entry.kind)) ?? [];
  const sandboxes = credentials?.filter((entry) => isSandbox(entry.kind)) ?? [];
  const coverage = setupCoverage(credentials ?? []);
  const ready = covered(coverage.generate) && covered(coverage.evaluate);
  const manage = canManage && !!credentials;
  return (
    <PageFrame className="[&>div]:max-w-4xl">
      <PageHeader
        title="Get Started"
        description={`Connect a model and a sandbox so ${org.login} can generate tasks and run evaluations.`}
      >
        {back && (
          <Link className={buttonStyles.secondary} to={back.to}>
            {back.label}
          </Link>
        )}
      </PageHeader>
      {error && (
        <Notice className="mb-6">
          <p>Could not load credentials: {error}</p>
          <Button onClick={() => void refresh()}>Reload</Button>
        </Notice>
      )}
      {session.status === "signed-in" && session.managedOffering && (
        <Notice tone="info" className="mb-6">
          This deployment also offers managed models and sandboxes, which Generate Batch and Run
          list beside your credentials. This checklist covers your own credentials.
        </Notice>
      )}
      {!credentials && !error && <ListSkeleton label="Loading Setup" rows={3} />}
      {credentials && !canManage && !ready && (
        <Notice tone="info" className="mb-6">
          Only admins can connect credentials. Ask an admin of {org.login} to finish these steps.
        </Notice>
      )}
      {credentials && (
        <ol className="grid gap-5">
          <Step
            number={1}
            done={models.length > 0}
            title="Connect a Model"
            description="Sign in with a ChatGPT or Claude plan you already have, or add an API key. Runs count against that plan or account."
          >
            <div className="grid gap-3 md:grid-cols-2">
              {subscriptions.map((subscription) => (
                <SubscriptionCard
                  key={subscription.auth}
                  subscription={subscription}
                  connected={models.filter((entry) => entry.auth === subscription.auth)}
                  onSignIn={
                    manage
                      ? () => setEditing({ kind: subscription.kind, auth: subscription.auth })
                      : undefined
                  }
                />
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Prefer an API key? OpenAI, Anthropic, and OpenRouter keys work for generation and
                evaluation.
              </p>
              {manage && (
                <Button
                  size="small"
                  onClick={() => setEditing({ kind: "openai", auth: "api-key" })}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  Add API Key
                </Button>
              )}
            </div>
            <Connected
              className="mt-3"
              credentials={models.filter((entry) => entry.auth === "api-key")}
            />
          </Step>
          <Step
            number={2}
            done={sandboxes.length > 0}
            title="Connect a Sandbox"
            description="Tasks build and run in containers on your own sandbox account. Modal and E2B handle both generation and evaluation; Vercel only generates and Daytona only evaluates."
          >
            {manage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={sandboxes.length ? "secondary" : "primary"}
                  onClick={() => setEditing({ kind: "modal", auth: "api-key" })}
                >
                  Add Modal
                </Button>
                <Button onClick={() => setEditing({ kind: "e2b", auth: "api-key" })}>
                  Add E2B
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setEditing({ kind: "vercel", auth: "api-key" })}
                >
                  Vercel or Daytona
                </Button>
              </div>
            )}
            <Connected className="mt-3" credentials={sandboxes} />
          </Step>
          <Step
            number={3}
            done={ready}
            title="Start"
            description={
              ready
                ? "You're set. Connect a repository, generate a batch of tasks from its merged pull requests, then run models against the tasks you accept."
                : "Each workflow needs a model and a sandbox it can run on."
            }
          >
            <dl className="grid gap-px border border-border bg-border sm:grid-cols-2">
              <Capability
                label="Generate Tasks"
                coverage={coverage.generate}
                missing={{
                  model: "Needs a ChatGPT sign-in or a model API key.",
                  sandbox: "Needs a Modal, E2B, or Vercel sandbox.",
                }}
              />
              <Capability
                label="Run Evaluations"
                coverage={coverage.evaluate}
                missing={{
                  model: "Needs a model sign-in or API key.",
                  sandbox: "Needs a Modal, E2B, or Daytona sandbox.",
                }}
              />
            </dl>
            {(ready || back) && (
              <div className="mt-4 flex flex-wrap gap-2">
                {back ? (
                  <Link className={buttonStyles.primary} to={back.to}>
                    {back.label}
                  </Link>
                ) : (
                  <Link className={buttonStyles.primary} to="/">
                    Go to Repositories
                  </Link>
                )}
              </div>
            )}
          </Step>
        </ol>
      )}
      {editing && (
        <CredentialEditor
          {...editing}
          org={org.login}
          onSave={async (draft) => {
            await evaluationRequest(url, draft);
            await saved();
          }}
          onSaved={saved}
          onCancel={() => setEditing(undefined)}
        />
      )}
    </PageFrame>
  );
}
