import type { CloudBuildApi } from "../generation/images/cloud-build-api.js";
import type { RegistryAccess } from "../generation/images/registry.js";

/** Dedicated repositories, never IAM changes to the shared task-image repository. */
export function customerRegistry(source: string, access: RegistryAccess) {
  const [host, project] = source.split("/");
  const region = host?.replace(/-docker\.pkg\.dev$/, "");
  if (!host || !project || region === host)
    throw new Error("Customer exports need Artifact Registry");
  const base = `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${region}/repositories`;
  const call = async (url: string, method: string, body?: unknown) => {
    const response = await access.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await access.token()}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`Customer registry ${method} failed (HTTP ${response.status})`);
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
        throw new Error(`Cannot inspect customer repository (HTTP ${found.status})`);
      const operation = await call(`${base}?repositoryId=${repository.split("/")[2]}`, "POST", {
        format: "DOCKER",
        description: "Private customer evaluation export",
        dockerConfig: { immutableTags: true },
      });
      if (!operation.name) throw new Error("Registry returned no creation operation");
      for (let attempt = 0; attempt < 120; attempt++) {
        const state = await call(
          `https://artifactregistry.googleapis.com/v1/${operation.name}`,
          "GET",
        );
        if (state.error) throw new Error("Customer repository creation failed");
        if (state.done) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Customer repository creation timed out");
    },
    async grant(repository: string, email: string) {
      const url = repoUrl(repository);
      // Keep inherited/existing bindings and the etag; no public or project-wide access.
      const policy = await call(`${url}:getIamPolicy`, "GET");
      const bindings = (policy.bindings ?? []) as {
        role: string;
        members: string[];
        condition?: unknown;
      }[];
      let reader = bindings.find(
        (binding) => binding.role === "roles/artifactregistry.reader" && !binding.condition,
      );
      if (!reader) {
        reader = { role: "roles/artifactregistry.reader", members: [] };
        bindings.push(reader);
      }
      if (!reader.members.includes(`user:${email}`)) reader.members.push(`user:${email}`);
      await call(`${url}:setIamPolicy`, "POST", { policy: { ...policy, bindings } });
    },
  };
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
    throw new Error(`Image copy failed (${result.status}); build ${result.id}`);
}
