import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdaptiveTable, type Column } from "./AdaptiveTable";

interface Row {
  id: string;
  name: string;
  harness: string;
  level: string;
  score: string;
}

const rows: Row[] = [
  { id: "a", name: "Alpha", harness: "Codex", level: "High", score: "90%" },
  { id: "b", name: "Beta", harness: "Pi", level: "Low", score: "40%" },
];
const columns: Column<Row>[] = [
  { header: "Model", role: "title", cell: (row) => row.name },
  { header: "Harness", role: "detail", cell: (row) => row.harness },
  { header: "Reasoning", role: "detail", cell: (row) => row.level },
  { header: "Accuracy", role: "metric", cell: (row) => row.score },
];
const html = renderToStaticMarkup(
  <AdaptiveTable columns={columns} rows={rows} rowKey={(row) => row.id} />,
);
const [table = "", cards = ""] = html.split("<ul");

test("one column list renders both a table and cards, switched by the table's own width", () => {
  expect(html.startsWith('<div class="@container">')).toBe(true);
  expect(table).toContain("@min-[45rem]:block");
  expect(cards).toContain("@min-[45rem]:hidden");
});

test("the table keeps every column, in order", () => {
  const headers = [...table.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
  expect(headers).toEqual(["Model", "Harness", "Reasoning", "Accuracy"]);
  expect(table.match(/<tr/g)).toHaveLength(3);
});

test("a card places each column by its role", () => {
  const [first = ""] = cards.split("</li>");
  // The title heads the card, the details share one line, the metric sits under its header.
  expect(first.indexOf("Alpha")).toBeLessThan(first.indexOf("Codex"));
  expect(first).toMatch(/<p[^>]*>.*Codex.*·.*High.*<\/p>/);
  expect(first).toMatch(/<dt[^>]*>Accuracy<\/dt><dd>90%<\/dd>/);
  // Details keep their header for screen readers.
  expect(first).toContain('<span class="sr-only">Harness: </span>');
  expect(cards.match(/<li/g)).toHaveLength(2);
});
