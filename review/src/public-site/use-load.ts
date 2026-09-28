import { useEffect, useState } from "react";

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" };

/** Answers kept for the visit, the most recently used last; the oldest go past `limit`. */
export interface LoadMemory<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function loadMemory<T>(limit: number): LoadMemory<T> {
  const values = new Map<string, T>();
  return {
    get(key) {
      const value = values.get(key);
      if (value !== undefined) {
        values.delete(key);
        values.set(key, value);
      }
      return value;
    },
    set(key, value) {
      values.delete(key);
      if (value === undefined) return;
      values.set(key, value);
      for (const oldest of values.keys()) {
        if (values.size <= limit) break;
        values.delete(oldest);
      }
    },
  };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Runs an async read when its key changes; ignores results that arrive after a newer read.
 * With a `memory`, a key read before shows its remembered answer at once, from the first frame,
 * while it is read again in the background; the page only redraws if the answer changed.
 * Otherwise, while a new key loads, the last ready value stays up if it belongs to the same
 * `group` (switching between runs of one repository), so the page does not collapse. A value
 * from another group is never shown, not even for the first frame at the new key.
 */
export function useLoad<T>(
  key: string,
  read: () => Promise<T>,
  group = key,
  memory?: LoadMemory<T>,
): Load<T> {
  const [state, setState] = useState<{ key: string; group: string; load: Load<T> }>(() => {
    const remembered = memory?.get(key);
    return {
      key,
      group,
      load:
        remembered === undefined ? { status: "loading" } : { status: "ready", value: remembered },
    };
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the read
  useEffect(() => {
    let live = true;
    setState((current) => {
      const remembered = memory?.get(key);
      if (remembered !== undefined)
        return { key, group, load: { status: "ready", value: remembered } };
      if (current.load.status === "ready" && current.group === group) return { ...current, key };
      return { key, group, load: { status: "loading" } };
    });
    read().then(
      (value) => {
        if (!live) return;
        memory?.set(key, value);
        setState((current) =>
          current.key === key && current.load.status === "ready" && same(current.load.value, value)
            ? current
            : { key, group, load: { status: "ready", value } },
        );
      },
      () => {
        if (!live) return;
        // A failed read in the background leaves a remembered answer up.
        setState((current) =>
          current.key === key && memory?.get(key) !== undefined
            ? current
            : { key, group, load: { status: "error" } },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  // Until the effect has run for a new key, answer from memory, else keep the same group's value.
  if (state.key === key) return state.load;
  const remembered = memory?.get(key);
  if (remembered !== undefined) return { status: "ready", value: remembered };
  return state.group === group && state.load.status === "ready"
    ? state.load
    : { status: "loading" };
}
