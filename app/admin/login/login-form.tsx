"use client";

import { useActionState } from "react";
import { login } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, null);
  return (
    <form action={action} className="stack">
      <label>
        Password
        <input type="password" name="password" required autoFocus autoComplete="current-password" />
      </label>
      <button className="btn" disabled={pending}>{pending ? "Checking…" : "Log in"}</button>
      {state && !state.ok && <p className="error">{state.message}</p>}
    </form>
  );
}
