import { strToU8, type Zippable, zipSync } from "fflate";
import type { ArtifactStore } from "../artifacts/index.js";
import { HARBOR_VERSION } from "../harnesses/harbor/command.js";
import { readExecutionBundle } from "./bundle.js";
import type { CustomerExportRequest } from "./types.js";

/** Where the customer pulls from: SelfBench's own registry endpoint, with the export's grant. */
export interface ExportRegistry {
  /** SelfBench's public host, which serves `/v2/` (api/routes/registry.ts). */
  readonly host: string;
  /** The task image repository the grant's images live in. */
  readonly repository: string;
  readonly password: string;
  readonly expiresAt: Date;
}

/** Only execution bundles: build inputs or a mutable task row cannot replace the frozen task. */
export async function customerPackage(
  store: ArtifactStore,
  request: CustomerExportRequest,
  registry: ExportRegistry,
): Promise<Buffer> {
  if (!request.tasks.length || request.tasks.length > 500)
    throw new Error("Export between 1 and 500 tasks at a time");
  const files: Zippable = {};
  const manifest = [];
  let bytes = 0;
  const add = (name: string, text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 32 * 1024 * 1024) throw new Error("Customer task files exceed 32 MiB");
    files[name] = [
      strToU8(text),
      { os: 3, attrs: (name.endsWith(".sh") ? 0o100755 : 0o100644) << 16 },
    ];
  };
  // The image as the customer pulls it: the same name and digest, on SelfBench's host.
  const served = (image: string) => {
    if (
      !image.startsWith(`${registry.repository}/`) ||
      !/^[-a-z0-9./]+@sha256:[a-f0-9]{64}$/.test(image)
    )
      throw new Error("An export image is not in the task image repository");
    return `${registry.host}/${image.slice(registry.repository.length + 1)}`;
  };
  for (const [index, task] of request.tasks.entries()) {
    if (!task.images || !task.bundleKey.endsWith("/execution-task.tar.gz"))
      throw new Error(
        `Task ${task.taskId} has no frozen execution bundle; evaluate its image-backed version first.`,
      );
    const pair = task.images;
    const images = { agent: served(pair.agent), verifier: served(pair.verifier) };
    const bundle = await readExecutionBundle(store, task.bundleKey);
    if ([...bundle.keys()].some((path) => path.endsWith("docker-compose.yaml")))
      throw new Error(
        `Task ${task.taskId} uses services; customer exports do not support service tasks yet.`,
      );
    const required = [
      "task.toml",
      "instruction.md",
      "environment/Dockerfile",
      "tests/Dockerfile",
      "tests/test.sh",
      "tests/test.patch",
      "solution/solve.sh",
      "solution/gold.patch",
    ];
    const directory = `tasks/task-${String(index + 1).padStart(4, "0")}`;
    for (const path of required) {
      const file = bundle.get(path);
      if (file === undefined) throw new Error(`Task ${task.taskId} is missing ${path}`);
      let text = file;
      if (path.endsWith("Dockerfile")) {
        const original = path.startsWith("environment/") ? pair.agent : pair.verifier;
        if (text.trim() !== `FROM ${original}`)
          throw new Error(`Task ${task.taskId} has an unexpected image context`);
        text = `FROM ${path.startsWith("environment/") ? images.agent : images.verifier}\n`;
      }
      add(`${directory}/${path}`, text);
    }
    manifest.push({
      directory,
      taskId: task.taskId,
      runId: task.runId,
      ...images,
    });
  }
  add(
    "manifest.json",
    `${JSON.stringify({ evaluationId: request.evaluationId, harborVersion: HARBOR_VERSION, tasks: manifest }, null, 2)}\n`,
  );
  const expires = registry.expiresAt.toISOString().slice(0, 10);
  add(
    "README.md",
    `# ${request.customer}: Harbor Evaluation

These tasks run on your own machine with Docker and Harbor ${HARBOR_VERSION}. Their images are pulled from SelfBench with the key below, which works until ${expires}. They are Linux images; Apple Silicon may need amd64 emulation.

## Setup

Install Docker and Harbor ${HARBOR_VERSION}, then sign Docker in to SelfBench:

\`\`\`sh
echo '${registry.password}' | docker login ${registry.host} --username export --password-stdin
\`\`\`

## Run

Supply your own model credentials, then run from this directory. Replace the agent, model, and allowed model API host with yours:

\`\`\`sh
harbor run --path ./tasks --agent codex --model MODEL --env docker --allow-agent-host api.openai.com
\`\`\`

\`manifest.json\` pins each task's exact version and image digests.

## Keep It Private

The key, hidden tests, and reference solutions are in this package, unencrypted. Don't share it, and never expose the verifier image or the \`solution\` directory to the agent being evaluated.
`,
  );
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) }));
}
