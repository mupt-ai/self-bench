import { download, passthrough } from "./api-client.js";
import { associate } from "./associate.js";
import { printHelp } from "./help.js";
import { replay } from "./replay.js";
import { run } from "./run.js";
import { down, setup, up } from "./stack.js";
import { fail, requiredArgument } from "./values.js";
import { view } from "./view.js";

export async function runCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "setup":
      await setup(rest);
      break;
    case "up":
      await up(rest);
      break;
    case "run":
      await run(rest);
      break;
    case "associate":
      await associate(rest);
      break;
    case "replay":
      await replay(rest);
      break;
    case "down":
      await down();
      break;
    case "status":
      await passthrough("GET", `/v1/runs/${requiredArgument(rest, "run ID")}`);
      break;
    case "cancel":
      await passthrough("POST", `/v1/runs/${requiredArgument(rest, "run ID")}/cancel`);
      break;
    case "list":
      await passthrough("GET", "/v1/runs");
      break;
    case "view":
      await view(rest);
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
