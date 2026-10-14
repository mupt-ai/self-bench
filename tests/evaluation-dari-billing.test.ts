import { expect, test } from "bun:test";
import { responseCost } from "../src/evaluation/dari/billing.js";

const id = "35fcb4c6-5902-40a7-adfe-e9289cab6855";
const request = (index: number) => JSON.stringify({ type: "request", index });
const price = (index: number, cost: unknown, requestId = id) =>
  JSON.stringify({ type: "cost", index, cost, requestId });

test("sum returned prices including failed requests before a successful retry", () => {
  const second = "35fcb4c6-5902-40a7-adfe-e9289cab6856";
  expect(
    responseCost([request(1), price(1, 0.02), request(2), price(2, 0.03, second)].join("\n")),
  ).toBe(0.05);
  expect(responseCost([request(1), price(1, 0)].join("\n"))).toBe(0);
  expect(responseCost([request(1), price(1, 0.02), price(1, 0.02)].join("\n"))).toBe(0.02);
});

test("unknown, missing, conflicting, duplicate and malformed prices are not partial bills", () => {
  for (const text of [
    "",
    request(1),
    price(1, 0),
    [request(1), price(1, null)].join("\n"),
    [request(1), price(1, 0.1), request(2)].join("\n"),
    [request(1), price(1, 0.1), price(1, 0.2)].join("\n"),
    [request(1), price(1, 0.1), request(2), price(2, 0.1)].join("\n"),
    [request(1), price(1, -1)].join("\n"),
    [request(1), price(1, "0.1")].join("\n"),
    [request(1), price(1, 0.1), "{broken"].join("\n"),
  ])
    expect(responseCost(text)).toBeUndefined();
});
