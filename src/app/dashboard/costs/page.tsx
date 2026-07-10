import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Wallet, MessageSquare, Sparkles, ExternalLink } from "lucide-react";
import { db, currentSession } from "@/lib/supabase";
import { getTwilioUsage } from "@/lib/twilio-usage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Costs" };

function usd(n: number | null, currency = "USD"): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${n.toFixed(2)}`;
}

export default async function CostsPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");

  const usage = await getTwilioUsage();

  // Rough AI (Anthropic) estimate from our own logs: each inbound text is one
  // Claude parse. Haiku pricing on a typical parse lands near ~$0.0025.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count: inboundCount } = await db()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "inbound")
    .gte("created_at", monthStart.toISOString());
  const aiEstimate = inboundCount != null ? inboundCount * 0.0025 : null;

  const fetched = new Date(usage.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex items-center gap-3">
        <Link href="/dashboard" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Costs</h1>
          <p className="text-sm text-gray-500">Live from Twilio · updated {fetched}</p>
        </div>
      </header>

      {!usage.ok && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Couldn&apos;t reach Twilio just now. Check that TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set in Vercel, then reload.
        </p>
      )}

      {/* Twilio headline numbers */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat icon={<Wallet className="h-4 w-4" />} label="Balance left" value={usd(usage.balance, usage.currency)} tone="brand" />
        <Stat icon={<MessageSquare className="h-4 w-4" />} label="Spent this month" value={usd(usage.monthSpend, usage.currency)} />
        <Stat icon={<MessageSquare className="h-4 w-4" />} label="Spent today" value={usd(usage.todaySpend, usage.currency)} />
      </section>

      {/* This-month breakdown */}
      <section>
        <h2 className="mb-2 text-base font-bold text-gray-900">Twilio this month, by type</h2>
        <div className="divide-y divide-gray-50 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          {usage.lines.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400">No usage recorded this month yet.</p>
          ) : (
            usage.lines.map((l) => (
              <div key={l.category} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate text-gray-700">{l.label}{l.count > 0 && <span className="text-gray-400"> · {l.count.toLocaleString()}</span>}</span>
                <span className="shrink-0 font-medium text-gray-900">{usd(l.price, usage.currency)}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* AI estimate */}
      <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <Sparkles className="h-4 w-4 text-brand-dark" /> AI (Anthropic), this month
          </span>
          <span className="font-semibold text-gray-900">≈ {usd(aiEstimate)}</span>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Rough estimate from {inboundCount ?? 0} texts parsed this month. Anthropic isn&apos;t a live feed —
          see exact spend at{" "}
          <a href="https://console.anthropic.com/settings/usage" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand underline">
            console.anthropic.com <ExternalLink className="h-3 w-3" />
          </a>.
        </p>
      </section>

      <p className="text-center text-xs text-gray-400">
        Full Twilio detail lives at{" "}
        <a href="https://console.twilio.com/us1/monitor/usage/summary" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand underline">
          Twilio · Monitor · Usage <ExternalLink className="h-3 w-3" />
        </a>. Numbers cached up to 3 minutes.
      </p>
    </main>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "brand" }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${tone === "brand" ? "border-brand/25 bg-brand/5" : "border-gray-100 bg-white"}`}>
      <span className={`flex items-center gap-1.5 text-xs font-medium ${tone === "brand" ? "text-brand-dark" : "text-gray-500"}`}>
        {icon} {label}
      </span>
      <p className="mt-1 text-2xl font-bold tracking-tight text-gray-900">{value}</p>
    </div>
  );
}
