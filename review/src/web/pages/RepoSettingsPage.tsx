import React from "react";
import { useParams } from "react-router";
import { AGENT_MINUTES } from "../../../../src/contracts/index";
import { type ConnectedRepo, fetchConnectedRepo, updateRepo } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, fieldStyles, Input, Notice, PageContent, PageHeader } from "../ui";

export function RepoSettingsPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`Settings · ${fullName} · SelfBench`);
  return (
    <PageContent>
      <PageHeader title="Settings" />
      <AgentLimit key={`${org.login}/${fullName}`} org={org.login} fullName={fullName} />
    </PageContent>
  );
}

function AgentLimit({ org, fullName }: { org: string; fullName: string }) {
  const [repo, setRepo] = React.useState<ConnectedRepo>();
  const [minutes, setMinutes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    fetchConnectedRepo(org, fullName).then(
      (found) => {
        if (disposed) return;
        setRepo(found);
        setMinutes(String(found.agentMinutes));
      },
      (cause: Error) => {
        if (!disposed) setError(`Could not load settings: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [org, fullName]);
  const value = Number(minutes);
  const changed = repo !== undefined && value !== repo.agentMinutes;
  return (
    <form
      className="grid max-w-md gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !changed) return;
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          const updated = await updateRepo(org, fullName, { agentMinutes: value });
          setRepo(updated);
          setMinutes(String(updated.agentMinutes));
          setSaved(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className={fieldStyles} htmlFor="agent-minutes">
        Agent Time Limit (Minutes)
        <Input
          id="agent-minutes"
          type="number"
          inputMode="numeric"
          min={AGENT_MINUTES.min}
          max={AGENT_MINUTES.max}
          step={1}
          required
          disabled={!repo || busy}
          value={minutes}
          onChange={(event) => {
            setMinutes(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <p className="text-sm leading-6 text-muted-foreground">
        How long a model may work on each task before its trial is stopped, from {AGENT_MINUTES.min}{" "}
        to {AGENT_MINUTES.max} minutes. Allow for this repository's test suite: agents run it as
        they work. Runs already started keep the limit they started with.
      </p>
      {error && <Notice>{error}</Notice>}
      {saved && (
        <Notice tone="success">Saved. New runs give each task {repo?.agentMinutes} minutes.</Notice>
      )}
      <div>
        <Button type="submit" variant="primary" size="small" disabled={!changed || busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
