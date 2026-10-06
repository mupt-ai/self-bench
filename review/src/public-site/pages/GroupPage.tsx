import { useState } from "react";
import { useParams } from "react-router";
import { leadingSetting } from "../../../../src/public/directory";
import { Avatar } from "../components/Avatar";
import { OpenTask } from "../components/OpenTask";
import { SettingsResults } from "../components/SettingsResults";
import { TaskList } from "../components/TaskList";
import type { PublicGroupRelease } from "../contract";
import { pageBody, revealGroup } from "../effects/marks";
import { ago, dollars, percent, publisherName, settingLabel } from "../format";
import { AdaptiveTable } from "../mobile/AdaptiveTable";
import { APP_URL } from "../PublicLayout";
import { groupTitle } from "../seo";
import { useSource } from "../source-context";
import { useLoad } from "../use-load";
import { useTitle } from "../use-title";

/**
 * A group's page, `/groups/<slug>`: one benchmark over every task of several repositories, laid
 * out as a repository's page is, with each repository's share of the setting in focus below.
 */
export function GroupPage() {
  const { slug = "" } = useParams();
  const source = useSource();
  const state = useLoad(`groups/${slug}`, () => source.getGroup(slug));
  const release = state.status === "ready" ? state.value : undefined;
  useTitle(groupTitle(release?.group.name ?? slug));
  if (state.status === "error" || (state.status === "ready" && !release))
    return <NoResults slug={slug} />;
  if (!release) return <p className="text-muted-foreground">Loading…</p>;
  return <Results release={release} />;
}

function Results({ release }: { release: PublicGroupRelease }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string> | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  const { group, publisher } = release;
  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{group.name}</h1>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {group.members.map((member) => (
            <li key={member.id} className="flex items-center gap-1.5">
              <Avatar src={member.ownerAvatarUrl} size={16} />
              <a
                href={`https://github.com/${member.fullName}`}
                target="_blank"
                rel="noreferrer"
                className="hit relative font-mono hover:underline"
              >
                {member.fullName}
              </a>
            </li>
          ))}
        </ul>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="flex items-center gap-1.5">
            <Avatar src={publisher.avatarUrl} size={16} />
            Run by <strong className="font-medium">{publisherName(publisher)}</strong>
          </span>
          <span className="text-muted-foreground">· Released {ago(release.releasedAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{release.tasks} tasks</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{release.settings.length} settings</span>
        </p>
      </header>
      <SettingsResults
        releaseId={release.releaseId}
        settings={release.settings}
        side={false}
        activeId={activeId}
        rowId={rowId}
        highlighted={highlighted}
        onActiveChange={setActiveId}
        onHighlightChange={setHighlighted}
        onRowHover={setRowId}
      />
      <Breakdown release={release} focusId={activeId ?? rowId} />
      {release.tasksPublished && <TaskList release={release} />}
      {release.tasksPublished && <OpenTask release={release} />}
    </article>
  );
}

interface Share {
  fullName: string;
  tasks: number;
  accuracy: number;
  costPerTaskUsd: number;
}

/**
 * Each repository's share of one setting: the one the chart or table is on, else the most
 * accurate, as the page's description names it.
 */
function Breakdown({ release, focusId }: { release: PublicGroupRelease; focusId: string | null }) {
  const setting =
    release.settings.find((entry) => entry.id === focusId) ?? leadingSetting(release.settings);
  if (!setting) return null;
  const names = new Map(release.group.members.map((member) => [member.id, member.fullName]));
  const rows = release.breakdown.flatMap((share): Share[] => {
    const scored = share.settings.find((entry) => entry.id === setting.id);
    const fullName = names.get(share.repositoryId);
    return scored && fullName ? [{ fullName, tasks: share.tasks, ...scored }] : [];
  });
  return (
    <section className="flex flex-col gap-3" {...revealGroup}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">By Repository</h2>
        <p className="text-sm text-muted-foreground">
          {settingLabel(setting, release.settings)}, in each repository. Point at a setting to see
          its own.
        </p>
      </div>
      <AdaptiveTable<Share>
        rows={rows}
        rowKey={(row) => row.fullName}
        columns={[
          {
            header: "Repository",
            role: "title",
            cell: (row) => <span className="font-mono font-medium">{row.fullName}</span>,
          },
          { header: "Tasks", role: "metric", cell: (row) => row.tasks },
          { header: "Accuracy", role: "metric", cell: (row) => percent(row.accuracy) },
          { header: "Cost / Task", role: "metric", cell: (row) => dollars(row.costPerTaskUsd) },
        ]}
      />
    </section>
  );
}

function NoResults({ slug }: { slug: string }) {
  return (
    <section
      {...pageBody}
      className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center"
    >
      <h1 className="font-mono text-2xl font-medium">{slug}</h1>
      <p className="text-muted-foreground">Nothing is released for this group.</p>
      <a
        href={APP_URL}
        className="hit relative border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background"
      >
        Run SelfBench on Yours
      </a>
    </section>
  );
}
