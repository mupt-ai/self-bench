/**
 * One page transition at a time. Starting a transition cancels whatever the previous one is
 * still doing (a fire, an assembly, a flight), so a quick back right after opening a card never
 * leaves the old transition masking or covering the new page. Each running piece registers how
 * to undo itself and checks, each frame, that its transition is still the current one.
 */
let current = 0;
const undo = new Set<() => void>();

/**
 * A page opened by a transition holds back its body (everything below the title) until the
 * title has landed, so drawing it, the heaviest thing a page does, never competes with the
 * flight. The hold belongs to one transition.
 */
let held: number | undefined;
const CANCELLED_HOLD_MS = 150;
const holdWatchers = new Set<() => void>();
const release = () => {
  held = undefined;
  for (const watcher of [...holdWatchers]) watcher();
};

/** Cancels the running transition, if any, and starts a new one. */
export function newTransition(): number {
  for (const cancel of [...undo]) cancel();
  undo.clear();
  // A cancelled opening lets go of its page's body a moment later, once that page has had the
  // chance to leave: a quick back must never draw the page it is leaving.
  const was = held;
  if (was !== undefined) setTimeout(() => was === held && release(), CANCELLED_HOLD_MS);
  current += 1;
  return current;
}

/** Holds the opened page's body for the current transition; returns how to let it go. */
export function holdBody(): () => void {
  const run = current;
  held = run;
  for (const watcher of [...holdWatchers]) watcher();
  return () => held === run && release();
}

/** Whether a page's body is being held back. */
export function bodyHeld(): boolean {
  return held !== undefined;
}

/** Calls `watcher` whenever the hold starts or ends; returns how to stop. */
export function watchBodyHold(watcher: () => void): () => void {
  holdWatchers.add(watcher);
  return () => holdWatchers.delete(watcher);
}

/** Whether transition `run` is still the current one. */
export function stillRunning(run: number): boolean {
  return run === current;
}

/** The transition that pieces created now belong to. */
export function currentTransition(): number {
  return current;
}

/**
 * Registers how to undo a piece if its transition is cancelled. Returns a function to call
 * when the piece finishes on its own, so it is not undone later.
 */
export function onCancel(cancel: () => void): () => void {
  undo.add(cancel);
  return () => undo.delete(cancel);
}
