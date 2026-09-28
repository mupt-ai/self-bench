import type { ActivityInterceptorsFactory } from "@temporalio/worker";

/**
 * Tracks how long a worker has been running no activities, so a job-style worker (the Harbor
 * pods on GKE) can stop itself instead of waiting to be killed by a scale-in.
 */
export function idleTracker(now: () => number = Date.now): {
  readonly interceptor: ActivityInterceptorsFactory;
  idleForMs(): number;
} {
  let running = 0;
  let idleSince = now();
  return {
    interceptor: () => ({
      inbound: {
        async execute(input, next) {
          running += 1;
          try {
            return await next(input);
          } finally {
            running -= 1;
            if (running === 0) idleSince = now();
          }
        },
      },
    }),
    idleForMs: () => (running > 0 ? 0 : now() - idleSince),
  };
}
