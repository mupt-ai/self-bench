export async function addPrBatch<T>(
  selected: Iterable<number>,
  start: (number: number) => Promise<T>,
) {
  const started: { number: number; task: T }[] = [];
  const failed: { number: number; message: string }[] = [];
  for (const number of new Set(selected)) {
    try {
      started.push({ number, task: await start(number) });
    } catch (error) {
      failed.push({
        number,
        message: error instanceof Error ? error.message : "Could not start task.",
      });
    }
  }
  return { started, failed };
}
