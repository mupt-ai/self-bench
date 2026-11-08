import type { PublicGroup, PublicGroupCard, PublicRepoPage, PublicRepoSummary } from "./contract";
import type { PublicSource } from "./source";
import { loadMemory } from "./use-load";

/**
 * Repository pages read during the visit, so coming back to one draws it at once, from the
 * first frame, while it is checked in the background. The latest 50 are kept.
 */
export const visitedPages = loadMemory<PublicRepoPage | undefined>(50);

/** A repository page's key, from its address: the repository, and the publisher if named. */
export const pageKey = (fullName: string, publisher?: string) => `${fullName}/${publisher ?? ""}`;

/** Reads started before their page opened, until the page takes them or they land. */
const started = new Map<string, Promise<PublicRepoPage | undefined>>();
/** The card each page was last opened from: enough to draw its title before its data is in. */
const cards = new Map<string, PublicRepoSummary>();

/**
 * Starts reading a card's page as the card is pressed or hovered, before it is clicked, so the
 * page usually has its data by the time its title lands, and remembers the card, so the page can
 * draw its title at once. A page already kept, or being read, is not read again.
 */
export function preloadPage(source: PublicSource, card: PublicRepoSummary, byLine: boolean): void {
  const publisher = byLine ? card.publisher.login : undefined;
  const key = pageKey(card.repository.fullName, publisher);
  cards.set(key, card);
  if (started.has(key) || visitedPages.get(key) !== undefined) return;
  const [owner = "", name = ""] = card.repository.fullName.split("/");
  const read = publisher ? source.getLine(owner, name, publisher) : source.getRepo(owner, name);
  started.set(key, read);
  // A read its page never takes (the card was only hovered) still lands in memory.
  read.then(
    (page) => {
      visitedPages.set(key, page);
      started.delete(key);
    },
    () => started.delete(key),
  );
}

/** The read started for `key` before its page opened, taken once; undefined when none is. */
export function takeRead(key: string): Promise<PublicRepoPage | undefined> | undefined {
  const read = started.get(key);
  started.delete(key);
  return read;
}

/** The card the page at `key` was opened from, if it was. */
export function cardOf(key: string): PublicRepoSummary | undefined {
  return cards.get(key);
}

/** Group pages read during the visit, as `visitedPages` keeps repository pages. */
export const visitedGroups = loadMemory<PublicGroup | undefined>(50);

/** A group page's key, as its cards and its page name it: also its line (marks.ts). */
export const groupKey = (publisher: string, slug: string) => `groups/${publisher}/${slug}`;

const startedGroups = new Map<string, Promise<PublicGroup | undefined>>();
const groupCards = new Map<string, PublicGroupCard>();

/** Starts reading a group card's page as `preloadPage` does a repository's, and remembers the card. */
export function preloadGroup(source: PublicSource, card: PublicGroupCard): void {
  const key = groupKey(card.publisher.login, card.slug);
  groupCards.set(key, card);
  if (startedGroups.has(key) || visitedGroups.get(key) !== undefined) return;
  const read = source.getGroup(card.publisher.login, card.slug);
  startedGroups.set(key, read);
  read.then(
    (group) => {
      visitedGroups.set(key, group);
      startedGroups.delete(key);
    },
    () => startedGroups.delete(key),
  );
}

/** The read started for a group page before it opened, taken once. */
export function takeGroupRead(key: string): Promise<PublicGroup | undefined> | undefined {
  const read = startedGroups.get(key);
  startedGroups.delete(key);
  return read;
}

/** The card the group page at `key` was opened from, if it was. */
export function openedGroupCard(key: string): PublicGroupCard | undefined {
  return groupCards.get(key);
}
