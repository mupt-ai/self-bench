import { useEffect, useRef } from "react";
import { motionOff } from "../motion";
import { bayer } from "./dither";
import { select } from "./marks";

/** Size of one dither dot, in CSS pixels. */
const CELL = 2;
/** How long the aura takes to rev up; matches the card's preview rows coming in. */
const REV_MS = 520;
const TRAIL_MS = 180;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  kind: "star" | "streak";
}

/**
 * A dithered aura around the pointer while it is over a repository card (marked `card`). While
 * the card's preview comes in the aura sputters and throws off little stars and streaks, like
 * a cartoon dust cloud; once it has revved up it holds as a steady ring that leaves a short,
 * quickly fading trail, and moving throws off the odd spark. Off for touch, when animations
 * are off, for visitors who prefer less motion, and when the root
 * element sets `data-aura="off"`.
 */
export function CursorAura() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const root = document.documentElement;
    let card: Element | undefined;
    let pointer = { x: 0, y: 0 };
    let rev = 0;
    let level = 0;
    let revved = false;
    let particles: Particle[] = [];
    let trail: { x: number; y: number; at: number }[] = [];
    // Where the trail last grew; kept apart from the trail so a still pointer adds nothing.
    let trailFrom = { x: 0, y: 0 };
    let colour = "rgb(0 0 0)";
    let frame = 0;
    let last = 0;

    const spawn = (count: number, speed: number) => {
      for (let index = 0; index < count; index++) {
        const angle = Math.random() * Math.PI * 2;
        const velocity = speed * (0.5 + Math.random());
        particles.push({
          x: pointer.x + Math.cos(angle) * 5,
          y: pointer.y + Math.sin(angle) * 5,
          vx: Math.cos(angle) * velocity,
          vy: Math.sin(angle) * velocity,
          age: 0,
          life: 200 + Math.random() * 200,
          kind: Math.random() < 0.45 ? "star" : "streak",
        });
      }
    };

    const dot = (x: number, y: number, chance: number) => {
      const cx = Math.round(x / CELL);
      const cy = Math.round(y / CELL);
      if (bayer(cx, cy) < chance) context.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    };

    /** A ring of grain around (x, y): thin at the centre so the pointer stays visible. */
    const ring = (x: number, y: number, radius: number, strength: number) => {
      const cells = Math.ceil(radius / CELL);
      const ox = Math.round(x / CELL);
      const oy = Math.round(y / CELL);
      for (let dy = -cells; dy <= cells; dy++) {
        for (let dx = -cells; dx <= cells; dx++) {
          const d = Math.hypot(dx, dy) / cells;
          if (d > 1) continue;
          const shape = Math.exp(-(((d - 0.55) / 0.28) ** 2));
          if (bayer(ox + dx, oy + dy) < shape * strength)
            context.fillRect((ox + dx) * CELL, (oy + dy) * CELL, CELL, CELL);
        }
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(50, last ? now - last : 16);
      last = now;
      if (element.width !== window.innerWidth || element.height !== window.innerHeight) {
        element.width = window.innerWidth;
        element.height = window.innerHeight;
      }
      context.clearRect(0, 0, element.width, element.height);
      context.fillStyle = colour;
      // Light dots drawn densely: soft, not a sparse checkerboard.
      context.globalAlpha = 0.2;

      if (card) {
        rev = Math.min(1, rev + dt / REV_MS);
        // Until revved, the trail has not started: keep its start under the pointer, so the
        // first trail mark is not left behind at the spot where the pointer entered the card.
        if (!revved) trailFrom = { ...pointer };
        if (rev < 1) {
          // Revving: a smooth build-up; the thrown-off bits carry the sputter.
          level = rev * 0.85;
          // No sparks in the first moments, while the pointer is still crossing the card edge.
          if (rev > 0.3 && Math.random() < 0.2 + rev * 0.4) spawn(1, 70);
        } else {
          if (!revved) spawn(8, 110);
          revved = true;
          // Settled: steady, no breathing; sparks only come from moving.
          level = 0.85;
          if (Math.hypot(trailFrom.x - pointer.x, trailFrom.y - pointer.y) > 6) {
            trail.push({ ...trailFrom, at: now });
            trailFrom = { ...pointer };
          }
        }
      } else {
        level = Math.max(0, level - dt / 160);
      }

      trail = trail.filter((point) => now - point.at < TRAIL_MS);
      for (const point of trail) {
        // Trail right under the ring would only flicker its density; draw only what is left behind.
        if (Math.hypot(point.x - pointer.x, point.y - pointer.y) < 10) continue;
        ring(point.x, point.y, 9, 0.8 * (1 - (now - point.at) / TRAIL_MS));
      }
      if (level > 0) ring(pointer.x, pointer.y, 12 + rev * 3, level);

      particles = particles.filter((particle) => particle.age < particle.life);
      for (const particle of particles) {
        particle.age += dt;
        const drag = 0.9 ** (dt / 16);
        particle.vx *= drag;
        particle.vy *= drag;
        particle.x += (particle.vx * dt) / 1000;
        particle.y += (particle.vy * dt) / 1000;
        const left = 1 - particle.age / particle.life;
        if (particle.kind === "star") {
          const arm = 1;
          dot(particle.x, particle.y, left + 0.2);
          for (let step = 1; step <= arm; step++) {
            dot(particle.x + step * CELL, particle.y, left);
            dot(particle.x - step * CELL, particle.y, left);
            dot(particle.x, particle.y + step * CELL, left);
            dot(particle.x, particle.y - step * CELL, left);
          }
        } else {
          const speed = Math.hypot(particle.vx, particle.vy) || 1;
          for (let step = 0; step < 3; step++) {
            dot(
              particle.x - (particle.vx / speed) * step * CELL,
              particle.y - (particle.vy / speed) * step * CELL,
              left - step * 0.2,
            );
          }
        }
      }

      if (card || level > 0 || particles.length || trail.length)
        frame = requestAnimationFrame(draw);
      else {
        frame = 0;
        last = 0;
      }
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch" || root.dataset.aura === "off" || motionOff()) {
        card = undefined;
        return;
      }
      const next = (event.target as Element | null)?.closest(select.card) ?? undefined;
      if (next === card) return;
      card = next;
      // The pointer's own position on entry; the last move may have been outside the card.
      pointer = { x: event.clientX, y: event.clientY };
      rev = 0;
      revved = false;
      trailFrom = { ...pointer };
      if (card) {
        // Resolve the theme's --aura mix to a concrete colour the canvas understands.
        const probe = document.createElement("span");
        probe.style.color = "var(--aura)";
        root.append(probe);
        colour = getComputedStyle(probe).color;
        probe.remove();
        wake();
      }
    };
    const move = (event: PointerEvent) => {
      const travelled = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
      pointer = { x: event.clientX, y: event.clientY };
      // Moving throws off the odd spark.
      if (card && revved && travelled > 3 && Math.random() < Math.min(0.5, travelled / 40)) {
        spawn(1, 60);
        wake();
      }
    };
    const leave = () => {
      card = undefined;
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);
  return <canvas ref={canvas} className="pointer-events-none fixed inset-0 z-20 h-full w-full" />;
}
