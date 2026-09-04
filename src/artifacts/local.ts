import { randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ArtifactRef } from "../contracts.js";
import { sha256 } from "../hash.js";
import {
  copyWithDigest,
  fileDigest,
  hasCode,
  isNotFound,
  verifiedArtifactReadStream,
  verifyArtifact,
} from "./common.js";
import type { ArtifactEntry, ArtifactStore } from "./types.js";

export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef> {
    const path = this.#pathFor(key);
    await this.#prepareParent(path);
    const digest = sha256(value);
    try {
      await writeFile(path, value, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await this.#assertRegularFile(path);
      const existing = await fileDigest(path).catch(() => undefined);
      if (!existing || existing.sha256 !== digest || existing.sizeBytes !== value.byteLength) {
        throw error;
      }
      await chmod(path, 0o600);
    }
    return {
      uri: pathToFileURL(path).href,
      sha256: digest,
      sizeBytes: value.byteLength,
      contentType,
    };
  }

  async putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef> {
    const path = this.#pathFor(key);
    await this.#prepareParent(path);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      const digest = await copyWithDigest(sourcePath, temporaryPath);
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        await this.#assertRegularFile(path);
        const existing = await fileDigest(path).catch(() => undefined);
        if (
          !existing ||
          existing.sha256 !== digest.sha256 ||
          existing.sizeBytes !== digest.sizeBytes
        ) {
          throw new Error(
            `artifact already exists with different contents: ${pathToFileURL(path).href}`,
          );
        }
        await chmod(path, 0o600);
      }
      return {
        uri: pathToFileURL(path).href,
        ...digest,
        contentType,
      };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async get(reference: ArtifactRef): Promise<Uint8Array> {
    const url = new URL(reference.uri);
    if (url.protocol !== "file:") {
      throw new Error(`local artifact store cannot read ${reference.uri}`);
    }
    const path = resolve(decodeURIComponent(url.pathname));
    this.#assertInsideRoot(path);
    await this.#assertRegularFile(path);
    const value = await readFile(path);
    verifyArtifact(reference, value);
    return value;
  }

  async openRead(reference: ArtifactRef): Promise<Readable> {
    const path = this.#pathForReference(reference);
    await this.#assertRegularFile(path);
    if ((await stat(path)).size !== reference.sizeBytes) {
      throw new Error(`artifact integrity check failed: ${reference.uri}`);
    }
    return verifiedArtifactReadStream(reference, createReadStream(path));
  }

  async getByKey(key: string): Promise<Uint8Array | undefined> {
    try {
      const path = this.#pathFor(key);
      await this.#assertRegularFile(path);
      return await readFile(path);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async openReadByKey(
    key: string,
    options: { readonly start?: number } = {},
  ): Promise<Readable | undefined> {
    const path = this.#pathFor(key);
    try {
      await this.#assertRegularFile(path);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    return createReadStream(path, options.start ? { start: options.start } : {});
  }

  async list(prefix: string): Promise<ArtifactEntry[]> {
    const root = this.#pathFor(prefix);
    const entries: ArtifactEntry[] = [];
    const visit = async (directory: string, relativePrefix: string): Promise<void> => {
      let names: Dirent[];
      try {
        names = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const entry of names) {
        if (entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        const key = `${relativePrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await visit(path, key);
        } else if (entry.isFile()) {
          const stats = await stat(path);
          entries.push({ key, sizeBytes: stats.size, updatedAt: stats.mtime.toISOString() });
        }
      }
    };
    await visit(root, prefix);
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }

  #pathForReference(reference: ArtifactRef): string {
    const url = new URL(reference.uri);
    if (url.protocol !== "file:") {
      throw new Error(`local artifact store cannot read ${reference.uri}`);
    }
    const path = resolve(decodeURIComponent(url.pathname));
    this.#assertInsideRoot(path);
    return path;
  }

  #pathFor(key: string): string {
    if (
      !key ||
      key.startsWith("/") ||
      key.includes("\\") ||
      key.includes("\0") ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`unsafe artifact key: ${key}`);
    }
    const path = resolve(this.#root, key);
    this.#assertInsideRoot(path);
    return path;
  }

  async #prepareParent(path: string): Promise<void> {
    const parent = dirname(path);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const fromRoot = relative(this.#root, parent);
    let current = this.#root;
    for (const part of ["", ...fromRoot.split(sep).filter(Boolean)]) {
      current = part ? resolve(current, part) : current;
      if (part) {
        await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
          if (!hasCode(error, "EEXIST")) throw error;
        });
      }
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`artifact path contains a non-directory component: ${current}`);
      }
      await chmod(current, 0o700);
    }
  }

  async #assertRegularFile(path: string): Promise<void> {
    const fromRoot = relative(this.#root, dirname(path));
    let current = this.#root;
    for (const part of ["", ...fromRoot.split(sep).filter(Boolean)]) {
      current = part ? resolve(current, part) : current;
      const directory = await lstat(current);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error(`artifact path contains a non-directory component: ${current}`);
      }
    }
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`artifact path is not a regular file: ${path}`);
    }
  }

  #assertInsideRoot(path: string): void {
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error(`artifact path escapes root: ${path}`);
    }
  }
}
