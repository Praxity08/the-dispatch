import { unsubscribe, verifyUnsubscribeToken } from "@/lib/subscribers";

export const dynamic = "force-dynamic";

function parse(req: Request) {
  const url = new URL(req.url);
  return { id: Number(url.searchParams.get("s")), token: url.searchParams.get("t") ?? "" };
}

/** RFC 8058 one-click unsubscribe: Gmail / Apple Mail POST here from their "Unsubscribe" button. */
export async function POST(req: Request) {
  const { id, token } = parse(req);
  if (!id || !verifyUnsubscribeToken(id, token)) return new Response("Invalid link", { status: 400 });
  await unsubscribe(id, "one-click");
  return new Response("You have been unsubscribed from The Dispatch.");
}

/** A plain GET (link prefetchers, curious clicks) never unsubscribes; it goes to the confirmation page. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  return Response.redirect(new URL(`/unsubscribe${url.search}`, url.origin), 303);
}
