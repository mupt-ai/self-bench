import React from "react";
import { useParams } from "react-router";
import { AGENT_MINUTES } from "../../../../src/contracts/agent-limit";
import { requestJson } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, controlStyles, Notice, PageContent, PageHeader } from "../ui";

export function RepoSettingsPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  useDocumentTitle(`Settings · ${owner}/${name} · SelfBench`);
  const path = `/api/orgs/${encodeURIComponent(org.login)}/repos/${owner}/${name}`;
  const [saved, setSaved] = React.useState<number>();
  const [minutes, setMinutes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ tone: "success" | "error"; text: string }>();
  React.useEffect(() => {
    requestJson<{ repo: { agentMinutes: number } }>(path).then(
      ({ repo }) => {
        setSaved(repo.agentMinutes);
        setMinutes(String(repo.agentMinutes));
      },
      (cause: Error) => setResult({ tone: "error", text: cause.message }),
    );
  }, [path]);
  const value = Number(minutes);
  const valid = Number.isInteger(value) && value >= AGENT_MINUTES.min && value <= AGENT_MINUTES.max;
  const changed = saved !== undefined && value !== saved;
  return (
    <PageContent>
      <PageHeader title="Settings" description="Choose how evaluations of this repository run." />
      {result && (
        <Notice tone={result.tone} className="mb-5">
          {result.text}
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
              <input
                id="agent-minutes"
                type="number"
                min={AGENT_MINUTES.min}
                max={AGENT_MINUTES.max}
                required
                value={minutes}
                disabled={saved === undefined || busy}
                onChange={(event) => setMinutes(event.target.value)}
                className={`${controlStyles} min-w-0 flex-1 text-right font-mono tabular-nums`}
              />
              <span className="flex shrink-0 items-center border border-l-0 border-input bg-muted px-3 text-sm text-muted-foreground">
                minutes
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
