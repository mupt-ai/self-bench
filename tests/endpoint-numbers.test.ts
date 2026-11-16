import { expect, test } from "bun:test";
import { dariRouterId } from "../src/db/credential-endpoints.js";
import { endpointNumber, publicIds } from "../src/public/endpoint-numbers.js";

test("endpoint numbers go to custom twins only, in key order", () => {
  const ids = publicIds([
    { key: '["m","b"]', id: "m", custom: true },
    { key: '["m","a"]', id: "m", custom: true },
    { key: '["n","a"]', id: "n", custom: true },
    { key: '["o"]', id: "o", custom: false },
  ]);
  expect([...ids.values()]).toEqual(["m|#2", "m|#1", "n", "o"]);
  expect(endpointNumber("m|#2")).toBe(2);
  expect(endpointNumber("n")).toBeUndefined();
});

test("an older release's all-digit fingerprint is not an endpoint number", () => {
  expect(endpointNumber("m|pi|custom|api-key|default|#12345678")).toBeUndefined();
  expect(endpointNumber("m|pi|custom|api-key|default|#2")).toBe(2);
});

test("a Dari credential's router id, none for the default router", () => {
  expect(dariRouterId(undefined)).toBeUndefined();
  expect(dariRouterId("https://routing.dari.dev/v1")).toBeUndefined();
  expect(dariRouterId("https://routing.dari.dev/rtr_abc/chat/completions")).toBe("rtr_abc");
});
