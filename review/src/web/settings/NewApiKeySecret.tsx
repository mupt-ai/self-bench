import { Check, Copy, KeyRound } from "lucide-react";
import React from "react";
import { Button } from "../ui";
import type { CreatedApiKey } from "./api-keys";

export function NewApiKeySecret({
  created,
  onDismiss,
}: {
  created: CreatedApiKey;
  onDismiss(): void;
}) {
  const [copied, setCopied] = React.useState<"idle" | "copied" | "failed">("idle");
  const secret = React.useRef<HTMLElement>(null);
  const title = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    title.current?.focus();
  }, []);
  React.useEffect(() => {
    if (copied !== "copied") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const ok = await copyText(created.secret, secret.current);
    setCopied(ok ? "copied" : "failed");
    if (!ok) selectContents(secret.current);
  };
  return (
    <section aria-labelledby="new-api-key-title" className="mb-8 border border-brand/40 bg-brand/5">
      <div className="border-b border-brand/20 px-4 py-3">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <div>
            <h2
              id="new-api-key-title"
              ref={title}
              tabIndex={-1}
              className="text-sm font-medium text-foreground outline-none"
            >
              Save {created.key.name} Now
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              This is the only time the complete key will be shown. SelfBench cannot reveal it
              again.
            </p>
          </div>
        </div>
      </div>
      <div className="p-4">
        <p className="mb-2 text-[10px] tracking-wider text-muted-foreground uppercase">
          API Key Secret
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <code
            ref={secret}
            data-testid="api-key-secret"
            className="min-w-0 flex-1 break-all border border-border bg-background px-3 py-2.5 font-mono text-xs leading-5 select-all"
          >
            {created.secret}
          </code>
          <Button
            size="small"
            variant={copied === "copied" ? "primary" : "secondary"}
            onClick={() => void copy()}
            aria-label="Copy API Key"
            className="sm:self-start"
          >
            {copied === "copied" ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied === "copied" ? "Copied" : "Copy Key"}
          </Button>
        </div>
        <div className="mt-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
          <p
            role="status"
            aria-live="polite"
            className={copied === "failed" ? "text-xs text-destructive" : "text-xs text-success"}
          >
            {copied === "copied" && "Copied to clipboard."}
            {copied === "failed" &&
              "Copying is not available here. The key is selected; press ⌘C or Ctrl+C to copy it."}
          </p>
          <Button size="small" variant="ghost" onClick={onDismiss}>
            I’ve Saved It
          </Button>
        </div>
      </div>
    </section>
  );
}

async function copyText(text: string, node: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The selection fallback below works when clipboard access is blocked.
  }
  try {
    if (!selectContents(node)) return false;
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function selectContents(node: HTMLElement | null): boolean {
  const selection = window.getSelection();
  if (!node || !selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
