export function requiredArgument(args: string[], label: string): string {
  return args[0] ?? fail(`${label} is required`);
}

export function fail(message: string): never {
  throw new Error(message);
}
