"use client";

import { useActionState } from "react";
import { subscribe } from "./subscribe-action";

export function SubscribeForm() {
  const [state, action, pending] = useActionState(subscribe, null);
  if (state?.ok) return <p className="ok">{state.message}</p>;
  return (
    <form action={action} className="inline-form" id="subscribe">
      <input type="email" name="email" placeholder="you@company.com" required aria-label="Email address" />
      {/* Honeypot: real people never see or fill this. */}
      <input type="text" name="company_website" tabIndex={-1} autoComplete="off" className="hp" aria-hidden="true" />
      <button className="btn" disabled={pending}>{pending ? "Subscribing…" : "Subscribe"}</button>
      {state && !state.ok && <p className="error">{state.message}</p>}
    </form>
  );
}
