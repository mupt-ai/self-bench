import { ArrowDown, ArrowUp } from "lucide-react";
import React from "react";
import { GROUP_SLUG, GROUP_SLUG_MAX } from "../../../../src/public/paths";
import { slugOf } from "../../../../src/public/release-groups";
import { plural } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Tick } from "../releases/SettingsPicker";
import { Button, controlStyles, fieldStyles, Input, Notice, SearchInput } from "../ui";
import { matchesQuery } from "../word-search";
import { type GroupInput, type GroupList, type GroupView, groupRequest, groupsUrl } from "./api";

/**
 * Creates or edits a repository group: its name, its address, and which of the workspace's
 * connected repositories it evaluates together, in the order its pages list them.
 */
export function GroupDialog({
  org,
  group,
  repositories,
  onSaved,
  onClose,
}: {
  org: string;
  /** The group to edit; a new one without it. */
  group?: GroupView;
  repositories: GroupList["repositories"];
  onSaved(group: GroupView): void;
  onClose(): void;
}) {
  const nameField = React.useRef<HTMLInputElement>(null);
  const idBase = React.useId();
  const [name, setName] = React.useState(group?.name ?? "");
  const [slug, setSlug] = React.useState(group?.slug ?? "");
  // A new group's address follows its name until the address is typed in.
  const [slugEdited, setSlugEdited] = React.useState(group !== undefined);
  const [description, setDescription] = React.useState(group?.description ?? "");
  const [chosen, setChosen] = React.useState<number[]>(
    group?.repositories.map((repository) => repository.id) ?? [],
  );
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  // A member disconnected since stays listed while the group holds it, so it can be removed.
  const listed: { id: number; fullName: string; tasks?: number }[] = [
    ...repositories,
    ...(group?.repositories ?? [])
      .filter((member) => !member.connected)
      .map((member) => ({ id: member.id, fullName: member.fullName })),
  ];
  const visible = listed.filter((entry) => matchesQuery(entry.fullName, query));
  const tasks = chosen.reduce(
    (sum, id) => sum + (listed.find((entry) => entry.id === id)?.tasks ?? 0),
    0,
  );
  const slugValid = GROUP_SLUG.test(slug) && slug.length <= GROUP_SLUG_MAX;
  const ready = name.trim().length > 0 && slugValid && chosen.length >= 2;
  const toggle = (id: number, on: boolean) =>
    setChosen((current) =>
      on ? [...current.filter((each) => each !== id), id] : current.filter((each) => each !== id),
    );
  const move = (index: number, by: -1 | 1) =>
    setChosen((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) next.splice(index + by, 0, moved);
      return next;
    });
  const nameOf = (id: number) => listed.find((entry) => entry.id === id)?.fullName ?? String(id);

  const save = async () => {
    setBusy(true);
    setError("");
    const body: GroupInput = { name: name.trim(), slug, description, repositoryIds: chosen };
    try {
      const saved = await groupRequest<{ group: GroupView }>(
        groupsUrl(org, group?.slug),
        group ? { method: "PUT", body } : { method: "POST", body },
      );
      onSaved(saved.group);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the group");
      setBusy(false);
    }
  };

  return (
    <Dialog
      initialFocus={nameField}
      onDismiss={onClose}
      busy={busy}
      size="large"
      aria-labelledby={`${idBase}-title`}
    >
      <DialogHeader
        title={group ? "Edit Group" : "New Repository Group"}
        titleId={`${idBase}-title`}
        description="Evaluate several repositories together, as one dataset of all their approved tasks."
        onClose={onClose}
        busy={busy}
      />
      <DialogBody>
        <label className={fieldStyles} htmlFor={`${idBase}-name`}>
          Name
          <Input
            id={`${idBase}-name`}
            ref={nameField}
            value={name}
            maxLength={80}
            placeholder="Python Web Frameworks"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(slugOf(event.target.value));
            }}
          />
        </label>
        <label className={fieldStyles} htmlFor={`${idBase}-slug`}>
          Address
          <Input
            id={`${idBase}-slug`}
            value={slug}
            maxLength={GROUP_SLUG_MAX}
            disabled={busy}
            className="font-mono"
            aria-invalid={slug.length > 0 && !slugValid}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value.toLowerCase());
            }}
          />
          <span className="font-normal text-muted-foreground">
            {slug.length > 0 && !slugValid
              ? "Use lowercase letters, digits, and single hyphens."
              : `/groups/${slug || "…"}`}
          </span>
        </label>
        <label className={fieldStyles} htmlFor={`${idBase}-description`}>
          Description
          <textarea
            id={`${idBase}-description`}
            value={description}
            maxLength={300}
            rows={2}
            disabled={busy}
            placeholder="Optional. What these repositories have in common."
            className={`${controlStyles} h-auto py-2`}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-semibold">Repositories</legend>
          {listed.length < 2 ? (
            <Notice>
              A group needs at least two connected repositories. Connect another first.
            </Notice>
          ) : (
            <>
              <SearchInput
                placeholder="Search Repositories"
                aria-label="Search Repositories"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="panel max-h-64 divide-y divide-border overflow-auto">
                {visible.map((entry) => {
                  const id = `${idBase}-repo-${entry.id}`;
                  return (
                    <label
                      key={entry.id}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/60"
                    >
                      <Tick
                        id={id}
                        checked={chosen.includes(entry.id)}
                        disabled={busy}
                        onChange={(on) => toggle(entry.id, on)}
                      />
                      <span className="min-w-0 flex-1 font-mono break-words">{entry.fullName}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {entry.tasks === undefined
                          ? "Disconnected"
                          : `${plural(entry.tasks, "approved task")}`}
                      </span>
                    </label>
                  );
                })}
                {visible.length === 0 && (
                  <p className="px-4 py-3 text-sm text-muted-foreground">No repositories match.</p>
                )}
              </div>
            </>
          )}
        </fieldset>
        {chosen.length > 0 && (
          <section aria-label="Order" className="grid gap-2">
            <h3 className="text-sm font-semibold">Order</h3>
            <ol className="panel divide-y divide-border">
              {chosen.map((id, index) => (
                <li key={id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                  <span className="w-5 text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 font-mono break-words">{nameOf(id)}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${nameOf(id)} Up`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${nameOf(id)} Down`}
                    disabled={busy || index === chosen.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ol>
          </section>
        )}
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {chosen.length < 2
            ? "Choose at least two repositories."
            : `${plural(tasks, "approved task")} from ${chosen.length} repositories.`}
        </p>
        {error && <Notice>{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !ready} onClick={save}>
          {busy ? "Saving…" : group ? "Save Group" : "Create Group"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
