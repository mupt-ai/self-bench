/**
 * The water's drawing, with no page access, so it runs the same on the main thread or in a
 * worker (see `WaterBackground`): the page's side reads what to draw and passes it in as a
 * `WaterState`.
 */

const VERTEX = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Three water surfaces, all drawn as a 4x4 ordered dither so they read as grain, not blur.
//   mode 0: rings centred on the page spreading outwards, as if the page had touched the water.
//   mode 1: the same rings travelling inwards.
//   mode 2: sparse raindrops landing at random, each ring widening and fading.
// Every mode is calm behind the content and livelier toward the window edges.
const FRAGMENT = `
precision mediump float;
uniform vec2 size;
uniform float time;
uniform vec3 tint;
uniform float strength;
uniform float mode;
uniform float coverage;

float hash(float n) { return fract(sin(n) * 43758.5453); }

float rings(vec2 q, float t, float direction) {
  float angle = atan(q.y, q.x);
  float r = length(q);
  r += 0.035 * sin(angle * 3.0 + t * 0.15) + 0.02 * sin(angle * 7.0 - t * 0.22);
  // With direction -1 the phase falls over time and each crest moves to a larger radius.
  float s = direction * t;
  float h = sin(r * 14.0 + s * 0.9) * 0.55
          + sin(r * 23.0 + s * 1.4 + angle * 2.0) * 0.28
          + sin(r * 37.0 + s * 2.0 - angle * 3.0) * 0.14;
  return smoothstep(0.3, 0.85, h);
}

float rain(vec2 q, float t) {
  float aspect = size.x / size.y;
  float shade = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float period = 4.0 + hash(fi * 7.13) * 3.0;
    float phase = t / period + hash(fi * 3.31);
    float drop = floor(phase) * 17.0 + fi * 1.93;
    float age = fract(phase);
    vec2 centre = (vec2(hash(drop * 1.7), hash(drop * 2.9)) - 0.5) * vec2(aspect, 1.0);
    float d = length(q - centre);
    float front = age * 0.55;
    // A short train of ripples just inside the widening front, fading as the drop ages.
    float train = exp(-pow((front - d) * 9.0, 2.0)) * step(d, front + 0.02);
    float crest = 0.5 + 0.5 * cos((front - d) * 80.0);
    shade += train * crest * (1.0 - age) * smoothstep(0.0, 0.04, age);
  }
  return clamp(shade, 0.0, 1.0);
}

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * size) / size.y;
  float shade = mode < 1.5 ? rings(q, time, mode < 0.5 ? -1.0 : 1.0) : rain(q, time);
  float edge = smoothstep(0.18, 0.75, length(q * vec2(0.8, 1.0)));
  shade = clamp(shade * (0.35 + 0.65 * edge) * coverage, 0.0, 1.0);
  // Strictly above the threshold, so flat water draws nothing at all.
  float dot4 = step(bayer4(gl_FragCoord.xy) + 0.04, shade);
  // Premultiplied (the canvas default), so a pixel without a dot is (0,0,0,0) and composites
  // as empty in every browser, rather than relying on the browser honouring unpremultiplied.
  float alpha = dot4 * strength;
  gl_FragColor = vec4(tint * alpha, alpha);
}`;

/** The water's look, read from the page. `mode` is undefined when the water is off. */
export interface Water {
  readonly tint: readonly [number, number, number];
  readonly strength: number;
  readonly coverage: number;
  readonly speed: number;
  readonly mode: number | undefined;
}

/** Everything the water needs from the page, passed in again whenever any of it changes. */
export interface WaterState {
  readonly water: Water;
  /** Drawn once, not animated: the visitor prefers less motion. */
  readonly still: boolean;
  /** The tab is hidden: drawing waits until it is shown again. */
  readonly hidden: boolean;
  /** The canvas size in pixels, at the water's resolution. */
  readonly width: number;
  readonly height: number;
}

/** What the page sends a water worker: its canvases once, then each new state. */
export type WaterMessage =
  | { readonly canvas: OffscreenCanvas; readonly bands: OffscreenCanvas | null }
  | { readonly state: WaterState };

/** What a water worker sends back: whether it can draw at all, then that a frame is drawn. */
export type WaterReply = "webgl" | "no-webgl" | "shown";

type Surface = HTMLCanvasElement | OffscreenCanvas;

/** Runs `draw` on the next frame; returns how to cancel it. Older browsers' workers lack frames. */
function nextFrame(draw: (now: number) => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(() => draw(performance.now()), 16);
  return () => clearTimeout(id);
}

/** The water that `runWater` keeps drawing: given each new state, stopped once. */
export interface RunningWater {
  update(state: WaterState): void;
  stop(): void;
}

/**
 * Draws the water on `canvas` from each state it is given, or nothing where WebGL is missing.
 * The shader compiles without blocking where the browser can do that in the background
 * (KHR_parallel_shader_compile): each frame asks whether it is done instead of waiting. Every
 * frame is also copied onto `bands`, the canvas over the pinned header and footer, so the water
 * is drawn once, by one GPU context. `shown` is called once the first frame is drawn.
 */
export function runWater(
  canvas: Surface,
  bands: Surface | null,
  shown: () => void,
): RunningWater | undefined {
  const gl = canvas.getContext("webgl", { antialias: false }) as WebGLRenderingContext | null;
  if (!gl) return undefined;
  const copy = bands?.getContext("2d") ?? null;
  const shader = (type: number, source: string) => {
    const created = gl.createShader(type);
    if (!created) return undefined;
    gl.shaderSource(created, source);
    gl.compileShader(created);
    return created;
  };
  const program = gl.createProgram();
  const vertex = shader(gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!program || !vertex || !fragment) return undefined;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  let stage: "compiling" | "ready" | "failed" = "compiling";
  /** How far the program has got: still compiling, ready to draw with, or never going to be. */
  const link = () => {
    if (stage !== "compiling") return stage;
    if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) return stage;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      stage = "failed";
      return stage;
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    stage = "ready";
    return stage;
  };
  // No blending: one pass over a cleared canvas, so the dot opacity is written as is.
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  let state: WaterState | undefined;
  let cancel = () => {};
  let first = true;
  // The water's own clock, advanced at the theme's speed, so a speed change (on a theme
  // switch) changes the pace smoothly instead of jumping to a different moment.
  let clock = 7;
  let last = 0;
  const draw = (now: number) => {
    if (!state) return;
    const stage = link();
    if (stage === "failed") return;
    // Still compiling: ask again next frame rather than wait.
    if (stage === "compiling") {
      cancel = nextFrame(draw);
      return;
    }
    const { water, still, width, height } = state;
    if (last) clock += (Math.min(now - last, 100) / 1000) * water.speed;
    last = now;
    for (const surface of bands ? [canvas, bands] : [canvas]) {
      if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
      }
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    copy?.clearRect(0, 0, width, height);
    if (water.mode === undefined) return;
    gl.uniform2f(uniform("size"), width, height);
    // Starts part-way in (7s), so raindrops are already falling on the first view.
    gl.uniform1f(uniform("time"), still ? 7 : clock);
    gl.uniform3f(uniform("tint"), ...water.tint);
    gl.uniform1f(uniform("strength"), water.strength);
    gl.uniform1f(uniform("mode"), water.mode);
    gl.uniform1f(uniform("coverage"), water.coverage);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // In the same frame, before the canvas is shown and its drawing cleared.
    copy?.drawImage(canvas, 0, 0);
    if (first) {
      first = false;
      shown();
    }
    if (!still) cancel = nextFrame(draw);
  };
  return {
    update(next) {
      state = next;
      cancel();
      last = 0;
      if (!next.hidden) cancel = nextFrame(draw);
    },
    stop() {
      cancel();
      state = undefined;
    },
  };
}
