import React from "react";
import { useParams } from "react-router";
import { AGENT_MINUTES } from "../../../../src/contracts/agent-limit";
import { requestJson } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Input, Notice, PageContent, PageHeader } from "../ui";

type Result = { tone: "success" | "error"; text: string; retry?: boolean };

export function RepoSettingsPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  useDocumentTitle(`Settings · ${owner}/${name} · SelfBench`);
  const path = `/api/orgs/${encodeURIComponent(org.login)}/repos/${owner}/${name}`;
  return <AgentLimit key={path} path={path} />;
}

/** The repository's agent time limit, read on open and saved with the card's Save. */
function AgentLimit({ path }: { path: string }) {
  const [saved, setSaved] = React.useState<number>();
  const [minutes, setMinutes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<Result>();
  const [attempt, setAttempt] = React.useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reads the limit again
  React.useEffect(() => {
    let live = true;
    requestJson<{ repo: { agentMinutes: number } }>(path).then(
      ({ repo }) => {
        if (!live) return;
        setSaved(repo.agentMinutes);
        setMinutes(String(repo.agentMinutes));
        setResult(undefined);
      },
      (cause: Error) => live && setResult({ tone: "error", text: cause.message, retry: true }),
    );
    return () => {
      live = false;
    };
  }, [path, attempt]);
  const value = Number(minutes);
  const valid =
    minutes !== "" &&
    Number.isInteger(value) &&
    value >= AGENT_MINUTES.min &&
    value <= AGENT_MINUTES.max;
  // Before the current limit has loaded, any valid value can still be saved.
  const changed = value !== saved;
  return (
    <PageContent>
      <PageHeader title="Settings" description="Choose how evaluations of this repository run." />
      {result && (
        <Notice tone={result.tone} className="mb-5">
          {result.text}
          {result.retry && (
            <Button size="small" onClick={() => setAttempt((count) => count + 1)}>
              Try Again
            </Button>
          )}
        </Notice>
      )}
      <form
        className="panel"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || !changed || busy) return;
          setBusy(true);
          setResult(undefined);
          try {
            await requestJson(path, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentMinutes: value }),
            });
            setSaved(value);
            setResult({ tone: "success", text: "Saved. New runs use this limit." });
          } catch (cause) {
            setResult({
              tone: "error",
              text: cause instanceof Error ? cause.message : "Could not save the limit",
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-5 p-6 sm:grid-cols-[minmax(0,1fr)_13rem] sm:items-start sm:gap-8">
          <div>
            <h2 className="text-base leading-7 font-semibold">Agent Time Limit</h2>
            <p className="mt-1 max-w-[56ch] text-sm leading-6 text-muted-foreground">
              How long a model may work on each task before it is stopped and graded. Leave room for
              the repository's test suite.
            </p>
          </div>
          <div className="grid gap-2">
            <label htmlFor="agent-minutes" className="flex">
              <span className="sr-only">Agent Time Limit (Minutes)</span>
              <Input
                id="agent-minutes"
                type="number"
                min={AGENT_MINUTES.min}
                max={AGENT_MINUTES.max}
                required
                value={minutes}
                onChange={(event) => {
                  setMinutes(event.target.value);
                  // A notice about the last save no longer describes what the field holds.
                  if (result?.tone === "success") setResult(undefined);
                }}
                className="min-w-0 flex-1 text-right font-mono tabular-nums"
              />
              <span className="flex shrink-0 items-center border border-l-0 border-input bg-muted px-3 text-sm text-muted-foreground">
                Minutes
              </span>
            </label>
            <p className="text-sm text-muted-foreground sm:text-right">
              {AGENT_MINUTES.min} to {AGENT_MINUTES.max} minutes
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-6 py-3">
          <p className="text-sm text-muted-foreground">Past runs keep the limit they ran with.</p>
          <Button type="submit" variant="primary" disabled={!valid || !changed || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </PageContent>
  );
}
