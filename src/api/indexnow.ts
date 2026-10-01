import type { ServerResponse } from "node:http";

/**
 * IndexNow: telling search engines which pages changed as they change, instead of waiting for
 * them to read the sitemap again. One notification to the shared endpoint reaches every engine
 * that takes part (Bing, Yandex, Naver, Seznam and others; Google does not). The key proves the
 * notifications are the site's: it is served at /<key>.txt, so it is public by design, and
 * knowing it lets anyone do no more than ask for this site's own pages to be crawled.
 */
export const INDEXNOW_KEY = "c1cacf7c3f188342baf705d4020c771d";
export const INDEXNOW_KEY_PATH = `/${INDEXNOW_KEY}.txt`;

/** Answers the key's address, where engines look for it to trust the site's notifications. */
export function sendIndexNowKey(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=86400",
  });
  response.end(INDEXNOW_KEY);
}

const ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * How long a notification waits after a change: the CDN keeps a page 10 seconds (results-site.ts)
 * and the API servers re-read releases every 5, so a crawler sent at once could fetch the page
 * from before the change. Pages are never served past their lifetime, so after this they are new.
 */
const DELAY_MS = 30_000;

/** The most URLs one notification may carry. */
const MAX_URLS = 10_000;

export interface IndexNowOptions {
  /** The site the pages are on, whose host the key is served from. */
  siteUrl: string;
  fetchImpl?: typeof fetch;
  delayMs?: number;
  log?: (message: string) => void;
}

export function createIndexNow(options: IndexNowOptions) {
  const site = new URL(options.siteUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.warn;
  /** A failed notification costs nothing but a slower crawl, so it is logged and dropped. */
  const send = async (paths: readonly string[]) => {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: site.host,
          key: INDEXNOW_KEY,
          keyLocation: `${site.origin}${INDEXNOW_KEY_PATH}`,
          urlList: paths.map((path) => new URL(path, site).href),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // 202 means accepted while the key is checked, as on the first notification.
      if (!response.ok) log(`IndexNow refused a notification: ${response.status}`);
    } catch (error) {
      log(`IndexNow notification failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  /** Every page, in notifications of at most MAX_URLS each, one after another. */
  const sendAll = async (paths: readonly string[]) => {
    for (let start = 0; start < paths.length; start += MAX_URLS)
      await send(paths.slice(start, start + MAX_URLS));
  };
  /** The pages waiting to be notified, each once, and when they will have been. */
  let batch: { pages: Set<string>; sent: Promise<void> } | undefined;
  return {
    /**
     * Tells the engines that `paths` on the site changed, once the CDN's copies have expired.
     * Changes during that wait join the same notification, each page once, so a burst of
     * releases sends one notification rather than one each, and the home page appears once.
     */
    changed(paths: readonly string[]): Promise<void> {
      if (!batch) {
        const pages = new Set<string>();
        const sent = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            batch = undefined;
            sendAll([...pages]).then(resolve);
          }, options.delayMs ?? DELAY_MS);
          timer.unref?.();
        });
        batch = { pages, sent };
      }
      for (const path of paths) batch.pages.add(path);
      return batch.sent;
    },
  };
}
