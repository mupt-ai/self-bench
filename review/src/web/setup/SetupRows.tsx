import { Check } from "lucide-react";
import type React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { cn } from "../primitives/cn";
import { Button } from "../ui";
import { covered, type setupCoverage } from "./readiness";

export type Choice = "codex-login" | "claude-login" | "modal" | "e2b";

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
                <h3 className="text-[15px] leading-6 font-semibold">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.detail}</p>
              </div>
              {credential ? (
                <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-success">
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
        ? "Needs a ChatGPT sign-in or a model API key."
        : "Needs a Modal, E2B, or Vercel sandbox.",
    },
    {
      label: "Run Evaluations",
      ready: covered(coverage.evaluate),
      missing: !coverage.evaluate.model
        ? "Needs a ChatGPT or Claude sign-in, or a model API key."
        : "Needs a Modal, E2B, or Daytona sandbox.",
    },
  ];
  return (
    <ul className="panel divide-y divide-border">
      {rows.map((row) => (
        <li key={row.label} className="flex items-start gap-3 px-4 py-3.5">
          <span
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center border",
              row.ready
                ? "border-success/40 bg-success/[0.08] text-success"
                : "border-foreground/20",
            )}
          >
            {row.ready && <Check className="size-3.5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] leading-6 font-semibold">{row.label}</h3>
            <p className="text-sm text-muted-foreground">{row.ready ? "Ready." : row.missing}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
