import React from "react";
import type { VariantChanges } from "../../../../src/contracts/variants";

const code = "font-mono text-foreground";

/** What an environment changes, as a sentence: identifiers in mono, the rest in the body text. */
export function ChangesSummary({ changes }: { changes?: VariantChanges }) {
  if (!changes) return <span className="text-muted-foreground">Changes not recorded</span>;
  const parts = [
    ...changes.packages.map((pkg) => (
      <span key={`p:${pkg.name}:${pkg.directory}`}>
        <span className={code}>{pkg.name}</span> at <span className={code}>{pkg.spec}</span>
        {pkg.directory && (
          <>
            {" "}
            in <span className={code}>{pkg.directory}</span>
          </>
        )}
      </span>
    )),
    ...changes.files.map((file) => (
      <span key={`f:${file.path}:${file.mode}`}>
        {file.mode === "delete" ? "Removes" : file.mode === "append" ? "Appends to" : "Replaces"}{" "}
        <span className={code}>{file.path}</span>
      </span>
    )),
  ];
  return (
    <span className="text-muted-foreground wrap-anywhere">
      {parts.map((part, index) => (
        <React.Fragment key={part.key}>
          {index > 0 && " · "}
          {part}
        </React.Fragment>
      ))}
    </span>
  );
}
