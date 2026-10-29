import { strToU8, type Zippable, zipSync } from "fflate";
import type { ArtifactStore } from "../artifacts/index.js";
import { expandBundle } from "../generation/runs/bundle.js";
import { HARBOR_VERSION } from "../harnesses/harbor/command.js";
import type { CustomerExportRequest } from "./types.js";

/** Only execution bundles: build inputs or a mutable task row cannot replace the frozen task. */
export async function customerPackage(
  store: ArtifactStore,
  request: CustomerExportRequest,
  source: string,
  destination: string,
) {
  if (!request.tasks.length || request.tasks.length > 500)
    throw new Error("Export between 1 and 500 tasks at a time");
  const files: Zippable = {};
  const images = new Map<string, string>();
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
  for (const [index, task] of request.tasks.entries()) {
    if (!task.images || !task.bundleKey.endsWith("/execution-task.tar.gz"))
      throw new Error(
        `Task ${task.taskId} has no frozen execution bundle; evaluate its image-backed version first.`,
      );
    const pair = task.images;
    for (const image of [pair.agent, pair.verifier]) {
      if (!image.startsWith(`${source}/`) || !/^[-a-z0-9./]+@sha256:[a-f0-9]{64}$/.test(image))
        throw new Error(`Task ${task.taskId} is not backed by this deployment's verified images`);
      images.set(image, `${destination}/${image.slice(source.length + 1)}`);
    }
    const bundle = await expandBundle(store, task.bundleKey);
    if (bundle.files.some((file) => file.path.endsWith("docker-compose.yaml")))
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
      const file = bundle.files.find((file) => file.path === path);
      if (file?.text === undefined) throw new Error(`Task ${task.taskId} is missing ${path}`);
      let text = file.text;
      if (path.endsWith("Dockerfile")) {
        const original = path.startsWith("environment/") ? pair.agent : pair.verifier;
        if (text.trim() !== `FROM ${original}`)
          throw new Error(`Task ${task.taskId} has an unexpected image context`);
        text = `FROM ${images.get(original)}\n`;
      }
      add(`${directory}/${path}`, text);
    }
    manifest.push({
      directory,
      taskId: task.taskId,
      runId: task.runId,
      bundleKey: task.bundleKey,
      agent: images.get(pair.agent),
      verifier: images.get(pair.verifier),
    });
  }
  const host = destination.split("/")[0];
  add(
    "manifest.json",
    `${JSON.stringify({ evaluationId: request.evaluationId, harborVersion: HARBOR_VERSION, tasks: manifest }, null, 2)}\n`,
  );
  add(
    "README.md",
    `# ${request.customer}: Harbor Evaluation\n\nThese tasks run on your own machine with Docker and Harbor ${HARBOR_VERSION}. No SelfBench API, proxy, or account is needed. Images are pulled directly from Google Artifact Registry and cached by Docker. They are Linux images; Apple Silicon may require amd64 emulation.\n\n## Setup\n\nInstall Docker, Google Cloud CLI, and Harbor ${HARBOR_VERSION}. Sign in as the Google account granted access (${request.email}):\n\n\`\`\`sh\ngcloud auth login\ngcloud auth configure-docker ${host} --quiet\n\`\`\`\n\nSupply your own model credentials, then run from this directory (replace the agent, model, and allowed model API host as appropriate):\n\n\`\`\`sh\nharbor run --path ./tasks --agent codex --model MODEL --env docker --allow-agent-host api.openai.com\n\`\`\`\n\nThe manifest pins the exact evaluation task versions and image digests. Both agent and separate verifier images are included in your registry access. Hidden tests and reference solutions are included, unencrypted: keep this package private. Never expose the verifier image or solution directory to the agent under evaluation.\n\nImage access and retention are managed by the sender in Google Cloud; already downloaded copies cannot be revoked.\n`,
  );
  return {
    zip: Buffer.from(zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) })),
    images: [...images].map(([source, destination]) => ({ source, destination })),
  };
}
