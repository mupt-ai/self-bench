import { beforeEach, expect, test } from "bun:test";
import { followJourney, journeyFrom, startJourney } from "./home-view";

beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as unknown as Storage;
});

test("a trip continues through in-app steps within the repository", () => {
  startJourney("home", "vercel/next.js");
  followJourney("run-a", "vercel/next.js", "home");
  followJourney("run-b", "vercel/next.js", "run-a");
  expect(journeyFrom("run-a", "vercel/next.js")).toBe("home");
  expect(journeyFrom("run-b", "vercel/next.js")).toBe("home");
});

test("a direct visit to the same repository does not join the trip", () => {
  startJourney("home", "vercel/next.js");
  followJourney("run-a", "vercel/next.js", "home");
  followJourney("pasted", "vercel/next.js", undefined);
  expect(journeyFrom("pasted", "vercel/next.js")).toBeUndefined();
  // Reloading a page of the trip keeps its history entry, and so the trip.
  followJourney("run-a", "vercel/next.js", undefined);
  expect(journeyFrom("run-a", "vercel/next.js")).toBe("home");
});
