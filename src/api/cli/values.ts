import { fail } from "../../lib/util.js";
export function requiredArgument(args: string[], label: string): string {
  return args[0] ?? fail(`${label} is required`);
}
