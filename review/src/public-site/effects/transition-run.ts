/**
 * One page transition at a time. Starting a transition cancels whatever the previous one is
 * still doing (a fire, an assembly, a flight), so a quick back right after opening a card never
 * leaves the old transition masking or covering the new page. Each running piece registers how
 * to undo itself and checks, each frame, that its transition is still the current one.
 */
let current = 0;
const undo = new Set<() => void>();

/** Cancels the running transition, if any, and starts a new one. */
export function newTransition(): number {
  for (const cancel of [...undo]) cancel();
  undo.clear();
  current += 1;
  return current;
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
