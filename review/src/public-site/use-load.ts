import { useEffect, useState } from "react";

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" };

/**
 * Runs an async read when its key changes; ignores results that arrive after a newer read.
 * While a new key loads, the last ready value stays up if it belongs to the same `group`
 * (switching between runs of one repository), so the page does not collapse. A value from
 * another group is never shown, not even for the first frame at the new key.
 */
export function useLoad<T>(key: string, read: () => Promise<T>, group = key): Load<T> {
  const [state, setState] = useState<{ load: Load<T>; group: string }>({
    load: { status: "loading" },
    group,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the read
  useEffect(() => {
    let live = true;
    setState((current) =>
      current.load.status === "ready" && current.group === group
        ? current
        : { load: { status: "loading" }, group },
    );
    read().then(
      (value) => live && setState({ load: { status: "ready", value }, group }),
      () => live && setState({ load: { status: "error" }, group }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state.group === group ? state.load : { status: "loading" };
}
