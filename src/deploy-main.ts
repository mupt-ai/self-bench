import { loadConfig } from "./config.js";

loadConfig();
const command = process.argv[2];
if (command === "migrate") {
  const url = process.env.SELFBENCH_DATABASE_URL;
  if (!url) throw new Error("SELFBENCH_DATABASE_URL is required");
  const { openDatabase } = await import("./db/client.js");
  const database = await openDatabase(url);
  await database.close();
} else if (command !== "config") {
  throw new Error(`Unknown deployment command: ${command}`);
}
