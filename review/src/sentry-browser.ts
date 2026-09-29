// Only what telemetry.ts uses, so the lazily loaded chunk tree-shakes the rest of the SDK.
export { captureException, init, setUser } from "@sentry/browser";
