import { ArrowUpRight, Check, Copy } from "lucide-react";
import React from "react";
import type { CodexLoginStatus } from "../../../../src/evaluation/codex-login";
import { Skeleton } from "../LoadingSkeleton";
import { Button, buttonStyles } from "../ui";
import { evaluationRequest } from "./api";

export function CodexSignIn({
  org,
  name,
  onActiveChange,
  onSavingChange,
  onDone,
}: {
  org: string;
  name: string;
  onActiveChange(active: boolean): void;
  onSavingChange(saving: boolean): void;
  onDone(): Promise<void>;
}) {
  const url = `/api/orgs/${encodeURIComponent(org)}/credentials/codex-login`;
  const [session, setSession] = React.useState<CodexLoginStatus>();
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [copyHint, setCopyHint] = React.useState("");
  const attempt = React.useRef<string>(undefined);
  const generation = React.useRef(0);
  const alive = React.useRef(true);
  const completed = React.useRef(onDone);
  completed.current = onDone;
  const code = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      if (attempt.current)
        void evaluationRequest(`${url}/${attempt.current}/cancel`, {}).catch(() => undefined);
    };
  }, [url]);
  const sessionId = session?.id;
  React.useEffect(() => {
    if (!sessionId || error) return;
    let disposed = false;
    const current = generation.current;
    const stale = () => disposed || current !== generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await evaluationRequest<CodexLoginStatus>(`${url}/${sessionId}`);
        if (stale()) return;
        if (next.status === "ready") {
          setSession({ ...next, status: "saving" });
          onSavingChange(true);
          const credential = await evaluationRequest<NonNullable<CodexLoginStatus["credential"]>>(
            `${url}/${sessionId}/complete`,
            {},
          );
          if (!stale()) {
            setSession({ ...next, status: "saved", credential });
            onSavingChange(false);
            onActiveChange(false);
            void completed.current();
          }
          return;
        }
        setSession(next);
        if (next.status === "failed" || next.status === "saved") {
          onActiveChange(false);
          if (next.status === "saved") void completed.current();
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!stale()) {
          onSavingChange(false);
          setError(cause instanceof Error ? cause.message : "Could not check sign-in. Try again.");
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, error, url, onActiveChange, onSavingChange]);
  const start = async () => {
    generation.current += 1;
    setSession(undefined);
    setStarting(true);
    setError("");
    setCopied(false);
    setCopyHint("");
    onActiveChange(true);
    try {
      const next = await evaluationRequest<CodexLoginStatus>(url, { name: name.trim() });
      if (!alive.current) {
        void evaluationRequest(`${url}/${next.id}/cancel`, {}).catch(() => undefined);
        return;
      }
      attempt.current = next.id;
      setSession(next);
    } catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : "Could not start sign-in");
        onActiveChange(false);
      }
    } finally {
      if (alive.current) setStarting(false);
    }
  };
  if (session?.status === "saved")
    return (
      <div
        className="flex flex-wrap items-center gap-3 border border-brand/25 bg-brand/5 p-4"
        role="status"
      >
        <Check className="text-brand" size={18} aria-hidden="true" />
        <h3 className="flex-1 text-sm font-medium">Codex Connected</h3>
        <Button type="button" variant="primary" onClick={() => void onDone()}>
          Done
        </Button>
      </div>
    );
  return (
    <div className="space-y-4">
      {!session && !starting ? (
        <div>
          <p className="text-sm leading-6 text-muted-foreground">
            Use your ChatGPT plan for Codex runs.
          </p>
          <Button
            type="button"
            className="mt-3 w-full"
            variant="primary"
            disabled={!name.trim()}
            onClick={() => void start()}
          >
            Sign In with ChatGPT
            <ArrowUpRight size={15} aria-hidden="true" />
          </Button>
        </div>
      ) : starting || session?.status === "starting" ? (
        <div
          role="status"
          aria-label="Preparing Sign-In"
          className="space-y-4 border border-border bg-background p-4"
        >
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-9 w-full" />
          <span className="sr-only">Preparing your sign-in code…</span>
        </div>
      ) : session?.status === "failed" ? (
        <div role="alert" className="border border-destructive/30 p-4">
          <p className="text-sm leading-6 text-destructive">{session.error}</p>
          <Button type="button" className="mt-4" onClick={() => void start()}>
            Start Again
          </Button>
        </div>
      ) : (
        <div className="border border-border bg-background p-4">
          <p className="mb-3 text-sm text-muted-foreground">Enter this code on OpenAI.</p>
          <div className="flex border border-input bg-card">
            <input
              ref={code}
              aria-label="One-Time Code"
              readOnly
              value={session?.instructions?.userCode ?? ""}
              onFocus={(event) => event.target.select()}
              className="min-w-0 flex-1 bg-transparent p-3 text-center font-mono text-xl tracking-[0.15em] text-brand outline-none"
            />
            <button
              type="button"
              aria-label={copied ? "Code Copied" : "Copy Code"}
              title={copied ? "Code Copied" : "Copy Code"}
              className="border-l border-border px-4 text-muted-foreground hover:text-brand"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(session?.instructions?.userCode ?? "");
                  setCopied(true);
                } catch {
                  code.current?.focus();
                  code.current?.select();
                  setCopyHint("Copy the selected code to continue.");
                }
              }}
            >
              {copied ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
            </button>
          </div>
          {copyHint && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {copyHint}
            </p>
          )}
          <a
            className={`${buttonStyles.primary} mt-4 w-full`}
            href={session?.instructions?.verificationUrl}
            target="_blank"
            rel="noreferrer"
          >
            Continue on OpenAI
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <p
            className="mt-5 flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground"
            role="status"
          >
            <span
              className="size-1.5 animate-pulse bg-brand motion-reduce:animate-none"
              aria-hidden="true"
            />
            {session?.status === "saving" ? "Saving…" : "Waiting for approval…"}
          </p>
        </div>
      )}
      {error && (
        <div role="alert" className="text-sm leading-6 text-destructive">
          <p>{error}</p>
          {session && (
            <div className="mt-2 flex gap-2">
              <Button type="button" onClick={() => setError("")}>
                Retry
              </Button>
              <Button type="button" variant="ghost" onClick={() => void start()}>
                Start Again
              </Button>
            </div>
          )}
        </div>
      )}
      <details className="text-xs leading-5 text-muted-foreground">
        <summary className="w-fit cursor-pointer hover:text-foreground">Sign-In Help</summary>
        <p className="mt-2">
          Enable device code login in your ChatGPT security settings. Your subscription limits
          apply.
        </p>
      </details>
    </div>
  );
}
