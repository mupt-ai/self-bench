export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

/** The two-sided 95% Wilson score interval for a binomial proportion, in percentage points. */
export function wilson95(passed: number, tasks: number): ConfidenceInterval {
  if (
    !Number.isInteger(passed) ||
    !Number.isInteger(tasks) ||
    tasks <= 0 ||
    passed < 0 ||
    passed > tasks
  ) {
    throw new RangeError("Wilson interval requires integer counts with 0 <= passed <= tasks.");
  }

  const z = 1.959963984540054;
  const n = tasks;
  const p = passed / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  // At 0% and 100% the bound is exactly the score; floating point can land it a hair inside,
  // such as 99.99999999999999 for 10 of 10, which would leave the score outside its own interval.
  return {
    lower: passed === 0 ? 0 : Math.max(0, (center - halfWidth) * 100),
    upper: passed === tasks ? 100 : Math.min(100, (center + halfWidth) * 100),
  };
}

/**
 * A setting's accuracy interval for the results charts, or nothing when its counts are unusable or
 * disagree with the accuracy it shows: a stored release then shows its point without a bar
 * rather than failing to draw.
 */
export function accuracyInterval(setting: {
  passed: number;
  tasks: number;
  accuracy: number;
}): readonly [number, number] | undefined {
  const { passed, tasks, accuracy } = setting;
  if (!Number.isInteger(passed) || !Number.isInteger(tasks) || tasks <= 0) return undefined;
  if (passed < 0 || passed > tasks) return undefined;
  const { lower, upper } = wilson95(passed, tasks);
  return lower <= accuracy && accuracy <= upper ? [lower, upper] : undefined;
}
