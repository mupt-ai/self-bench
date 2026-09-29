import { expect, test } from "bun:test";
import { sized } from "./Avatar";

test("GitHub avatars are fetched small, at one size for every spot", () => {
  expect(sized("https://avatars.githubusercontent.com/u/14985020?v=4")).toBe(
    "https://avatars.githubusercontent.com/u/14985020?v=4&s=64",
  );
  expect(sized("https://github.com/vercel.png")).toBe("https://github.com/vercel.png?size=64");
  // An address GitHub did not give, or not an address at all, is left alone.
  expect(sized("https://example.com/logo.png")).toBe("https://example.com/logo.png");
  expect(sized("not a url")).toBe("not a url");
});
