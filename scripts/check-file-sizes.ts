import { Glob } from "bun";

const MAX_TYPESCRIPT_LINES = 300;
const roots = ["src", "tests", "review/src", "scripts"];
const oversized: Array<{ path: string; lines: number }> = [];

for (const root of roots) {
  const glob = new Glob(`${root}/**/*.{ts,tsx}`);
  for await (const path of glob.scan({ cwd: `${import.meta.dir}/..`, onlyFiles: true })) {
    const contents = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    const lines =
      contents === "" ? 0 : contents.split("\n").length - (contents.endsWith("\n") ? 1 : 0);
    if (lines > MAX_TYPESCRIPT_LINES) oversized.push({ path, lines });
  }
}

if (oversized.length > 0) {
  oversized.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  throw new Error(
    `TypeScript files may not exceed ${MAX_TYPESCRIPT_LINES} lines:\n${oversized
      .map(({ path, lines }) => `  ${lines} ${path}`)
      .join("\n")}`,
  );
}
