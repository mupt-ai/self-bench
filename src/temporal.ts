import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import type { SelfBenchConfig } from "./config.js";

export async function connectTemporalClient(
  config: SelfBenchConfig["temporal"],
): Promise<Connection> {
  return await Connection.connect({
    address: config.address,
    tls: config.tls,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
}

export async function connectTemporalWorker(
  config: SelfBenchConfig["temporal"],
): Promise<NativeConnection> {
  return await NativeConnection.connect({
    address: config.address,
    tls: config.tls,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
}
