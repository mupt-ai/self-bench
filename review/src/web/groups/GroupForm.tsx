import React from "react";
import { type ConnectedRepo, fetchConnectedRepos } from "../api";
import { Button, fieldStyles, Input, Notice } from "../ui";

/** A group's name and members, chosen from the workspace's connected repositories. */
export function GroupForm({
  org,
  initial = { name: "", repos: [] },
  saveLabel,
  onSave,
  onCancel,
}: {
  org: string;
  initial?: { name: string; repos: string[] };
  saveLabel: string;
  onSave(draft: { name: string; repos: string[] }): Promise<void>;
  onCancel(): void;
}) {
  const [name, setName] = React.useState(initial.name);
  const [chosen, setChosen] = React.useState(() => new Set(initial.repos));
  const [connected, setConnected] = React.useState<ConnectedRepo[]>();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    fetchConnectedRepos(org).then(
      (repos) => {
        if (!disposed) setConnected(repos);
      },
      (cause) => {
        if (!disposed) setError(`Could not load repositories: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [org]);
  const toggle = (fullName: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(fullName)) next.add(fullName);
      return next;
    });
  return (
    <form
      className="panel mb-8 grid gap-4 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onSave({ name: name.trim(), repos: [...chosen] });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save the group");
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <Notice>{error}</Notice>}
      <label className={fieldStyles} htmlFor="group-name">
        Group Name
        <Input
          id="group-name"
          value={name}
          maxLength={80}
          placeholder="Next.js Apps"
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          required
        />
      </label>
      <fieldset className="grid gap-2" disabled={busy}>
        <legend className="mb-2 text-sm font-semibold">Repositories</legend>
        {connected?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Connect a repository first; a group holds connected repositories.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {connected?.map((repo) => (
            <label key={repo.fullName} className="flex min-w-0 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.has(repo.fullName)}
                onChange={() => toggle(repo.fullName)}
              />
              <span className="truncate font-mono text-xs">{repo.fullName}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {saveLabel}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
