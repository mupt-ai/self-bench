import { ArrowUpRight, Check } from "lucide-react";
import React from "react";
import type { ClaudeLoginStatus } from "../../../../src/harnesses/claude-code/login";
import { Skeleton } from "../LoadingSkeleton";
import { Button, buttonStyles, fieldStyles, Input } from "../ui";
import { evaluationRequest } from "./api";

export function ClaudeSignIn({
  org,
  name,
  onActiveChange,
  onDone,
}: {
  org: string;
  name: string;
  onActiveChange(active: boolean): void;
  onDone(): Promise<void>;
}) {
  const url = `/api/orgs/${encodeURIComponent(org)}/credentials/claude-login`;
  const [session, setSession] = React.useState<ClaudeLoginStatus>();
  const [starting, setStarting] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const attempt = React.useRef<string>(undefined);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (attempt.current)
        void evaluationRequest(`${url}/${attempt.current}/cancel`, {}).catch(() => undefined);
    };
  }, [url]);
  const start = async () => {
    setSession(undefined);
    setStarting(true);
    setCode("");
    setError("");
    onActiveChange(true);
    try {
      const next = await evaluationRequest<ClaudeLoginStatus>(url, { name: name.trim() });
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
  const connect = async () => {
    if (!session || connecting || !code.trim()) return;
    setConnecting(true);
    setError("");
    try {
      const next = await evaluationRequest<ClaudeLoginStatus>(`${url}/${session.id}/complete`, {
        code: code.trim(),
      });
      if (!alive.current) return;
      attempt.current = undefined;
      setSession(next);
      onActiveChange(false);
      void onDone();
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "Could not finish sign-in. Try again.");
    } finally {
      if (alive.current) setConnecting(false);
    }
  };
  if (session?.status === "saved")
    return (
      <div
        className="flex flex-wrap items-center gap-3 border border-success/30 bg-success/[0.06] p-4"
        role="status"
      >
        <Check className="text-success" size={18} aria-hidden="true" />
        <h3 className="flex-1 text-sm font-semibold">Claude Connected</h3>
        <Button type="button" variant="primary" onClick={() => void onDone()}>
          Done
        </Button>
      </div>
    );
  return (
    <div className="space-y-4">
      {!session && !starting ? (
        <Button
          type="button"
          className="w-full"
          variant="primary"
          disabled={!name.trim()}
          onClick={() => void start()}
        >
          Sign In with Claude
          <ArrowUpRight size={15} aria-hidden="true" />
        </Button>
      ) : starting ? (
        <div role="status" aria-label="Preparing Sign-In" className="panel space-y-4 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <span className="sr-only">Preparing your sign-in link…</span>
        </div>
      ) : (
        <div className="panel space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
            Approve on Anthropic, then paste the code it shows.
          </p>
          <a
            className={`${buttonStyles.primary} w-full`}
            href={session?.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Continue on Anthropic
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <label className={fieldStyles} htmlFor="claude-code">
            Authorization Code
            <div className="flex gap-2">
              <Input
                id="claude-code"
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
                className="min-w-0 flex-1 font-mono"
                value={code}
                disabled={connecting}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void connect();
                }}
              />
              <Button
                type="button"
                disabled={connecting || !code.trim()}
                onClick={() => void connect()}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </label>
        </div>
      )}
      {error && (
        <div role="alert" className="text-sm leading-6 text-destructive">
          <p>{error}</p>
          {session && (
            <Button type="button" variant="ghost" className="mt-2" onClick={() => void start()}>
              Start Again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
