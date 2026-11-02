import type { CloudBuildApi } from "../generation/images/cloud-build-api.js";
import type { RegistryAccess } from "../generation/images/registry.js";

/** Dedicated repositories, never IAM changes to the shared task-image repository. */
export function customerRegistry(source: string, access: RegistryAccess) {
  const [host, project] = source.split("/");
  const region = host?.replace(/-docker\.pkg\.dev$/, "");
  if (!host || !project || region === host)
    throw new Error("Customer exports need Artifact Registry");
  const base = `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${region}/repositories`;
  const call = async (url: string, method: string, action: string, body?: unknown) => {
    const response = await access.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await access.token()}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${action} (HTTP ${response.status})`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const repoUrl = (repository: string) => {
    if (
      !repository.startsWith(`${host}/${project}/customer-`) ||
      !/^customer-[0-9]+-[a-f0-9-]{36}$/.test(repository.split("/")[2] ?? "")
    )
      throw new Error("Not a dedicated customer repository");
    return `${base}/${repository.split("/")[2]}`;
  };
  return {
    async create(repository: string) {
      const url = repoUrl(repository);
      const found = await access.fetch(url, {
        headers: { authorization: `Bearer ${await access.token()}` },
      });
      if (found.ok) return;
      if (found.status !== 404)
        throw new Error(`Could not check the export repository (HTTP ${found.status})`);
      const operation = await call(
        `${base}?repositoryId=${repository.split("/")[2]}`,
        "POST",
        "Could not create the export repository",
        {
          format: "DOCKER",
          description: "Private customer evaluation export",
          dockerConfig: { immutableTags: true },
        },
      );
      if (operation.error) throw new Error("Could not create the export repository");
      // Poll the repository itself, not its project-scoped LRO. Metadata reads are
      // unconditional so a nonexistent repository can return 404 before creation.
      for (let attempt = 0; attempt < 120; attempt++) {
        const ready = await access.fetch(url, {
          headers: { authorization: `Bearer ${await access.token()}` },
        });
        if (ready.ok) return;
        if (ready.status !== 404)
          throw new Error(`Could not check the export repository (HTTP ${ready.status})`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Creating the export repository timed out");
    },
    /** The customer's read access, granted once every image is in place. */
    async grant(repository: string, email: string) {
      await bind(repository, "roles/artifactregistry.reader", `user:${email}`);
    },
    /**
     * The build account's push access, granted on this repository itself. The shared task
     * repository grants its builder on the repository; the project-wide condition that covers
     * customer-* does not reach these repositories, so copies were refused with HTTP 403.
     */
    async allowWriter(repository: string, serviceAccount: string) {
      await bind(repository, "roles/artifactregistry.writer", `serviceAccount:${serviceAccount}`);
    },
  };
  /** Adds one member to a repository's unconditioned binding, keeping every other binding and the etag. */
  async function bind(repository: string, role: string, member: string) {
    const url = repoUrl(repository);
    // Version 3 returns conditional bindings, and writing back a version-1 policy would drop them.
    const policy = await call(
      `${url}:getIamPolicy?options.requestedPolicyVersion=3`,
      "GET",
      "Could not read the export repository's access policy",
    );
    const bindings = (policy.bindings ?? []) as {
      role: string;
      members: string[];
      condition?: unknown;
    }[];
    let binding = bindings.find((entry) => entry.role === role && !entry.condition);
    if (!binding) {
      binding = { role, members: [] };
      bindings.push(binding);
    }
    if (!binding.members.includes(member)) binding.members.push(member);
    await call(
      `${url}:setIamPolicy`,
      "POST",
      "Could not update the export repository's access policy",
      {
        policy: { ...policy, version: 3, bindings },
      },
    );
  }
}

/** Registry-to-registry copy: layers never pass through the API or worker. */
export async function copyCustomerImages(
  cloud: CloudBuildApi,
  images: readonly { source: string; destination: string }[],
  signal: AbortSignal,
): Promise<void> {
  const steps: Record<string, unknown>[] = [];
  for (let start = 0; start < images.length; start += 10) {
    steps.push({
      id: `credentials-${start}`,
      name: "gcr.io/cloud-builders/gcloud",
      entrypoint: "sh",
      args: ["-ec", "umask 077; gcloud auth print-access-token > /workspace/registry-token"],
    });
    const commands = images.slice(start, start + 10).map(({ source, destination }) => {
      // Only server-validated digest references are ever interpolated into the build script.
      if (
        ![source, destination].every((image) =>
          /^[a-z0-9.-]+\/[-a-z0-9._/]+@sha256:[a-f0-9]{64}$/.test(image),
        )
      )
        throw new Error("Invalid export image reference");
      return `skopeo copy --all --preserve-digests --src-creds "oauth2accesstoken:$$token" --dest-creds "oauth2accesstoken:$$token" docker://${source} docker://${destination}`;
    });
    steps.push({
      id: `copy-${start}`,
      name: "quay.io/skopeo/stable:v1.17.0",
      entrypoint: "/bin/sh",
      timeout: "3300s",
      args: ["-ec", `token=$(cat /workspace/registry-token); ${commands.join("; ")}`],
    });
  }
  const result = await cloud.run({ timeout: "7200s", steps }, signal);
  if (result.status !== "SUCCESS")
    throw new Error(`Could not copy the images (Cloud Build ${result.status}, build ${result.id})`);
}
