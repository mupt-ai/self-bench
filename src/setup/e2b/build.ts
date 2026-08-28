import { resolve } from "node:path";
import { type BuildInfo, E2B, type LogEntry, type TemplateClass } from "e2b";
import type { E2BCredentials } from "../../config.js";
import {
  normalizeE2BBuildName,
  normalizeE2BDomain,
  normalizeE2BTemplateReference,
} from "./template.js";

const TEMPLATE_BUILD_REQUEST_TIMEOUT_MS = 60_000;

export interface E2BTemplateBuildApi {
  fromDockerfile(dockerfile: string, contextDirectory: string): TemplateClass;
  build(
    template: TemplateClass,
    name: string,
    options: {
      readonly cpuCount: number;
      readonly memoryMB: number;
      readonly onBuildLogs: (entry: LogEntry) => void;
      readonly requestTimeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BuildInfo>;
}

export interface BuildSelfBenchE2BTemplateOptions {
  readonly name: string;
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly credentials: E2BCredentials;
  readonly projectRoot: string;
  readonly api?: E2BTemplateBuildApi;
  readonly onLog?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export async function buildSelfBenchE2BTemplate(
  options: BuildSelfBenchE2BTemplateOptions,
): Promise<BuildInfo> {
  options.signal?.throwIfAborted();
  const name = normalizeE2BBuildName(options.name);
  const credentials = validateCredentials(options.credentials);
  if (!Number.isInteger(options.cpuCount) || options.cpuCount < 1) {
    throw new Error("E2B template CPU count must be a positive integer");
  }
  if (!Number.isInteger(options.memoryMiB) || options.memoryMiB < 1) {
    throw new Error("E2B template memory must be a positive integer");
  }
  const api = options.api ?? createE2BTemplateBuildApi(credentials);
  const dockerfile = resolve(options.projectRoot, "Dockerfile.sandbox");
  const template = api.fromDockerfile(dockerfile, options.projectRoot);
  const result = await api.build(template, name, {
    cpuCount: options.cpuCount,
    memoryMB: options.memoryMiB,
    onBuildLogs: (entry) => options.onLog?.(entry.toString()),
    requestTimeoutMs: TEMPLATE_BUILD_REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  normalizeE2BTemplateReference(result.name);
  if (!result.templateId.trim() || !result.buildId.trim()) {
    throw new Error("E2B template build returned incomplete template or build identifiers");
  }
  return result;
}

function validateCredentials(credentials: E2BCredentials): E2BCredentials {
  const apiKey = credentials.apiKey.trim();
  if (!apiKey) {
    throw new Error("E2B template build requires a nonblank API key");
  }
  const domain = normalizeE2BDomain(credentials.domain);
  return { apiKey, ...(domain ? { domain } : {}) };
}

function createE2BTemplateBuildApi(credentials: E2BCredentials): E2BTemplateBuildApi {
  const client = new E2B(credentials);
  return {
    fromDockerfile: (dockerfile, contextDirectory) =>
      client.Template({ fileContextPath: contextDirectory }).fromDockerfile(dockerfile),
    build: async (template, name, options) => await client.Template.build(template, name, options),
  };
}
