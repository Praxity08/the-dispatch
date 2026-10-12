// The Dispatch: floating leaves and bubbles behind the dashboard.
// Pure CSS animation (styles in dispatch-theme.css), server-rendered, honours reduced motion.
import type { CSSProperties } from "react";

const BUB = ["#E3EAF4", "#ECE4F3", "#F5E1DE", "#F7EDCD"];
const LEAF = [["#CFE3C2", "#A8CB98"], ["#DCEBD3", "#B5D3A6"], ["#F8D9C4", "#EDB898"], ["#F7E3B4", "#E6C46A"], ["#F2D0C9", "#E3A99E"]];

type Item = { kind: "leaf" | "bubble"; left: number; sx: number; c1: string; c2: string; size: number; dur: number; delay: number; r: number; anim: number };

/** Same layout on server and client (seeded random), so hydration never mismatches. */
function items(): Item[] {
  let x = 7;
  const rnd = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  const kinds = [...Array(18).fill("leaf"), ...Array(12).fill("bubble")] as Item["kind"][];
  return kinds.map((kind, k) => {
    const left = (k * 37 + rnd() * 18) % 100;
    const sx = Math.round(rnd() * 30 + 20);
    if (kind === "leaf") {
      const [c1, c2] = LEAF[Math.floor(rnd() * LEAF.length)];
      const size = 18 + rnd() * 22;
      const dur = 26 + rnd() * 22;
      return { kind, left, sx, c1, c2, size, dur, delay: -rnd() * dur, r: Math.round(rnd() * 360), anim: 6 + rnd() * 5 };
    }
    const c1 = BUB[Math.floor(rnd() * BUB.length)];
    const size = 12 + rnd() * 36;
    const dur = 40 + rnd() * 30;
    return { kind, left, sx, c1, c2: "", size, dur, delay: -rnd() * dur, r: 0, anim: 7 + rnd() * 6 };
  });
}

const css = (o: Record<string, string | number>) => o as CSSProperties;

export function FloatingBackground() {
  return (
    <div className="dsp-bg" aria-hidden="true">
      {items().map((it, k) => (
        <div key={k} className={`dsp-f ${it.kind}`} style={css({ left: `${it.left}%`, "--d": `${it.dur}s`, "--dl": `${it.delay}s` })}>
          <span
            style={css({
              width: it.size,
              height: it.kind === "leaf" ? it.size * 1.15 : it.size,
              background:
                it.kind === "leaf"
                  ? `linear-gradient(135deg, transparent 47%, ${it.c2} 48%, ${it.c2} 52%, transparent 53%), linear-gradient(135deg, ${it.c1}, ${it.c2})`
                  : `radial-gradient(circle at 32% 30%, rgba(255,255,255,.9), ${it.c1} 60%)`,
              "--a": `${it.anim}s`,
              "--sx": `${it.sx}px`,
              "--r": `${it.r}deg`,
            })}
          />
        </div>
      ))}
    </div>
  );
}
