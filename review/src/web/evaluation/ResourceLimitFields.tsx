import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input } from "../ui";

export type ResourceLimits = NonNullable<CredentialInfo["resourceLimits"]>;

const FIELDS = [
  {
    key: "cpus",
    label: "Max CPUs per Sandbox",
    tooltip: "The most vCPUs one sandbox on this account may have.",
    toField: (value: number) => value,
    fromField: (value: number) => value,
    step: 0.5,
  },
  {
    key: "memoryMb",
    label: "Max Memory per Sandbox (GiB)",
    tooltip: "The most memory one sandbox on this account may have.",
    toField: (value: number) => Number((value / 1024).toFixed(2)),
    fromField: (value: number) => Math.round(value * 1024),
    step: 0.5,
  },
  {
    key: "storageMb",
    label: "Max Storage per Sandbox (GiB)",
    tooltip: "The most disk one sandbox on this account may have.",
    toField: (value: number) => Number((value / 1024).toFixed(2)),
    fromField: (value: number) => Math.round(value * 1024),
    step: 1,
  },
] as const;

/** Without a dimension, empty limits are none at all. */
export function savedLimits(limits: ResourceLimits): ResourceLimits | null {
  return Object.values(limits).some((value) => value !== undefined) ? limits : null;
}

/**
 * A sandbox account's per-sandbox limits. Evaluations refuse a task that asks for more before any
 * of its trials start. `onDetect` reads them from the provider with the saved key.
 */
export function ResourceLimitFields({
  limits,
  onChange,
  onDetect,
}: {
  limits: ResourceLimits;
  onChange(limits: ResourceLimits): void;
  onDetect?: () => Promise<{ limits?: ResourceLimits; source: string }>;
}) {
  const [detecting, setDetecting] = React.useState(false);
  const [detected, setDetected] = React.useState("");
  return (
    <fieldset className="space-y-5" aria-label="Sandbox Resource Limits">
      <legend className="flex w-full items-center justify-between gap-2 text-sm font-semibold">
        <span className="flex items-center gap-1.5">
          Sandbox Resource Limits
          <InfoTooltip label="Evaluations refuse a task that asks for more than these before any trial starts, and warn when a task comes within 10% of one. Leave blank for no limit. A new credential gets its provider's limits when the provider shares them (Daytona, Vercel)." />
        </span>
        {onDetect && (
          <Button
            type="button"
            variant="ghost"
            disabled={detecting}
            onClick={async () => {
              setDetecting(true);
              setDetected("");
              try {
                const result = await onDetect();
                if (result.limits) onChange({ ...limits, ...result.limits });
                setDetected(result.limits ? `Filled from ${result.source}.` : `${result.source}.`);
              } catch (cause) {
                setDetected(cause instanceof Error ? cause.message : "Could not detect limits.");
              } finally {
                setDetecting(false);
              }
            }}
          >
            {detecting ? "Detecting…" : "Detect Limits"}
          </Button>
        )}
      </legend>
      {detected && (
        <p role="status" className="text-xs text-muted-foreground">
          {detected}
        </p>
      )}
      {FIELDS.map((field) => {
        const value = limits[field.key];
        return (
          <label key={field.key} className={fieldStyles} htmlFor={`credential-${field.key}`}>
            <span className="flex items-center gap-1.5">
              {field.label}
              <InfoTooltip label={field.tooltip} />
            </span>
            <Input
              id={`credential-${field.key}`}
              aria-label={field.label}
              type="number"
              inputMode="decimal"
              min={field.step}
              step={field.step}
              placeholder="No Limit"
              value={value === undefined ? "" : field.toField(value)}
              onChange={(event) => {
                const next = { ...limits };
                if (event.target.value === "" || !(Number(event.target.value) > 0))
                  delete next[field.key];
                else next[field.key] = field.fromField(Number(event.target.value));
                onChange(next);
              }}
            />
          </label>
        );
      })}
    </fieldset>
  );
}
