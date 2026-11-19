import { Check, X } from "lucide-react";
import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { Dialog } from "../Dialog";
import { cn } from "../primitives/cn";
import { Button } from "../ui";
import { covered, type setupCoverage } from "./readiness";

export type Choice = "modal" | "e2b";

/** The setup popup's options for one step; the chosen one opens its connection flow in place. */
export function Choices({
  items,
  open,
  connectedTo,
  onToggle,
  render,
}: {
  items: readonly { id: Choice; title: string; detail: string }[];
  open?: Choice;
  connectedTo(id: Choice): CredentialInfo | undefined;
  onToggle(id: Choice | undefined): void;
  render(id: Choice): React.ReactNode;
}) {
  return (
    <ul className="panel divide-y divide-border">
      {items.map((item) => {
        const credential = connectedTo(item.id);
        const expanded = open === item.id;
        return (
          <li key={item.id}>
            <div className="flex items-center gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] leading-6 font-medium">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.detail}</p>
              </div>
              {credential ? (
                <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-success">
                  <Check className="size-4" aria-hidden="true" />
                  Connected
                </span>
              ) : (
                <Button
                  className="shrink-0"
                  variant={expanded ? "ghost" : "secondary"}
                  aria-expanded={expanded}
                  aria-label={expanded ? `Cancel ${item.title}` : `Connect ${item.title}`}
                  onClick={() => onToggle(expanded ? undefined : item.id)}
                >
                  {expanded ? "Cancel" : "Connect"}
                </Button>
              )}
            </div>
            {expanded && !credential && (
              <div className="border-t border-border bg-background px-4 py-4">
                {render(item.id)}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What the organization can run, and what each workflow still needs. */
export function Status({ coverage }: { coverage: ReturnType<typeof setupCoverage> }) {
  const rows = [
    {
      label: "Generate Tasks",
      ready: covered(coverage.generate),
      missing: !coverage.generate.model
        ? "Needs a model that can write tasks, such as a ChatGPT plan or an API key connected with Dari. Claude and Muse plans only run evaluations."
        : "Needs a Modal, E2B, or Vercel sandbox.",
    },
    {
      label: "Run Evaluations",
      ready: covered(coverage.evaluate),
      missing: !coverage.evaluate.model
        ? "Needs a plan or an API key, connected with Dari."
        : "Needs a Modal, E2B, or Daytona sandbox.",
    },
  ];
  return (
    <ul className="panel divide-y divide-border">
      {rows.map((row) => (
        <li key={row.label} className="flex items-center gap-3 px-4 py-3.5">
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-sm border",
              row.ready ? "border-success/40 bg-success/10 text-success" : "border-foreground/20",
            )}
          >
            {row.ready && <Check className="size-3.5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] leading-6 font-medium">{row.label}</h3>
            <p className="text-sm text-muted-foreground">{row.ready ? "Ready." : row.missing}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The setup popup before the org's credentials have loaded, or after loading them failed. */
export function SetupUnavailable({
  error,
  onRetry,
  onClose,
}: {
  error?: string;
  onRetry(): void;
  onClose(): void;
}) {
  const close = React.useRef<HTMLButtonElement>(null);
  return (
    <Dialog initialFocus={close} onDismiss={onClose} size="large" aria-label="Finish Setup">
      <div className="flex items-start gap-4 p-5 sm:p-7">
        <div className="min-w-0 flex-1" role={error ? "alert" : "status"}>
          <p className="text-sm text-muted-foreground">
            {error ? `Could not load credentials: ${error}` : "Loading credentials…"}
          </p>
          {error && (
            <Button className="mt-4" onClick={onRetry}>
              Try Again
            </Button>
          )}
        </div>
        <Button
          ref={close}
          size="icon"
          variant="ghost"
          aria-label="Close"
          className="-my-1 -mr-2 size-8 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </Dialog>
  );
}
