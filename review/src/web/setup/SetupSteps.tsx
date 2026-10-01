import { Check, Minus } from "lucide-react";
import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { credentialAccess, credentialProvider } from "../evaluation/credential-presentation";
import { cn } from "../primitives/cn";
import { Button } from "../ui";
import { type Coverage, covered } from "./readiness";

/** The subscription sign-ins, and what each one lets an organization run. */
export const subscriptions = [
  {
    auth: "codex-login",
    kind: "openai",
    title: "Codex",
    plan: "Uses your ChatGPT plan.",
    action: "Sign In with ChatGPT",
    unlocks: [
      { yes: true, text: "Generates tasks with GPT models" },
      { yes: true, text: "Evaluates OpenAI models in Codex" },
    ],
  },
  {
    auth: "claude-login",
    kind: "anthropic",
    title: "Claude Code",
    plan: "Uses your Claude plan.",
    action: "Sign In with Claude",
    unlocks: [
      { yes: true, text: "Evaluates Claude models in Claude Code" },
      { yes: false, text: "Does not generate tasks; add ChatGPT or an API key for that" },
    ],
  },
] as const;

export function SubscriptionCard({
  subscription,
  connected,
  onSignIn,
}: {
  subscription: (typeof subscriptions)[number];
  connected: CredentialInfo[];
  /** Absent for members, who cannot add credentials. */
  onSignIn?: () => void;
}) {
  return (
    <section
      aria-label={subscription.title}
      className="flex flex-col border border-border bg-background p-4"
    >
      <h3 className="text-base font-semibold">{subscription.title}</h3>
      <p className="text-sm text-muted-foreground">{subscription.plan}</p>
      <ul className="mt-3 flex-1 space-y-1.5 text-sm">
        {subscription.unlocks.map((unlock) => (
          <li key={unlock.text} className="flex items-start gap-2">
            {unlock.yes ? (
              <Check className="mt-1 size-4 shrink-0 text-success" aria-label="Yes" />
            ) : (
              <Minus className="mt-1 size-4 shrink-0 text-muted-foreground" aria-label="No" />
            )}
            <span className={unlock.yes ? "" : "text-muted-foreground"}>{unlock.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        {connected.length ? (
          <Connected credentials={connected} detail={false} />
        ) : (
          onSignIn && (
            <Button
              variant={subscription.auth === "codex-login" ? "primary" : "secondary"}
              className="w-full"
              onClick={onSignIn}
            >
              {subscription.action}
            </Button>
          )
        )}
      </div>
    </section>
  );
}

export function Step({
  number,
  done,
  title,
  description,
  children,
}: {
  number: number;
  done: boolean;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <li className="panel p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center border font-mono text-sm",
            done
              ? "border-success/40 bg-success/[0.08] text-success"
              : "border-foreground/20 text-foreground",
          )}
        >
          {done ? <Check className="size-4" aria-label="Done" /> : number}
        </span>
        <div className="min-w-0">
          <h2 className="text-base leading-7 font-semibold">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {/* Aligned under the title from small screens up; full width on phones. */}
      <div className="mt-4 sm:pl-11">{children}</div>
    </li>
  );
}

export function Connected({
  credentials,
  detail = true,
  className,
}: {
  credentials: CredentialInfo[];
  /** Name the provider and access, unless the surrounding card already says it. */
  detail?: boolean;
  className?: string;
}) {
  if (!credentials.length) return null;
  return (
    <p className={cn("flex items-start gap-2 text-sm", className)}>
      <Check className="mt-1 size-4 shrink-0 text-success" aria-hidden="true" />
      <span className="min-w-0">
        Connected:{" "}
        {credentials.map((entry, index) => (
          <React.Fragment key={entry.id}>
            {index > 0 && ", "}
            <span className="font-semibold">{entry.name}</span>
            {detail && (
              <span className="text-muted-foreground">
                {" "}
                ({credentialProvider(entry)} · {credentialAccess(entry)})
              </span>
            )}
          </React.Fragment>
        ))}
      </span>
    </p>
  );
}

export function Capability({
  label,
  coverage,
  missing,
}: {
  label: string;
  coverage: Coverage;
  missing: Record<keyof Coverage, string>;
}) {
  const ready = covered(coverage);
  const gaps = (["model", "sandbox"] as const).filter((part) => !coverage[part]);
  return (
    <div className="bg-card p-4">
      <dt className="flex items-center justify-between gap-3 text-sm font-semibold">
        {label}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-sm font-semibold",
            ready ? "text-success" : "text-muted-foreground",
          )}
        >
          <span aria-hidden="true" className={cn("size-2", ready ? "bg-success" : "bg-brand")} />
          {ready ? "Ready" : "Not Ready"}
        </span>
      </dt>
      <dd className="mt-1 text-sm text-muted-foreground">
        {ready ? "Everything it needs is connected." : gaps.map((part) => missing[part]).join(" ")}
      </dd>
    </div>
  );
}
