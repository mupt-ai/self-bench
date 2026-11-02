import { useState } from "react";
import { useParams } from "react-router";
import { mostAccurate } from "../../../../src/public/release-groups";
import { Avatar } from "../components/Avatar";
import { ModelTable } from "../components/ModelTable";
import { ResultsChart } from "../components/ResultsChart";
import type { PublicGroup, PublicGroupMember } from "../contract";
import { pageBody, revealGroup } from "../effects/marks";
import { ago, percent, publisherName, settingLabel } from "../format";
import { PANEL } from "../frame";
import { AdaptiveTable, type Column } from "../mobile/AdaptiveTable";
import { APP_URL } from "../PublicLayout";
import { groupTitle } from "../seo";
import { useSource } from "../source-context";
import { useLoad } from "../use-load";
import { useTitle } from "../use-title";

/**
 * A repository group's release: several repositories evaluated together. Its chart and table
 * score each setting over every member's tasks; the Repositories table shows how the setting
 * under the pointer (or each member's own best) did on each one.
 * The server writes the same headings for readers that run no scripts (src/api/site-group.ts).
 */
export function GroupPage() {
  const { publisher = "", slug = "" } = useParams();
  const source = useSource();
  const state = useLoad(`${publisher}/${slug}`, () => source.getGroup(publisher, slug));
  const group = state.status === "ready" ? state.value : undefined;
  useTitle(groupTitle(group?.name ?? slug));
  if (state.status === "loading") return <p className="text-muted-foreground">Loading…</p>;
  if (!group) return <NoGroup />;
  return <Group key={`${group.publisher.login}/${group.slug}`} group={group} />;
}

function Group({ group }: { group: PublicGroup }) {
  // The chart's pointer and vendor chips mark the same settings in the table, and the table
  // row under the pointer lights up its point, as on a repository page.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string> | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  const shown = activeId ?? rowId;
  const repositories = group.members.length;
  return (
    <article className="flex flex-col gap-8" {...pageBody}>
      <header className="flex flex-col gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere">
          {group.name}
        </h1>
        {group.description && (
          <p className="max-w-3xl text-muted-foreground">{group.description}</p>
        )}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="flex items-center gap-1.5">
            <Avatar src={group.publisher.avatarUrl} size={16} />
            Run by <strong className="font-medium">{publisherName(group.publisher)}</strong>
          </span>
          <span className="text-muted-foreground">· Released {ago(group.updatedAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">
            {repositories} {repositories === 1 ? "repository" : "repositories"}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{group.tasks} tasks</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{group.settings.length} settings</span>
        </p>
      </header>

      {group.settings.length > 0 ? (
        <>
          <section {...revealGroup} className="flex min-w-0 flex-col gap-3">
            <h2 className="text-base font-medium">Model Tradeoffs</h2>
            <div className={`p-2 ${PANEL}`}>
              <ResultsChart
                settings={group.settings}
                onActiveChange={setActiveId}
                onHighlightChange={setHighlighted}
                selectedId={rowId}
              />
            </div>
          </section>
          <section {...revealGroup} className="flex min-w-0 flex-col gap-3">
            <h2 className="text-sm font-medium">All Settings</h2>
            <p className="text-sm text-muted-foreground">
              Each setting scored over every repository's tasks together.
            </p>
            <ModelTable
              settings={group.settings}
              activeId={shown}
              highlighted={highlighted}
              onRowHover={setRowId}
            />
          </section>
        </>
      ) : (
        <p className="text-muted-foreground">This release has no settings.</p>
      )}

      <section {...revealGroup} className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Repositories</h2>
        <Members group={group} shownId={shown} />
      </section>
    </article>
  );
}

/**
 * Each member, with the accuracy there of the setting under the pointer, or else of the
 * member's own most accurate shared setting.
 */
function Members({ group, shownId }: { group: PublicGroup; shownId: string | null }) {
  const shown = group.settings.find((setting) => setting.id === shownId);
  const columns: Column<PublicGroupMember>[] = [
    {
      header: "Repository",
      role: "title",
      cell: (member) => (
        // A member need not be released on its own, so it links to its repository.
        <a
          href={`https://github.com/${member.repository.fullName}`}
          target="_blank"
          rel="noreferrer"
          className="hit relative flex min-w-0 items-center gap-2 font-mono font-medium wrap-anywhere hover:underline"
        >
          <Avatar src={member.repository.ownerAvatarUrl} size={16} />
          {member.repository.fullName}
        </a>
      ),
    },
    {
      header: "Tasks",
      role: "metric",
      className: "w-24",
      cell: (member) => <span className="font-mono tabular-nums">{member.tasks}</span>,
    },
    {
      header: shown ? `${settingLabel(shown, group.settings)} Accuracy` : "Most Accurate Here",
      role: "metric",
      className: "w-72",
      cell: (member) => {
        if (shown) {
          const score = member.scores[shown.id];
          return (
            <span className="font-mono tabular-nums">{score ? percent(score.accuracy) : "—"}</span>
          );
        }
        const best = mostAccurate(group, member);
        if (!best) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate">{best.label}</span>
            <span className="font-mono tabular-nums">{percent(best.accuracy)}</span>
          </span>
        );
      },
    },
  ];
  return (
    <AdaptiveTable
      columns={columns}
      rows={group.members}
      rowKey={(member) => String(member.repository.id)}
    />
  );
}

function NoGroup() {
  return (
    <section
      {...pageBody}
      className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center"
    >
      <h1 className="text-2xl font-semibold">Group Not Found</h1>
      <p className="text-muted-foreground">Nothing is released for this group.</p>
      <a
        href={APP_URL}
        className="hit relative border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background"
      >
        Run SelfBench on It
      </a>
    </section>
  );
}
