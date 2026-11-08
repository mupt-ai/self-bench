import type { ReactNode } from "react";
import type { PublicPublisher } from "../contract";
import { flightTo, revealFade } from "../effects/marks";
import { ago, publisherName } from "../format";
import { Avatar } from "./Avatar";

/**
 * A results page's title block: a repository's, an eval's, or a group's. Its mark, heading,
 * badge, and description are where a card's parts land when it opens the page (ResultCard,
 * effects/page-reveal.ts), and where they leave from on the way back; the line under them fades
 * in whole. The page draws it from its card before its data is in, so it needs no data.
 */
export function ResultHead({
  avatar,
  title,
  monoTitle,
  badge,
  aside,
  description,
  publisher,
  releasedAt,
  facts,
  endorsed = false,
}: {
  /** Its mark, 32px. */
  avatar: ReactNode;
  /** The page's one h1, as the page text the server writes has it (src/api/site-body.ts). */
  title: ReactNode;
  /** Identifiers (`owner/name`) are set in mono; a group's own name is not. */
  monoTitle: boolean;
  badge?: ReactNode;
  /** Controls at the end of the title line, such as the layout toggle. */
  aside?: ReactNode;
  description?: string;
  publisher: PublicPublisher;
  releasedAt: string;
  /** Counts after the release date, each set in mono: "42 tasks", "4 settings". */
  facts: string[];
  endorsed?: boolean;
}) {
  return (
    <header className="flex flex-col gap-3" data-morph="title">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex shrink-0" {...flightTo("avatar")}>
          {avatar}
        </span>
        <h1
          className={`min-w-0 text-2xl ${monoTitle ? "font-mono font-medium" : "font-semibold tracking-tight wrap-anywhere"}`}
          {...flightTo("name")}
        >
          {title}
        </h1>
        {badge !== undefined && (
          <span
            className="flex items-center gap-1 font-mono text-sm text-muted-foreground"
            {...flightTo("stars")}
          >
            {badge}
          </span>
        )}
        {aside !== undefined && (
          <span className="ml-auto self-center" data-morph="toggle">
            {aside}
          </span>
        )}
      </div>
      {description && (
        <p className="line-clamp-2 max-w-3xl text-muted-foreground" {...flightTo("description")}>
          {description}
        </p>
      )}
      {/* Fades in whole when the page is revealed after a card click, rather than assembling. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" {...revealFade}>
        <span className="flex items-center gap-1.5">
          <Avatar src={publisher.avatarUrl} size={16} />
          Run by <strong className="font-medium">{publisherName(publisher)}</strong>
        </span>
        <span className="text-muted-foreground">· Released {ago(releasedAt)}</span>
        {facts.map((fact) => (
          <span key={fact} className="contents">
            <span className="text-muted-foreground">·</span>
            <span className="font-mono">{fact}</span>
          </span>
        ))}
        {endorsed && (
          <span className="border border-border px-1.5 py-0.5 text-xs">
            Endorsed by Maintainers
          </span>
        )}
      </p>
    </header>
  );
}
