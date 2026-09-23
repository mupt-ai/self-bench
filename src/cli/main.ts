import { fail } from "../lib/util.js";
import { download, passthrough } from "./api-client.js";
import { printHelp } from "./help.js";
import { requiredArgument } from "./values.js";

export async function runCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "status":
      await passthrough("GET", `/v1/runs/${requiredArgument(rest, "run ID")}`);
      break;
    case "cancel":
      await passthrough("POST", `/v1/runs/${requiredArgument(rest, "run ID")}/cancel`);
      break;
    case "list":
      await passthrough("GET", "/v1/runs");
      break;
    case "download":
      await download(requiredArgument(rest, "run ID"), rest[1] ?? fail("output path is required"));
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
