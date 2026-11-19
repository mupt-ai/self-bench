import { DariLink, LinkError } from "@mupt-ai/dari-gateway/link/client";
import React from "react";
import {
  type DariLinkBrowserConfig,
  dariLinkRequest,
} from "../../../../src/gateway/dari-link/connection";
import { evaluationRequest } from "./api";

/**
 * Connect with Dari: Dari opens in a popup, where the user picks the plans and API keys SelfBench
 * may use and approves; SelfBench's server redeems the code. `onChange` runs once it is saved.
 */
export function useDariConnect(
  org: string,
  config: DariLinkBrowserConfig | null | undefined,
  onChange?: () => Promise<void> | void,
) {
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState("");
  const connect = () => {
    if (!config || connecting) return;
    setError("");
    setConnecting(true);
    // Called straight from the click, so the browser lets Dari's popup open.
    DariLink.open({ ...config, ...dariLinkRequest })
      .then(async ({ code, codeVerifier }) => {
        await evaluationRequest(`/api/orgs/${encodeURIComponent(org)}/credentials/dari-link`, {
          code,
          codeVerifier,
        });
        await onChange?.();
      })
      .catch((cause) => {
        if (cause instanceof LinkError && cause.code === "popup_closed") return;
        setError(
          cause instanceof LinkError && cause.code === "popup_blocked"
            ? "Your browser blocked the Dari window. Allow pop-ups for this site, then connect again."
            : cause instanceof Error
              ? cause.message
              : "Could not connect Dari.",
        );
      })
      .finally(() => setConnecting(false));
  };
  return { connecting, error, connect };
}
