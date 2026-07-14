import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Flag, ScrollText } from "lucide-react";
import { db, currentSession, listBusinesses } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const metadata = { title: "Message logs" };

type Msg = {
  id: string;
  business_id: string;
  direction: "inbound" | "outbound";
  body: string;
  parsed_intent: string | null;
  created_at: string;
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** ADMIN ONLY: per-operator SMS transcript + recent flags across everyone. */
export default async function LogsPage({ searchParams }: { searchParams: { biz?: string } }) {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");

  const businesses = await listBusinesses();
  const bizId = searchParams.biz && businesses.some((b) => b.id === searchParams.biz)
    ? searchParams.biz
    : businesses[0]?.id;
  const nameOf = (id: string) => businesses.find((b) => b.id === id)?.name ?? "?";

  const [{ data: msgRows }, { data: flagRows }] = await Promise.all([
    bizId
      ? db().from("messages").select("id, business_id, direction, body, parsed_intent, created_at")
          .eq("business_id", bizId).order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as Msg[] }),
    db().from("messages").select("id, business_id, direction, body, parsed_intent, created_at")
      .eq("parsed_intent", "flag").order("created_at", { ascending: false }).limit(10),
  ]);
  const msgs = ((msgRows ?? []) as Msg[]).slice().reverse();
  const flags = (flagRows ?? []) as Msg[];

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex items-center gap-3">
        <Link href="/dashboard/hq" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900"><ScrollText className="h-5 w-5 text-brand-dark" /> Message logs</h1>
          <p className="text-sm text-gray-500">Every text in and out, per operator. Flags show what testers hit.</p>
        </div>
      </header>

      {/* Recent flags across all operators */}
      {flags.length > 0 && (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-red-800"><Flag className="h-4 w-4" /> Recent flags</p>
          <div className="space-y-1.5">
            {flags.map((f) => (
              <Link key={f.id} href={`/dashboard/logs?biz=${f.business_id}`} className="block rounded-lg bg-white px-3 py-2 text-sm text-gray-800 shadow-sm hover:bg-gray-50">
                <span className="font-medium">{nameOf(f.business_id)}</span>
                <span className="text-gray-400"> · {fmtTime(f.created_at)}</span>
                <span className="block text-gray-600">{f.body.slice(0, 140)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Operator picker */}
      <div className="flex flex-wrap gap-2">
        {businesses.map((b) => (
          <Link
            key={b.id}
            href={`/dashboard/logs?biz=${b.id}`}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${b.id === bizId ? "bg-brand text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {b.name}
          </Link>
        ))}
      </div>

      {/* Transcript: operator texts on the right (green), FieldText replies on the left */}
      <section className="space-y-2 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        {msgs.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No messages yet for {bizId ? nameOf(bizId) : "this operator"}.</p>
        ) : (
          msgs.map((m) => {
            const isFlag = m.parsed_intent === "flag";
            const mine = m.direction === "inbound"; // the operator's own text
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? "rounded-br-sm bg-brand text-white" : "rounded-bl-sm bg-gray-100 text-gray-800"} ${isFlag ? "ring-2 ring-red-400" : ""}`}>
                  {isFlag && <span className="mr-1">🚩</span>}
                  <span className="whitespace-pre-wrap">{m.body}</span>
                  <span className={`mt-0.5 block text-[10px] ${mine ? "text-white/70" : "text-gray-400"}`}>
                    {fmtTime(m.created_at)}{m.parsed_intent && !mine ? "" : m.parsed_intent ? ` · ${m.parsed_intent}` : ""}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
