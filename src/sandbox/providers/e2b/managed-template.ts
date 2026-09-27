import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2B } from "e2b";
import type { E2BCredentials } from "../../../contracts/config/index.js";
import { type EncryptedRecordStore, RecordStoreError } from "../../../db/encrypted-records.js";
import { projectRoot } from "../../../lib/project-paths.js";
import { errorMessage } from "../../../lib/util.js";
import { buildSelfBenchE2BTemplate, type E2BTemplateBuildApi } from "./template-build.js";

/** The resources every SelfBench stage requests; E2B fixes them when the template is built. */
export const MANAGED_E2B_TEMPLATE_CPUS = 4;
export const MANAGED_E2B_TEMPLATE_MEMORY_MIB = 8192;
const MANAGED_E2B_TEMPLATE_NAME = "selfbench-runtime";
/** A build older than this without a ready record is presumed to have died with its worker. */
const STALE_BUILD_MS = 45 * 60_000;
const BUILD_WAIT_DEADLINE_MS = 60 * 60_000;
const BUILD_POLL_MS = 15_000;

const references = new Map<string, string>();

/**
 * The template the hosted site builds in the user's E2B account. Its tag is the hash of the
 * packaged Dockerfile.sandbox and the fixed resources, so a runtime change yields a new template
 * and an unchanged one is reused across releases.
 */
export function managedE2BTemplateReference(root = projectRoot(import.meta.url)): string {
  let reference = references.get(root);
  if (!reference) {
    const dockerfile = readFileSync(join(root, "Dockerfile.sandbox"));
    const digest = createHash("sha256")
      .update(dockerfile)
      .update(`\ncpus=${MANAGED_E2B_TEMPLATE_CPUS} memory=${MANAGED_E2B_TEMPLATE_MEMORY_MIB}\n`)
      .digest("hex")
      .slice(0, 16);
    reference = `${MANAGED_E2B_TEMPLATE_NAME}:${digest}`;
    references.set(root, reference);
  }
  return reference;
}

export function managedE2BTemplateRecordPath(credentialId: string, reference: string) {
  // "platform" is the managed account SelfBench itself owns; anything else must be a
  // real credential whose account the template is built (and locked) in.
  if (credentialId !== "platform")
    if (!/^[a-f0-9-]{36}$/.test(credentialId)) throw new Error("Invalid credential ID");
  return `e2b-templates/${credentialId}/${reference.replace(":", "/")}`;
}

type BuildRecord =
  | { status: "building"; startedAt: string }
  | { status: "ready"; templateId: string; buildId: string; builtAt: string }
  | { status: "failed"; failedAt: string };

interface ManagedE2BTemplateApi {
  exists(reference: string, signal?: AbortSignal): Promise<boolean>;
}

export interface EnsureManagedE2BTemplateOptions {
  readonly reference: string;
  readonly credentials: E2BCredentials;
  /** Org-scoped records: the build lock lives beside the credential that owns the template. */
  readonly records: EncryptedRecordStore;
  readonly credentialId: string;
  readonly projectRoot?: string;
  readonly api?: ManagedE2BTemplateApi;
  readonly buildApi?: E2BTemplateBuildApi;
  /** Called on every wait poll and build log so activities can heartbeat. */
  readonly onLog?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Make the managed template exist in the credential's E2B account, building it from the packaged
 * Dockerfile.sandbox when absent. A record in the encrypted store serialises builds of the same
 * template across workers; a waiter polls E2B rather than starting a second build.
 */
export async function ensureManagedE2BTemplate(
  options: EnsureManagedE2BTemplateOptions,
): Promise<void> {
  const { reference, records, signal } = options;
  const api = options.api ?? createManagedE2BTemplateApi(options.credentials);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const path = managedE2BTemplateRecordPath(options.credentialId, reference);
  signal?.throwIfAborted();
  if (await api.exists(reference, signal)) return;
  const deadline = now() + BUILD_WAIT_DEADLINE_MS;
  for (;;) {
    signal?.throwIfAborted();
    const existing = await records.read<BuildRecord>(path);
    const building =
      existing?.value.status === "building" &&
      now() - Date.parse(existing.value.startedAt) < STALE_BUILD_MS;
    if (!building) {
      const version = await claimBuild(records, path, existing?.version ?? 0, now);
      if (version !== undefined) {
        await buildAndRecord({ ...options, api, path, version });
        return;
      }
      continue;
    }
    options.onLog?.(`waiting for another worker to finish building E2B template ${reference}`);
    if (now() >= deadline)
      throw new Error(`E2B template ${reference} was still being built after one hour`);
    await sleep(BUILD_POLL_MS, signal);
    if (await api.exists(reference, signal)) return;
  }
}

async function claimBuild(
  records: EncryptedRecordStore,
  path: string,
  version: number,
  now: () => number,
): Promise<number | undefined> {
  const record: BuildRecord = { status: "building", startedAt: new Date(now()).toISOString() };
  try {
    await records.write(path, record, version);
    return version + 1;
  } catch (error) {
    if (error instanceof RecordStoreError && error.status === 409) return undefined;
    throw error;
  }
}

async function buildAndRecord(
  options: EnsureManagedE2BTemplateOptions & {
    api: ManagedE2BTemplateApi;
    path: string;
    version: number;
  },
): Promise<void> {
  const { reference, records, path, version } = options;
  options.onLog?.(`building E2B template ${reference} from the packaged Dockerfile.sandbox`);
  const now = options.now ?? Date.now;
  let result: { name: string; templateId: string; buildId: string };
  let lastLog = 0;
  try {
    result = await buildSelfBenchE2BTemplate({
      name: reference,
      cpuCount: MANAGED_E2B_TEMPLATE_CPUS,
      memoryMiB: MANAGED_E2B_TEMPLATE_MEMORY_MIB,
      credentials: options.credentials,
      projectRoot: options.projectRoot ?? projectRoot(import.meta.url),
      ...(options.buildApi ? { api: options.buildApi } : {}),
      onLog: (message) => {
        // Long builds must heartbeat; coalesce log bursts to one call per 30 seconds.
        if (options.onLog && now() - lastLog >= 30_000) {
          lastLog = now();
          options.onLog(message);
        }
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // Release the claim by writing our own record at our version: a delete could wipe a
    // successor's lock that a stale-window takeover already placed on this path.
    await records
      .write(path, { status: "failed", failedAt: new Date(now()).toISOString() }, version)
      .catch(() => undefined);
    throw new Error(
      `E2B template ${reference} could not be built in this account: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const record: BuildRecord = {
    status: "ready",
    templateId: result.templateId,
    buildId: result.buildId,
    builtAt: new Date(now()).toISOString(),
  };
  await records.write(path, record, version);
  options.onLog?.(`built E2B template ${reference} (build ${result.buildId})`);
}

function createManagedE2BTemplateApi(credentials: E2BCredentials): ManagedE2BTemplateApi {
  return {
    exists: async (reference, signal) =>
      await new E2B(credentials).Template.exists(reference, {
        requestTimeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      }),
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
