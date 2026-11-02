import { Layers } from "lucide-react";
import { Link } from "react-router";
import { groupHref } from "../../../../src/public/release-groups";
import type { PublicGroupCard } from "../contract";
import { ago, dollars, percent, pickLabel, publisherName } from "../format";
import { PANEL } from "../frame";
import { Avatar } from "./Avatar";

/**
 * A repository group on the home page: its name, its members, and its two picks over every
 * member's tasks. A plain card: it opens the group's page like any link.
 */
export function GroupCard({ card }: { card: PublicGroupCard }) {
  return (
    <Link
      to={groupHref(card.publisher.login, card.slug)}
      className={`group relative flex min-w-0 flex-col gap-3 px-4 pt-4 pb-2.5 transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_10px_24px_-8px_rgb(0_0_0/0.14)] focus-visible:border-foreground/40 ${PANEL}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold group-hover:underline">
          {card.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {card.repositories.length} repos
        </span>
      </div>
      <p className="line-clamp-2 min-h-10 font-mono text-xs leading-5 wrap-anywhere text-foreground/70">
        {card.repositories.join(" · ")}
      </p>
      <ul className="flex flex-col gap-1.5">
        {card.picks.map((pick) => (
          <li key={pick.setting.id} className="flex items-baseline gap-2 text-xs">
            <span className="w-24 shrink-0 text-foreground/70">{pickLabel(pick.roles)}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{pick.setting.model.label}</span>
            <span className="shrink-0 font-mono tabular-nums">
              {percent(pick.setting.accuracy)}
            </span>
            {/* Picks come from the frontier, which only priced settings join. */}
            <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
              {dollars(pick.setting.costPerTaskUsd)}
            </span>
          </li>
        ))}
        {card.picks.length === 0 && (
          <li className="text-xs text-muted-foreground">No setting shared by every repository.</li>
        )}
      </ul>
      <div className="-mx-4 mt-auto flex items-center gap-3 border-t border-border px-4 pt-2.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 max-w-1/2 items-center gap-1.5">
          <Avatar src={card.publisher.avatarUrl} size={14} />
          <span className="truncate font-semibold text-foreground/75">
            {publisherName(card.publisher)}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <span className="font-mono">{card.tasks} tasks</span>
          <span aria-hidden="true" className="mx-2 text-base leading-none">
            ·
          </span>
          <span>{ago(card.updatedAt)}</span>
        </span>
      </div>
    </Link>
  );
}
