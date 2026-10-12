"use client";

import { useActionState } from "react";
import { login } from "../actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, null);
  return (
    <main className="narrow">
      <p className="eyebrow">The Dispatch</p>
      <h1>Editor login</h1>
      <form action={action} className="stack">
        <label>
          Password
          <input type="password" name="password" required autoFocus autoComplete="current-password" />
        </label>
        <button className="btn" disabled={pending}>{pending ? "Checking…" : "Log in"}</button>
        {state && !state.ok && <p className="error">{state.message}</p>}
      </form>
    </main>
  );
}
