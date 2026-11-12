import React from "react";

/** Runs a change, keeping its failure next to the control that made it. */
export function useAction() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const message = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
  return { busy, run, message };
}
