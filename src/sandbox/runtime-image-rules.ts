import {
  type HostedExecutionBackend,
  isDigestPinnedOciImage,
} from "../contracts/config/providers.js";
import { normalizeE2BTemplateReference } from "./providers/e2b/template.js";

/**
 * Why a user-chosen runtime image is unusable for a provider, if it is. Browser-safe: the
 * settings form shares it. Vercel needs a digest-pinned published image; E2B needs no image
 * (the managed template) but accepts a custom template; Modal always builds Dockerfile.sandbox.
 */
export function sandboxImageIssue(
  backend: HostedExecutionBackend,
  image: string | undefined,
): string | undefined {
  switch (backend) {
    case "vercel":
      return isDigestPinnedOciImage(image ?? "")
        ? undefined
        : "Vercel requires a runtime image pinned by sha256 digest.";
    case "e2b":
      if (image === undefined) return undefined;
      try {
        if (normalizeE2BTemplateReference(image).split(":")[0] !== "base") return undefined;
      } catch {}
      return "E2B requires a prebuilt SelfBench template, not base.";
    case "modal":
      return image === undefined ? undefined : "Modal does not use a runtime image.";
  }
}
