import type { StripeConfig } from "./config.js";
import type { BillingStore } from "./store.js";
import { sendMeterEvent } from "./stripe.js";

export interface BillingDispatcher {
  wake(): void;
  close(): Promise<void>;
}

/**
 * Delivers the durable outbox from the API process. Generation only commits usage and outbox
 * rows; it never waits on or calls Stripe.
 */
export function startBillingDispatcher(
  store: BillingStore,
  config: StripeConfig,
  options: { fetchImpl?: typeof fetch; intervalMs?: number } = {},
): BillingDispatcher {
  let closed = false;
  let active: Promise<void> | undefined;
  const drain = async () => {
    for (;;) {
      const event = await store.claimDelivery();
      if (!event) return;
      try {
        await sendMeterEvent(
          config,
          {
            eventName: event.eventName,
            customerId: event.customerId,
            value: event.value,
            identifier: event.identifier,
            timestamp: event.createdAt,
          },
          { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
        );
        await store.delivered(event.id, event.attempts);
      } catch (error) {
        await store.failed(event.id, event.attempts, error);
      }
    }
  };
  const wake = () => {
    if (closed || active) return;
    active = drain().finally(() => {
      active = undefined;
    });
  };
  const timer = setInterval(wake, options.intervalMs ?? 10_000);
  timer.unref();
  wake();
  return {
    wake,
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
