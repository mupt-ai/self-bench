import { expect, test } from "bun:test";
import { checkSessionExpired, SESSION_EXPIRED } from "./session-expired";

test("notifies the site to discard signed-in state only on 401", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget();
  let notifications = 0;
  target.addEventListener(SESSION_EXPIRED, () => {
    notifications += 1;
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  try {
    for (const status of [200, 403, 429, 500]) checkSessionExpired({ status });
    expect(notifications).toBe(0);
    checkSessionExpired({ status: 401 });
    expect(notifications).toBe(1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
