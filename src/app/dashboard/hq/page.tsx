import Link from "next/link";
import { redirect } from "next/navigation";
import { Wallet, ClipboardList, Users, Sparkles, ExternalLink, UserPlus, Eye, Activity, Send, MessageCircle } from "lucide-react";
import { db, currentSession, listBusinesses } from "@/lib/supabase";
import { getTwilioUsage, getTwilioDelivery } from "@/lib/twilio-usage";
import { getUptimeStatus } from "@/lib/uptime";
import { loadWaitlistLeads } from "../waitlist/data";
import { WaitlistPanel } from "../waitlist/WaitlistClient";
import { switchBusiness } from "../actions";
import type { AuthorizedPhone } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "HQ" };

function usd(n: number | null, currency = "USD"): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${n.toFixed(2)}`;
}
function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export default async function HqPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");

  // Everything the command center shows, in parallel.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [usage, delivery, uptime, leads, businesses, phonesRes, inboundRes, weekRes] = await Promise.all([
    getTwilioUsage(),
    getTwilioDelivery(),
    getUptimeStatus(),
    loadWaitlistLeads(),
    listBusinesses(),
    db().from("authorized_phones").select("*"),
    db().from("messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", monthStart.toISOString()),
    db().from("messages").select("from_phone").eq("direction", "inbound").gte("created_at", weekStart),
  ]);

  // Engagement this week: how many texts came in, from how many distinct people.
  const weekRows = (weekRes.data ?? []) as { from_phone: string | null }[];
  const weekTexts = weekRows.length;
  const activePeople = new Set(weekRows.map((r) => r.from_phone).filter(Boolean)).size;

  const phones = (phonesRes.data ?? []) as AuthorizedPhone[];
  const operators = businesses.map((b) => {
    const primary = phones.find((p) => p.business_id === b.id && p.is_primary) ?? phones.find((p) => p.business_id === b.id);
    return { id: b.id, name: b.name, owner: b.owner_name, phone: primary ? fmtPhone(primary.phone) : "—" };
  });

  const inbound = inboundRes.count ?? 0;
  const aiEstimate = inbound * 0.0025;

  const newCount = leads.filter((l) => l.status === "new").length;
  const activeCount = leads.filter((l) => l.status === "active").length;
  const lowBalance = usage.balance != null && usage.balance < 10;

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Field<span className="text-brand">Text</span> HQ
        </h1>
        <p className="text-sm text-gray-500">
          {leads.length} signups · {newCount} new · {activeCount} active
        </p>
      </header>

      {/* ── Site status ───────────────────────────────────────── */}
      <SiteStatus uptime={uptime} />

      {/* ── Activity + delivery ───────────────────────────────── */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <span className="flex items-center gap-2 text-sm font-medium text-gray-700"><MessageCircle className="h-4 w-4 text-brand-dark" /> Activity, last 7 days</span>
          <div className="mt-2 flex gap-6">
            <div>
              <p className="text-2xl font-bold tracking-tight text-gray-900">{weekTexts}</p>
              <p className="text-xs text-gray-500">texts in</p>
            </div>
            <div>
              <p className="text-2xl font-bold tracking-tight text-gray-900">{activePeople}</p>
              <p className="text-xs text-gray-500">active {activePeople === 1 ? "person" : "people"}</p>
            </div>
          </div>
        </div>
        <TextDelivery d={delivery} />
      </section>

      {/* ── Costs ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold text-gray-900"><Wallet className="h-4 w-4 text-brand-dark" /> Costs</h2>
          <Link href="/dashboard/costs" className="text-xs font-medium text-brand hover:underline">Full breakdown →</Link>
        </div>
        {!usage.ok && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Couldn&apos;t reach Twilio just now — reload in a minute.</p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Balance left" value={usd(usage.balance, usage.currency)} tone={lowBalance ? "warn" : "brand"} />
          <Stat label="Twilio, month" value={usd(usage.monthSpend, usage.currency)} />
          <Stat label="Twilio, today" value={usd(usage.todaySpend, usage.currency)} />
          <Stat label="AI, month" value={`≈ ${usd(aiEstimate)}`} />
        </div>
        {lowBalance && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            ⚠️ Twilio balance is under $10 — top up before it runs dry and texts stop sending.
          </p>
        )}
        <p className="text-xs text-gray-400">
          AI is a rough estimate from {inbound} texts parsed this month · exact at{" "}
          <a href="https://console.anthropic.com/settings/usage" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand underline">console.anthropic.com <ExternalLink className="h-3 w-3" /></a>
        </p>
      </section>

      {/* ── Waitlist ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-gray-900"><ClipboardList className="h-4 w-4 text-brand-dark" /> Beta waitlist</h2>
        <WaitlistPanel leads={leads} />
      </section>

      {/* ── Operators ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold text-gray-900"><Users className="h-4 w-4 text-brand-dark" /> Operators ({operators.length})</h2>
          <Link href="/dashboard/admin" className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"><UserPlus className="h-3.5 w-3.5" /> Register</Link>
        </div>
        {operators.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400">No live operators yet. Invite someone from the waitlist, then Register them.</p>
        ) : (
          <div className="divide-y divide-gray-50 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
            {operators.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-gray-900">{o.name}</p>
                  <p className="truncate text-xs text-gray-500">{o.owner} · {o.phone}</p>
                </div>
                <form action={switchBusiness}>
                  <input type="hidden" name="businessId" value={o.id} />
                  <button className="flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:border-brand/40"><Eye className="h-4 w-4" /> Open book</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center justify-center gap-2 pt-2 text-xs text-gray-400">
        <Sparkles className="h-3.5 w-3.5" /> This is your command center. Bookmark <span className="font-medium text-gray-500">/dashboard/hq</span>.
      </div>
    </main>
  );
}

function SiteStatus({ uptime }: { uptime: import("@/lib/uptime").UptimeStatus }) {
  // Not connected yet → a gentle nudge with the setup path.
  if (!uptime.configured) {
    return (
      <section className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-3">
        <span className="flex items-center gap-2 text-sm text-gray-500"><Activity className="h-4 w-4" /> Site monitoring not connected</span>
        <span className="text-xs text-gray-400">Add UPTIMEROBOT_API_KEY in Vercel to see uptime here</span>
      </section>
    );
  }

  const dot = { up: "bg-green-500", down: "bg-red-500", paused: "bg-gray-400", pending: "bg-amber-400", unknown: "bg-gray-300" }[uptime.state];
  const word = { up: "Online", down: "DOWN", paused: "Paused", pending: "Starting up", unknown: "Unknown" }[uptime.state];
  const isDown = uptime.state === "down";

  return (
    <section className={`rounded-2xl border p-4 shadow-sm ${isDown ? "border-red-200 bg-red-50" : "border-gray-100 bg-white"}`}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Activity className="h-4 w-4 text-brand-dark" /> Site status
        </span>
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />{word}
        </span>
      </div>
      {uptime.ok ? (
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>7-day uptime <span className="font-semibold text-gray-800">{uptime.uptime7d != null ? `${uptime.uptime7d.toFixed(2)}%` : "—"}</span></span>
          <span>30-day <span className="font-semibold text-gray-800">{uptime.uptime30d != null ? `${uptime.uptime30d.toFixed(2)}%` : "—"}</span></span>
          <span>Response <span className="font-semibold text-gray-800">{uptime.avgResponseMs != null ? `${uptime.avgResponseMs} ms` : "—"}</span></span>
        </div>
      ) : (
        <p className="mt-1 text-xs text-amber-700">Couldn&apos;t reach UptimeRobot just now — reload in a minute.</p>
      )}
    </section>
  );
}

function TextDelivery({ d }: { d: import("@/lib/twilio-usage").TwilioDelivery }) {
  if (!d.ok) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-700"><Send className="h-4 w-4 text-brand-dark" /> Text delivery, last 7 days</span>
        <p className="mt-2 text-xs text-amber-700">Couldn&apos;t reach Twilio just now — reload in a minute.</p>
      </div>
    );
  }
  const hasFailures = d.failed > 0;
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${hasFailures ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-white"}`}>
      <span className="flex items-center gap-2 text-sm font-medium text-gray-700"><Send className="h-4 w-4 text-brand-dark" /> Text delivery, last 7 days</span>
      {d.outbound === 0 ? (
        <p className="mt-2 text-sm text-gray-400">No texts sent yet this week.</p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <p className="text-2xl font-bold tracking-tight text-gray-900">{d.deliveryRate != null ? `${d.deliveryRate.toFixed(0)}%` : "—"}</p>
            <p className="text-xs text-gray-500">got through · {d.outbound} sent</p>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {d.failed === 0 ? (
              <span className="text-green-700">No failures 🎉</span>
            ) : (
              <span className="font-medium text-amber-800">{d.failed} failed{d.topError ? ` · top error ${d.topError.code}` : ""}</span>
            )}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "brand" | "warn" }) {
  const border = tone === "warn" ? "border-amber-200 bg-amber-50" : tone === "brand" ? "border-brand/25 bg-brand/5" : "border-gray-100 bg-white";
  const labelColor = tone === "warn" ? "text-amber-700" : tone === "brand" ? "text-brand-dark" : "text-gray-500";
  return (
    <div className={`rounded-2xl border p-3 shadow-sm ${border}`}>
      <span className={`text-xs font-medium ${labelColor}`}>{label}</span>
      <p className="mt-0.5 text-xl font-bold tracking-tight text-gray-900">{value}</p>
    </div>
  );
}
