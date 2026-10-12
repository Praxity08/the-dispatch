import { samplePasswords } from "@/lib/admin";
import { FloatingBackground } from "../../floating-background";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const sample = samplePasswords();
  return (
    <>
    <FloatingBackground />
    <main className="narrow login">
      <a href="/" className="login-logo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/dispatch-logo.png" alt="The Dispatch — India's startup brief" />
      </a>
      <p className="eyebrow">Editor</p>
      <h1>Editor login</h1>
      <LoginForm />
      {sample && (
        <p className="hint-bubble" role="note">
          This is a sample site, so the password is shown: <code>{sample.editor}</code>
        </p>
      )}
    </main>
    </>
  );
}
