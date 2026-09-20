/**
 * Activities that spawn a local `harbor run` process (Harbor gates and solver trials) poll a
 * sibling queue with its own, memory-bounded slot count, so cheap sandbox-driving activities
 * keep every ordinary slot. Derived, not configured: the pair must always be deployed together.
 */
export function harborTaskQueue(taskQueue: string): string {
  return `${taskQueue}-harbor`;
}
