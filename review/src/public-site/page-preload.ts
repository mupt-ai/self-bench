import { resultsName } from "../../../src/public/paths";
import type { PublicGroup, PublicGroupCard, PublicRepoPage, PublicRepoSummary } from "./contract";
import type { PublicSource } from "./source";
import { type LoadMemory, loadMemory } from "./use-load";

/**
 * Pages read ahead from their cards, one kind of page each (repositories, groups): what a page
 * opened from a card reads and draws first.
 */
export interface Preloads<Card, Page> {
  /** Pages read during the visit, so coming back to one draws it at once; the latest 50. */
  visited: LoadMemory<Page | undefined>;
  /**
   * Starts reading a card's page as the card is pressed or hovered, before it is clicked, so the
   * page usually has its data by the time its title lands, and remembers the card, so the page
   * can draw its title at once. A page already kept, or being read, is not read again.
   */
  preload(key: string, card: Card, read: () => Promise<Page | undefined>): void;
  /** The read started for `key` before its page opened, taken once; undefined when none is. */
  take(key: string): Promise<Page | undefined> | undefined;
  /** The card the page at `key` was opened from, if it was. */
  card(key: string): Card | undefined;
}

function preloads<Card, Page>(): Preloads<Card, Page> {
  const visited = loadMemory<Page | undefined>(50);
  /** Reads started before their page opened, until the page takes them or they land. */
  const started = new Map<string, Promise<Page | undefined>>();
  const cards = new Map<string, Card>();
  return {
    visited,
    preload(key, card, read) {
      cards.set(key, card);
      if (started.has(key) || visited.get(key) !== undefined) return;
      const reading = read();
      started.set(key, reading);
      // A read its page never takes (the card was only hovered) still lands in memory.
      reading.then(
        (page) => {
          visited.set(key, page);
          started.delete(key);
        },
        () => started.delete(key),
      );
    },
    take(key) {
      const reading = started.get(key);
      started.delete(key);
      return reading;
    },
    card: (key) => cards.get(key),
  };
}

/** Repository (and eval) pages, keyed by `pageKey`. */
export const repoPages = preloads<PublicRepoSummary, PublicRepoPage>();
/** Group pages, keyed by `groupKey`. */
export const groupPages = preloads<PublicGroupCard, PublicGroup>();

/** A repository page's key, from its address: its `resultsName`, and the publisher if named. */
export const pageKey = (fullName: string, publisher?: string) => `${fullName}/${publisher ?? ""}`;

/** A group page's key, as its cards and its page name it: also its line (marks.ts). */
export const groupKey = (publisher: string, slug: string) => `groups/${publisher}/${slug}`;

/** Reads a repository card's page ahead: its default line, or the card's own with `byLine`. */
export function preloadPage(source: PublicSource, card: PublicRepoSummary, byLine: boolean): void {
  const publisher = byLine ? card.publisher.login : undefined;
  const name = resultsName(card);
  repoPages.preload(pageKey(name, publisher), card, () =>
    publisher ? source.getLine(name, publisher) : source.getRepo(name),
  );
}

/** Reads a group card's page ahead. */
export function preloadGroup(source: PublicSource, card: PublicGroupCard): void {
  groupPages.preload(groupKey(card.publisher.login, card.slug), card, () =>
    source.getGroup(card.publisher.login, card.slug),
  );
}
