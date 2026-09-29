import { type RunningWater, runWater, type WaterMessage, type WaterReply } from "./water-paint";

/**
 * The water, drawn off the main thread (see `WaterBackground`). It first says whether it can
 * draw WebGL on an offscreen canvas at all, which some browsers with offscreen canvases cannot,
 * so the page hands over its canvases only when it can. Checking here also moves the slow start
 * of the browser's first GPU context off the main thread.
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WaterMessage>) => void) | null;
  postMessage(reply: WaterReply): void;
};

const probe =
  typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1).getContext("webgl") : null;
probe?.getExtension("WEBGL_lose_context")?.loseContext();
scope.postMessage(probe ? "webgl" : "no-webgl");

let water: RunningWater | undefined;
scope.onmessage = ({ data }) => {
  if ("canvas" in data) water = runWater(data.canvas, data.bands, () => scope.postMessage("shown"));
  else water?.update(data.state);
};
