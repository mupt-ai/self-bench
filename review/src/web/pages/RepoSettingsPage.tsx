import React from "react";
import { useParams } from "react-router";
import { AGENT_MINUTES } from "../../../../src/contracts/agent-limit";
import { requestJson } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, fieldStyles, Input, Notice, PageContent, PageHeader } from "../ui";

export function RepoSettingsPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  useDocumentTitle(`Settings · ${owner}/${name} · SelfBench`);
  const path = `/api/orgs/${encodeURIComponent(org.login)}/repos/${owner}/${name}`;
  const [minutes, setMinutes] = React.useState("");
  const [status, setStatus] = React.useState("");
  React.useEffect(() => {
    requestJson<{ repo: { agentMinutes: number } }>(path).then(
      ({ repo }) => setMinutes(String(repo.agentMinutes)),
      (cause: Error) => setStatus(cause.message),
    );
  }, [path]);
  return (
    <PageContent>
      <PageHeader title="Settings" />
      <form
        className="grid max-w-md gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          requestJson(path, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentMinutes: Number(minutes) }),
          }).then(
            () => setStatus("Saved. New runs use this limit."),
            (cause: Error) => setStatus(cause.message),
          );
        }}
      >
        <label className={fieldStyles} htmlFor="agent-minutes">
          Agent Time Limit (Minutes)
          <Input
            id="agent-minutes"
            type="number"
            min={AGENT_MINUTES.min}
            max={AGENT_MINUTES.max}
            required
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          How long a model may work on each task. Leave room for the repository's test suite.
        </p>
        {status && <Notice tone="info">{status}</Notice>}
        <Button type="submit" variant="primary" size="small" className="justify-self-start">
          Save
        </Button>
      </form>
    </PageContent>
  );
}
