import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { loadMemory, useLoad } from "./use-load";

test("the memory keeps the most recently used answers, up to its limit", () => {
  const memory = loadMemory<string>(2);
  memory.set("a", "A");
  memory.set("b", "B");
  // Reading "a" makes it the most recent, so "b" is the one to go.
  expect(memory.get("a")).toBe("A");
  memory.set("c", "C");
  expect(memory.get("b")).toBeUndefined();
  expect(memory.get("a")).toBe("A");
  expect(memory.get("c")).toBe("C");
  // An empty answer (nothing released) is not remembered.
  memory.set("a", undefined as unknown as string);
  expect(memory.get("a")).toBeUndefined();
});

function Shown({ memory }: { memory: ReturnType<typeof loadMemory<string>> }) {
  const load = useLoad("vercel/next.js", () => new Promise<string>(() => {}), undefined, memory);
  return <p>{load.status === "ready" ? load.value : load.status}</p>;
}

test("a remembered answer is shown from the first frame; otherwise the page loads", () => {
  const memory = loadMemory<string>(50);
  expect(renderToStaticMarkup(<Shown memory={memory} />)).toBe("<p>loading</p>");
  memory.set("vercel/next.js", "remembered");
  expect(renderToStaticMarkup(<Shown memory={memory} />)).toBe("<p>remembered</p>");
});
