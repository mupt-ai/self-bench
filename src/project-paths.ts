import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  const root = parse(directory).root;
  while (directory !== root) {
    if (existsSync(join(directory, "package.json"))) {
      return directory;
    }
    directory = dirname(directory);
  }
  throw new Error(`could not find package.json above ${fileURLToPath(moduleUrl)}`);
}
