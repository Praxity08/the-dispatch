"use client";

import { useEffect } from "react";
import { flushSync } from "react-dom";

export const THEME_KEY = "dispatch-theme";
type Theme = "light" | "dark";

/** Runs in <head> before first paint, so a saved choice never flashes the other theme. */
export const themeBootScript = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;

const effectiveTheme = (): Theme =>
  document.documentElement.dataset.theme === "dark" ||
  (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";

function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null; // private mode or blocked storage: fall back to the system setting
  }
}

/** Light / dark switch. The new theme spreads out from the button as a circle where the browser supports it. */
export function ThemeToggle({ floating = false, rail = false }: { floating?: boolean; rail?: boolean }) {
  // Until she picks one, follow the system setting live.
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      if (!savedTheme()) document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    mq.addEventListener("change", follow);
    return () => mq.removeEventListener("change", follow);
  }, []);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    const next: Theme = effectiveTheme() === "dark" ? "light" : "dark";
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = next;
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // the switch still works for this page view
      }
    };

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return apply();

    // No View Transitions support: a quick colour cross-fade instead.
    if (!document.startViewTransition) {
      root.classList.add("theme-fading");
      apply();
      window.setTimeout(() => root.classList.remove("theme-fading"), 450);
      return;
    }

    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || box.left + box.width / 2;
    const y = e.clientY || box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(() => flushSync(apply));
    transition.ready
      .then(() =>
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 560, easing: "cubic-bezier(.4, 0, .2, 1)", pseudoElement: "::view-transition-new(root)" },
        ),
      )
      .catch(() => {});
  }

  return (
    <button type="button" className={`theme-toggle${floating ? " floating" : ""}${rail ? " rail-item" : ""}`} onClick={toggle} aria-label="Switch between light and dark mode">
      <span className="tt-icon rail-icon tone-neutral" aria-hidden="true">
      <svg className="icon-moon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" fill="currentColor" />
      </svg>
      <svg className="icon-sun" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
        </g>
      </svg>
      </span>
      <span className="tt-label rail-label">
        <span className="label-dark">Dark mode</span>
        <span className="label-light">Light mode</span>
      </span>
    </button>
  );
}
