import type { ArtifactStore } from "../../artifacts.js";
import { PiEventFeed } from "../../pi-event-feed.js";
import type { SandboxRunOptions } from "../../sandbox/index.js";

/** Capture Pi's native stdout events; publish immutable, bounded snapshots for the UI. */
export async function withAgentFeed<T>(
  store: ArtifactStore,
  prefix: string,
  secrets: readonly string[],
  run: (onOutput: NonNullable<SandboxRunOptions["onOutput"]>) => Promise<T>,
): Promise<T> {
  const feed = new PiEventFeed(secrets);
  let sequence = 0;
  let previous = "";
  let pending: Promise<void> | undefined;
  const flush = () => {
    if (pending) return pending;
    const snapshot = JSON.stringify(feed.events());
    if (snapshot === previous || snapshot === "[]") return Promise.resolve();
    pending = store
      .put(
        `${prefix}/live/${String(sequence).padStart(8, "0")}.json`,
        Buffer.from(
          JSON.stringify({ events: JSON.parse(snapshot), capturedAt: new Date().toISOString() }),
        ),
        "application/json",
      )
      .then(
        () => {
          previous = snapshot;
          sequence += 1;
        },
        () => {
          // Observation failures must not fail generation; retry this snapshot on the next tick.
        },
      )
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const timer = setInterval(() => void flush(), 2000);
  timer.unref();
  try {
    return await run((stream, chunk) => {
      if (stream === "stdout") feed.push(chunk);
    });
  } finally {
    clearInterval(timer);
    await pending;
    await flush();
  }
}
