import { X } from "lucide-react";
import React from "react";
import { Link } from "react-router";
import type { CredentialDraft, CredentialInfo } from "../../../../src/db/credentials";
import { Dialog } from "../Dialog";
import { evaluationRequest } from "../evaluation/api";
import { ClaudeSignIn } from "../evaluation/ClaudeSignIn";
import { CodexSignIn } from "../evaluation/CodexSignIn";
import { isSandbox } from "../evaluation/credential-presentation";
import { cn } from "../primitives/cn";
import { Button } from "../ui";
import { covered, setupCoverage } from "./readiness";
import { SandboxForm } from "./SandboxForm";
import { type Choice, Choices, Status } from "./SetupRows";

const plans = [
  {
    id: "codex-login",
    title: "ChatGPT",
    detail: "Runs Codex. Generates tasks and evaluates OpenAI models.",
  },
  {
    id: "claude-login",
    title: "Claude",
    detail: "Runs Claude Code. Evaluates Claude models, but can't generate tasks.",
  },
] as const;
const sandboxes = [
  { id: "modal", title: "Modal", detail: "Generates tasks and runs evaluations." },
  { id: "e2b", title: "E2B", detail: "Generates tasks and runs evaluations." },
] as const;

/**
 * First-run setup as one popup: sign in with a coding plan, connect a sandbox, then see what
 * the organization can run. The sign-ins are the Credentials page's own flows, started inline.
 */
export function SetupDialog({
  org,
  credentials,
  canManage,
  refresh,
  onClose,
}: {
  org: string;
  credentials: CredentialInfo[];
  canManage: boolean;
  refresh(): Promise<void>;
  onClose(): void;
}) {
  const coverage = setupCoverage(credentials);
  const hasModel = coverage.evaluate.model;
  const hasSandbox = credentials.some((entry) => isSandbox(entry.kind));
  const [step, setStep] = React.useState(() =>
    !canManage ? 2 : !hasModel ? 0 : !coverage.generate.sandbox ? 1 : 2,
  );
  const [open, setOpen] = React.useState<Choice>();
  // Focus lands on the title, so the popup opens without a focus ring on any one control.
  const title = React.useRef<HTMLHeadingElement>(null);
  const url = `/api/orgs/${encodeURIComponent(org)}/credentials`;
  const go = (next: number) => {
    setOpen(undefined);
    setStep(next);
  };
  const connected = async (next: number) => {
    await refresh();
    go(next);
  };
  const connectedTo = (id: Choice) =>
    credentials.find(
      (entry) => entry.auth === id || (entry.kind === id && entry.auth === "api-key"),
    );
  const ready = covered(coverage.generate) && covered(coverage.evaluate);
  const heading = [
    {
      title: "Connect a Coding Plan",
      body: "Sign in with ChatGPT or Claude and SelfBench runs its agents on your plan. Runs count against your plan's usage limits.",
    },
    {
      title: "Choose Where Tasks Run",
      body: "Every task builds and runs in a sandbox on your own account.",
    },
    canManage
      ? {
          title: ready ? "You're Set" : "Almost There",
          body: ready
            ? "Connect a repository, generate a batch of tasks from its merged pull requests, then run models against the tasks you accept."
            : "Here is what still needs a connection.",
        }
      : {
          title: "Setup Needs an Admin",
          body: `Only admins can connect credentials. Ask an admin of ${org} to connect a coding plan and a sandbox.`,
        },
  ][step];
  return (
    <Dialog
      initialFocus={title}
      onDismiss={onClose}
      size="large"
      aria-labelledby="setup-title"
      aria-describedby="setup-description"
    >
      <div className="flex items-center gap-4 px-5 pt-5 sm:px-7 sm:pt-6">
        {canManage && (
          <ol className="flex flex-1 gap-1.5" aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((index) => (
              <li
                key={index}
                className={cn(
                  "h-1 flex-1",
                  index < step ? "bg-foreground" : index === step ? "bg-brand" : "bg-border",
                )}
              />
            ))}
          </ol>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close"
          className="-mr-2 ml-auto"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="px-5 pt-4 pb-6 sm:px-7">
        <h2
          id="setup-title"
          ref={title}
          tabIndex={-1}
          className="text-2xl leading-8 font-semibold tracking-tight outline-none!"
        >
          {heading.title}
        </h2>
        <p id="setup-description" className="mt-2 max-w-md text-sm text-muted-foreground">
          {heading.body}
        </p>
        <div className="mt-6">
          {step === 0 && (
            <Choices
              items={plans}
              open={open}
              connectedTo={connectedTo}
              onToggle={setOpen}
              render={(id) =>
                id === "codex-login" ? (
                  <CodexSignIn
                    org={org}
                    name="Codex"
                    autoStart
                    onActiveChange={() => undefined}
                    onDone={() => connected(1)}
                  />
                ) : (
                  <ClaudeSignIn
                    org={org}
                    name="Claude"
                    autoStart
                    onActiveChange={() => undefined}
                    onDone={() => connected(1)}
                  />
                )
              }
            />
          )}
          {step === 1 && (
            <Choices
              items={sandboxes}
              open={open}
              connectedTo={connectedTo}
              onToggle={setOpen}
              render={(id) => (
                <SandboxForm
                  kind={id as "modal" | "e2b"}
                  onSave={async (draft: CredentialDraft) => {
                    await evaluationRequest(url, draft);
                    await connected(2);
                  }}
                />
              )}
            />
          )}
          {step === 2 && <Status coverage={coverage} />}
          {step < 2 && (
            <p className="mt-4 text-sm text-muted-foreground">
              {step === 0 ? "Have an API key instead? " : "Using Vercel or Daytona? "}
              <Link
                to="/settings/credentials"
                onClick={onClose}
                className="font-semibold text-foreground underline underline-offset-4"
              >
                Add It in Credentials
              </Link>
            </p>
          )}
        </div>
      </div>
      <footer className="flex items-center gap-2 border-t border-border bg-card px-5 py-4 sm:px-7">
        {canManage && step > 0 && (
          <Button variant="ghost" onClick={() => go(step - 1)}>
            Back
          </Button>
        )}
        <div className="ml-auto flex gap-2" key={step}>
          {step === 2 ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <Button
              variant={(step === 0 ? hasModel : hasSandbox) ? "primary" : "ghost"}
              onClick={() => go(step + 1)}
            >
              {(step === 0 ? hasModel : hasSandbox) ? "Continue" : "Skip for Now"}
            </Button>
          )}
        </div>
      </footer>
    </Dialog>
  );
}
