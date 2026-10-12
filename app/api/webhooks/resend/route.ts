import { handleResendEvent, verifyResendSignature } from "@/lib/resend-webhook";

export const dynamic = "force-dynamic";

/** Resend delivery events (only used when EMAIL_PROVIDER=resend). Point the Resend webhook here. */
export async function POST(req: Request) {
  const body = await req.text();
  const headers = { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") };
  if (!verifyResendSignature(process.env.RESEND_WEBHOOK_SECRET ?? "", headers, body)) {
    return new Response("Invalid signature", { status: 401 });
  }
  return Response.json(await handleResendEvent(headers.id!, JSON.parse(body)));
}
