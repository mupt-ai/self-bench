import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../artifacts/index.js";
import type { TaskImageConfig } from "../contracts/config/task-images.js";
import { googleCloudBuild } from "../generation/images/cloud-build-api.js";
import { googleAccessToken } from "../lib/google-access-token.js";
import { customerPackage } from "./package.js";
import { copyCustomerImages, customerRegistry } from "./registry.js";
import { type CustomerExportRequest, customerRepository, exportPrefix } from "./types.js";

export interface CustomerExportActivities {
  prepareCustomerExport(request: CustomerExportRequest): Promise<void>;
  failCustomerExport(request: CustomerExportRequest): Promise<void>;
}
export function customerExportActivities(
  store: ArtifactStore,
  config?: TaskImageConfig,
): CustomerExportActivities {
  return {
    async prepareCustomerExport(request) {
      if (config?.builder?.kind !== "cloud-build")
        throw new Error("Customer exports need Cloud Build");
      const prefix = exportPrefix(request.repoId, request.id);
      if (await store.stat(`${prefix}ready.json`)) return;
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), 10_000);
      try {
        const destination = customerRepository(config.repository, request.repoId, request.id);
        // Validate/package everything before provisioning or exposing any images.
        const packed = await customerPackage(store, request, config.repository, destination);
        const registry = customerRegistry(config.repository, {
          token: googleAccessToken,
          fetch: (input, init) => fetch(input, init),
        });
        await registry.create(destination);
        await copyCustomerImages(
          googleCloudBuild(config.builder),
          packed.images,
          context.cancellationSignal,
        );
        await store.put(`${prefix}harbor.zip`, packed.zip, "application/zip");
        // Access is granted only when the whole export is ready. Retries preserve other bindings.
        await registry.grant(destination, request.email);
        await store.put(
          `${prefix}ready.json`,
          Buffer.from(JSON.stringify({ repository: destination })),
          "application/json",
        );
      } finally {
        clearInterval(timer);
      }
    },
    async failCustomerExport(request) {
      const prefix = exportPrefix(request.repoId, request.id);
      if (await store.stat(`${prefix}ready.json`)) return;
      await store.put(
        `${prefix}failed.json`,
        Buffer.from(
          JSON.stringify({
            error:
              "Export preparation failed. Check worker logs, registry permissions, and the customer's Google account, then create a new export.",
          }),
        ),
        "application/json",
      );
    },
  };
}
