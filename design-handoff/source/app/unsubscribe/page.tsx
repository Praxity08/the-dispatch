import { getSubscriber, maskEmail, unsubscribe, verifyUnsubscribeToken } from "@/lib/subscribers";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ s?: string; t?: string; done?: string; test?: string }> };

async function confirmUnsubscribe(formData: FormData) {
  "use server";
  const id = Number(formData.get("s"));
  const token = String(formData.get("t") ?? "");
  if (id && verifyUnsubscribeToken(id, token)) await unsubscribe(id, "link");
  const { redirect } = await import("next/navigation");
  redirect(`/unsubscribe?s=${id}&t=${encodeURIComponent(token)}&done=1`);
}

export default async function UnsubscribePage({ searchParams }: Props) {
  const { s, t, done, test } = await searchParams;
  if (test) {
    return <Shell title="Test email">This is the unsubscribe link from a test send. It doesn&apos;t do anything.</Shell>;
  }
  const id = Number(s);
  const valid = !!id && !!t && verifyUnsubscribeToken(id, t);
  const subscriber = valid ? await getSubscriber(id) : undefined;
  if (!subscriber) return <Shell title="Link not valid">This unsubscribe link is invalid or has expired.</Shell>;

  if (done || subscriber.status === "unsubscribed") {
    return (
      <Shell title="You're unsubscribed">
        {maskEmail(subscriber.email)} won&apos;t receive The Dispatch any more. Changed your mind? <a href="/#subscribe">Subscribe again</a>.
      </Shell>
    );
  }
  return (
    <Shell title="Unsubscribe from The Dispatch?">
      <p>Stop sending the weekly newsletter to {maskEmail(subscriber.email)}.</p>
      <form action={confirmUnsubscribe}>
        <input type="hidden" name="s" value={id} />
        <input type="hidden" name="t" value={t} />
        <button type="submit" className="btn">Unsubscribe</button>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="narrow">
      <p className="eyebrow">The Dispatch</p>
      <h1>{title}</h1>
      <div className="muted">{children}</div>
    </main>
  );
}
