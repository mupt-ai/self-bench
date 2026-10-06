import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { passed, run } from "../evaluation/results-fixture";
import { GroupMatrixTable } from "./GroupMatrixTable";

test("the matrix shows each repository's rate and the group's average and pooled rows", () => {
  const html = renderToStaticMarkup(
    <GroupMatrixTable
      repos={[
        { fullName: "vercel/commerce", runs: [run("a", {}, [passed("cart")])] },
        {
          fullName: "dubinc/dub",
          runs: [run("b", {}, [passed("links"), { ...passed("domains"), rewards: { reward: 0 } }])],
        },
      ]}
    />,
  );
  const cells = [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) =>
    match[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  expect(cells).toEqual([
    "vercel/commerce",
    "100% 1 / 1 passed · $0.500 / task",
    "dubinc/dub",
    "50% 1 / 2 passed · $0.500 / task",
    "Average",
    "75% 2 repositories · $0.500 / task",
    "Pooled",
    "67% 2 / 3 passed",
  ]);
  expect(html).toContain("GPT-6");
});

test("a group evaluation with no results yet says so", () => {
  expect(
    renderToStaticMarkup(<GroupMatrixTable repos={[{ fullName: "a/b", runs: [] }]} />),
  ).toContain("No results yet.");
});
