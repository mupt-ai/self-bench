import { expect, test } from "bun:test";
import { clientWentAway } from "../src/api/http.js";

const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

test("a reset before the response started is an upstream failure worth reporting", () => {
  expect(clientWentAway(reset)).toBe(false);
});

test("a reset while writing the response, or an aborted upload, is the client leaving", () => {
  expect(clientWentAway(reset, true)).toBe(true);
  expect(clientWentAway(new Error("aborted"))).toBe(true);
});
