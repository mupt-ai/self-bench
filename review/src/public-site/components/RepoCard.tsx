import { Star } from "lucide-react";
import { type CSSProperties, useRef } from "react";
import { Link, useNavigate } from "react-router";
import type { PublicRepoSummary } from "../contract";
import { flightFrom, repoCard } from "../effects/marks";
import { revealNavigate } from "../effects/page-reveal";
import {
  ago,
  cleanDescription,
  compactNumber,
  dollars,
  percent,
  pickLabel,
  publisherName,
} from "../format";
import { PANEL } from "../frame";
import { preloadPage } from "../page-preload";
import { useSource } from "../source-context";
import { Avatar } from "./Avatar";
import { CircledArrow } from "./card-marks";

/**
 * How long a mouse rests on a card before its page is read ahead: long enough that sweeping
 * across the grid reads nothing, short enough to beat the click.
 */
const HOVER_READ_MS = 80;

/** How many frontier settings the hover preview lists; more would not fit the card. */
const PREVIEW_LINES = ["first", "second", "third", "fourth", "fifth"] as const;
const PREVIEW_ROWS = PREVIEW_LINES.length;
/**
 * Text that types in on hover and is erased right to left on leave: the frontier caption and the
 * prompt beside it, side by side and in step. Each adds its own steps, one per character.
 */
const TYPED =
  "[clip-path:inset(0_100%_0_0)] transition-[clip-path] delay-0 duration-290 card-on:[clip-path:inset(0_0_0_0)] card-on:duration-200";
/**
 * The prompt beside the caption, typed in with it, underlined like a link: on each of its spans,
 * since an underline does not reach into inline blocks, and close under the text, inside the box
 * the typing clips to.
 */
const PROMPT = `${TYPED} underline decoration-1 underline-offset-2`;

/**
 * A uniform card. Every card has the same height: the description always takes two lines.
 * On hover or focus the body gives way to a preview of the frontier and the stars become an
 * arrow, all inside the card, so nothing overlaps its neighbours.
 */
export function RepoCard({
  card,
  byLine = false,
  onOpen,
}: {
  card: PublicRepoSummary;
  byLine?: boolean;
  /** Called with the card's element as it is opened, before navigating. */
  onOpen?: (element: HTMLElement) => void;
}) {
  const navigate = useNavigate();
  const source = useSource();
  // The page is read as the card is pressed (or rested on, or focused), not when it is clicked:
  // by the time its title has flown, its data is usually in.
  const readAhead = () => preloadPage(source, card, byLine);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const href = byLine
    ? `/${card.repository.fullName}/${card.publisher.login}`
    : `/${card.repository.fullName}`;
  return (
    <Link
      to={href}
      {...repoCard(card.repository.fullName, `${card.repository.fullName}/${card.publisher.login}`)}
      onClick={(event) => {
        onOpen?.(event.currentTarget);
        readAhead();
        revealNavigate(event, () => navigate(href));
      }}
      onPointerDown={readAhead}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") hover.current = setTimeout(readAhead, HOVER_READ_MS);
      }}
      onPointerLeave={() => clearTimeout(hover.current)}
      onFocus={readAhead}
      className={`group relative flex flex-col gap-3 px-4 pt-4 pb-2.5 transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_10px_24px_-8px_rgb(0_0_0/0.14)] focus-visible:border-foreground/40 ${PANEL}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex shrink-0" {...flightFrom("avatar")}>
          <Avatar src={card.repository.ownerAvatarUrl} size={24} />
        </span>
        <span className="flex min-w-0 flex-1">
          {/* The underline draws out from the middle on hover and retracts leftwards on leave. */}
          <span className="relative flex min-w-0">
            <span className="truncate font-mono text-sm font-medium" {...flightFrom("name")}>
              {card.repository.fullName}
            </span>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 -bottom-0.5 h-px origin-left scale-x-0 bg-foreground/70 transition-transform duration-200 ease-in card-on:origin-center card-on:scale-x-100 card-on:duration-250 card-on:ease-out"
            />
          </span>
        </span>
        <span className="relative flex h-5 shrink-0 items-center justify-end font-mono text-xs">
          {card.repository.stars !== undefined && (
            <span
              {...flightFrom("stars")}
              className="flex items-center gap-1 text-muted-foreground transition-opacity delay-100 duration-150 card-on:opacity-0 card-on:delay-0 card-on:duration-75"
            >
              <Star className="size-3 fill-current" aria-hidden="true" />
              {compactNumber(card.repository.stars)}
            </span>
          )}
          {/* Right-aligned with the end of the line, where the star count ends. */}
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center text-foreground">
            <CircledArrow />
          </span>
        </span>
      </div>
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] *:col-start-1 *:row-start-1">
        <div className="flex flex-col gap-3 transition-[opacity,translate] delay-300 duration-250 card-on:-translate-y-1 card-on:opacity-0 card-on:delay-0 card-on:duration-200">
          <p
            className="line-clamp-2 min-h-10 text-xs leading-5 text-foreground/70"
            {...flightFrom("description")}
          >
            {card.repository.description ? cleanDescription(card.repository.description) : ""}
          </p>
          <CardPicks picks={card.picks} />
          <div className="-mx-4 mt-auto flex items-center gap-3 border-t border-border px-4 pt-2.5 text-xs text-muted-foreground">
            <span className="flex min-w-0 max-w-1/2 items-center gap-1.5">
              <Avatar src={card.publisher.avatarUrl} size={14} />
              <span
                className="truncate font-semibold tracking-[0.015em] text-foreground/75"
                title={publisherName(card.publisher)}
              >
                {publisherName(card.publisher)}
              </span>
              {card.endorsed && (
                <span className="shrink-0 border border-border px-1">Endorsed</span>
              )}
            </span>
            <span className="ml-auto flex shrink-0 items-center">
              <span className="font-mono">{card.tasks} tasks</span>
              <span aria-hidden="true" className="mx-2 text-base leading-none">
                ·
              </span>
              <span>{ago(card.releasedAt)}</span>
            </span>
          </div>
        </div>
        <FrontierPreview card={card} />
      </div>
    </Link>
  );
}

/**
 * The card's two picks, one line each: what it is, model, accuracy, cost per task. A lone pick,
 * the cheapest and the most accurate at once, sits on the second line, where Most Accurate goes.
 */
export function CardPicks({ picks }: { picks: PublicRepoSummary["picks"] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {picks.length === 1 && (
        <li aria-hidden="true" className="text-xs">
          &nbsp;
        </li>
      )}
      {picks.map((pick) => (
        <li key={pick.setting.id} className="flex items-baseline gap-2 text-xs">
          <span className="w-24 shrink-0 text-foreground/70">{pickLabel(pick.roles)}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{pick.setting.model.label}</span>
          <span className="shrink-0 font-mono tabular-nums">{percent(pick.setting.accuracy)}</span>
          <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
            {dollars(pick.setting.costPerTaskUsd)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Five lines of settings: the frontier by accuracy, then the most accurate of the rest. A
 * release with fewer leaves faint rules in the spare lines so every card's preview has the same
 * shape. On hover the caption types in, with a
 * prompt to open the page for the chart typing in beside it, and the lines fade in one by one;
 * on leave the lines fade from the bottom up while the caption and prompt are erased right to
 * left, all finishing together before the card body returns.
 */
function FrontierPreview({ card }: { card: PublicRepoSummary }) {
  const frontier = [...card.frontier]
    .sort((left, right) => right.accuracy - left.accuracy)
    .slice(0, PREVIEW_ROWS);
  // A directory from before `others` (a page cached across a release) lists the frontier alone.
  const rows = [...frontier, ...(card.others ?? []).slice(0, PREVIEW_ROWS - frontier.length)];
  const timing = (index: number) =>
    ({
      "--in": `${120 + index * 45}ms`,
      "--out": `${(PREVIEW_ROWS - 1 - index) * 35}ms`,
    }) as CSSProperties;
  const line =
    "translate-y-1 opacity-0 transition-[opacity,translate] duration-150 [transition-delay:var(--out)] card-on:translate-y-0 card-on:opacity-100 card-on:duration-200 card-on:[transition-delay:var(--in)]";
  return (
    <div className="pointer-events-none flex flex-col gap-1.5 text-xs" aria-hidden="true">
      <div className="@container mb-0.5 flex items-baseline justify-between gap-3">
        {/* Erased over the same 290 ms the lines take to go: four 35 ms steps plus a 150 ms fade. */}
        <p className={`text-muted-foreground ${TYPED} ease-[steps(24)]`}>
          Results · {card.settings} settings tested
        </p>
        {/* In the brand's colour so it stands out; the long wording only where the line has room. */}
        <p className="shrink-0 font-semibold text-brand-foreground">
          <span className={`inline-block @min-[19rem]:hidden ${PROMPT} ease-[steps(13)]`}>
            See the Chart
          </span>
          <span className={`hidden @min-[19rem]:inline-block ${PROMPT} ease-[steps(24)]`}>
            See Chart &amp; All Settings
          </span>
        </p>
      </div>
      {PREVIEW_LINES.map((slot, index) => {
        const entry = rows[index];
        if (!entry)
          return (
            <p key={slot} className={`flex h-4 items-center ${line}`} style={timing(index)}>
              <span className="h-px w-full bg-foreground/10" />
            </p>
          );
        return (
          <p
            key={entry.id}
            className={`flex h-4 items-baseline gap-2 ${line}`}
            style={timing(index)}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{entry.model.label}</span>
            <span className="shrink-0 font-mono tabular-nums">{percent(entry.accuracy)}</span>
            <span className="w-14 text-right font-mono tabular-nums text-muted-foreground">
              {dollars(entry.costPerTaskUsd)}
            </span>
          </p>
        );
      })}
    </div>
  );
}
