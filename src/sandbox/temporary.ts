import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTemporaryDirectory<T>(
  prefix: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
