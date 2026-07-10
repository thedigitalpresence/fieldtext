/**
 * HIDDEN internal roadmap report — /dashboard/roadmap
 * Companion to /dashboard/audit (defects). This page = holes & what to ADD.
 * Compiled July 6, 2026 from a 4-agent deep dive: operator's-day feature gaps,
 * SMS conversation holes, growth/funnel, dashboard UX — plus live site probes.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/supabase";
import { Compass, Rocket, MessageSquareText, TrendingUp, Smartphone, Zap, Ban, ShieldCheck, CheckCircle2 } from "lucide-react";
import { Logo } from "@/app/Logo";

export const dynamic = "force-dynamic";
export const metadata = { title: "FieldText — Roadmap Deep Dive", robots: { index: false, follow: false } };

type Effort = "S" | "M" | "L";
type Item = { name: string; what: string; effort: Effort; note?: string };

const EFFORT_STYLE: Record<Effort, string> = {
  S: "bg-green-100 text-green-800",
  M: "bg-amber-100 text-amber-800",
  L: "bg-red-100 text-red-700",
};
const EFFORT_WORD: Record<Effort, string> = { S: "small", M: "medium", L: "large" };

const THEMES = [
  { Icon: Rocket, title: "From diary to a book that balances", body: "FieldText records what you tell it, but doesn't yet know what you're OWED. An active client at $200/mo generates zero expected money today — receivables are the single biggest upgrade." },
  { Icon: MessageSquareText, title: "A bot that can hear answers", body: "When FieldText asks “Which Garcia?”, your reply is parsed from scratch with no memory — every clarifying question is a dead end. Conversation memory unlocks a dozen fixes at once." },
  { Icon: TrendingUp, title: "A funnel that exists", body: "Three disconnected sites, two fake signup forms, no pricing anywhere. Right now the funnel converts 0% by construction — everything depends on you onboarding people by hand." },
  { Icon: Smartphone, title: "An app that feels installed", body: "No home-screen icon, no loading states, dead-feeling taps, 30 identical green avatars. One focused polish pass makes it feel like a real app from the truck." },
];

const START_HERE: { name: string; why: string; effort: Effort }[] = [
  { name: "Receivables — know who owes you automatically", why: "Every active client's billing cycle generates an expected charge; payments settle against it, partials leave a balance. “Who owes me?” becomes computed truth instead of memory. This is the feature the $50/mo testimonial will be about.", effort: "M" },
  { name: "Make both signup forms actually save (+ text you the lead)", why: "Netlify and Vercel forms both discard the signup at the moment of highest intent. Store it, ping your phone, onboard within the hour.", effort: "S" },
  { name: "Conversation memory (answer the bot's questions)", why: "Persist the pending question so “5 oak”, “1”, or “yes” resolves it. Fixes ambiguous names, missing amounts, and confirm-to-create in one mechanism.", effort: "M" },
  { name: "“Rained out — push today to Friday”", why: "One text bulk-shifts every stop due today. It rains weekly in season, and right now rain actively makes the app worse (overdue flags pile up).", effort: "S" },
  { name: "Home-screen app icon + install manifest", why: "Your whole distribution is “add to home screen from the truck” — today that gives a browser-default letter tile. Icon, splash, standalone mode: ~1 hour, transformative.", effort: "S" },
];

const QUICK_WINS: string[] = [
  "Stop “cancel/end/quit” from unsubscribing the operator — only STOP should opt out; “cancel” should ask “cancel what?”",
  "Prompt guardrail: “skip / reschedule / pause / expense / undo” must never map to remove-client or log-payment — reply honestly instead",
  "Prompt rule: “smiths are now $350” on an ACTIVE client = price correction, not a new quote (today it demotes them and restarts nudges)",
  "Fix “finished up at the smiths” reading back as “Removed Smiths from your list”",
  "Never save money to nobody: orphaned payments should say “not linked to a client — reply with the name”",
  "Wire up the unused didntCatch template (two copyable examples) instead of the generic help line on unparsed texts",
  "Add “Reply 'fix …' to correct” to every confirmation, not just quotes",
  "Pipeline: show Active before Quoted on mobile, and start day groups at TODAY, not Monday",
  "Contrast pass: gray-400 → gray-500 — readable in direct sunlight",
  "“Client since” shows the last-edited date, not the real start date — one-line fix",
];

const FEATURES: Item[] = [
  { name: "Invoice / receipt forward-links", what: "“invoice bob” texts you a link to a clean invoice page (your logo, balance, “Venmo @you / Zelle / cash”) that YOU forward from your own thread. FieldText never texts your customers — you stay the sender.", effort: "M", note: "Gets Venmo same-day instead of “end of month”" },
  { name: "Scheduled one-off jobs", what: "“mulch at the smiths next tuesday $450” — a dated, priced job that shows in Today and becomes money owed when done. Cleanups/mulch are the biggest tickets of the year and have nowhere to live today.", effort: "M" },
  { name: "Expenses + tax-year export", what: "“spent 84 on mulch at home depot” logs an expense; year-end gives your accountant one CSV: revenue by client, expenses by category, net. Pays for itself every April.", effort: "M" },
  { name: "Photos in the main text thread", what: "Text a receipt → expense. Before/after photos → attached to the client. Handwritten list → import drafts. The vision plumbing already exists for import; MMS is currently ignored.", effort: "M" },
  { name: "Crew day sheet", what: "Morning digest becomes an ordered route sheet — addresses, gate codes, one-offs — sent to every crew phone in that phone's language (Spanish crew, English owner).", effort: "M", note: "The Spanish-crew angle is a wedge competitors ignore" },
  { name: "“Paused” client status", what: "“pause the smiths until april” — off the schedule and MRR without destroying the record, with an auto-reminder to resume. Northern operators pause the whole book every winter.", effort: "S" },
  { name: "Client phone + email fields", what: "Capture in texts and import, tap-to-call on cards. Table stakes, and the prerequisite for invoices and referrals. Do it early — it's a data-model change.", effort: "S" },
  { name: "Price-increase assistant", what: "“raise all weekly clients $5 starting march” → preview (“12 clients — confirm?”) → done. Operators under-raise for years out of dread; one recouped increase dwarfs the subscription.", effort: "M" },
  { name: "Skip / reschedule / notes by text", what: "“skip the smiths this week”, “move garcia to friday”, “gate code 4412 at the smiths” — none exist today, and the nearest guesses can permanently rewrite schedules or remove clients.", effort: "L" },
  { name: "Voice notes from the truck", what: "Send an audio message; it's transcribed and parsed like any text. Hands are dirty, they're driving — and Spanish speech beats typing.", effort: "M" },
  { name: "Referral tracking", what: "“angela referred by bob” + a nudge to thank Bob when Angela signs. Referrals are basically all of this market's growth.", effort: "S" },
  { name: "“Book the season” nudge", what: "In Feb/Sept: “23 clients haven't booked spring cleanup — want the list?” Converts the book you already have into the year's biggest weeks.", effort: "S" },
];

const CONVERSATION: Item[] = [
  { name: "Undo / fix the last thing", what: "“undo” or “no it was 250” after a payment currently edits the CLIENT's quote amount, not the payment — and can't touch jobs or reminders at all. Track the last written record and target it.", effort: "M" },
  { name: "Real answers to real questions", what: "“when did bob last pay?”, “who hasn't paid this month?”, “what's my monday route?” — unanswerable today because the AI's context omits client names on payments and all job history. Enriching that context is prompt-side only.", effort: "S" },
  { name: "Welcome + first-log sequence", what: "A new operator's first interaction is silence. Send a welcome text with one copyable example: “Try: quoted Maria at 12 Elm St $200/mo”. Time-to-first-value under 3 minutes.", effort: "S" },
  { name: "Reminder times of day", what: "“remind me at 3pm” drops the 3pm (everything lands at 9am — and 9am UTC at that). Quote nudges fire at whatever hour the quote was logged, including 9:30pm.", effort: "M" },
  { name: "A help menu worth reading", what: "“help” returns one generic sentence. Make it a 4-line menu with a literal example per verb.", effort: "S" },
];

const GROWTH: Item[] = [
  { name: "Consolidate the three sites", what: "fieldtextapp.com shows a Squarespace “under construction” page; the Netlify marketing site links to nothing; the Vercel app's only button is a password wall. End state: fieldtextapp.com → marketing, app.fieldtextapp.com → dashboard, one privacy policy, one signup. Do it BEFORE A2P approval locks in your opt-in URL.", effort: "M", note: "Kill the Squarespace page today — it's your best URL saying you don't exist" },
  { name: "Verify eric@fieldtextapp.com receives mail", what: "It's the contact on your live legal pages and likely your A2P record. If Squarespace forwarding isn't configured, support and consent email is a black hole. Send a test email today.", effort: "S" },
  { name: "Put the price on the page", what: "“$49/mo — founding members $29/mo for life (first 10)”. Landscapers distrust hidden pricing; founding-member framing fills the pilot and creates urgency while staying ~3× marginal cost.", effort: "S" },
  { name: "Concierge import as the offer", what: "“Text me a photo of your notebook — your whole book is loaded by tomorrow.” The highest-converting pitch available to a solo founder, and the import tooling already exists.", effort: "S" },
  { name: "Try-it demo widget on the marketing page", what: "A fake texting conversation (pure front-end, uses your real reply templates). Converts skeptics before A2P approval, costs nothing per use.", effort: "M" },
  { name: "Monday digest + monthly “you made $X” text", what: "Weekly: open quotes worth $X. Monthly: collected $X, won 4 of 6 quotes — with a referral code (“have them text JOE — you both get a month free”). The monthly text is the screenshot that sells at the supply yard.", effort: "M" },
  { name: "60-second demo video", what: "Rain-wrinkled notebook → text from the truck cab → the follow-up nudge that didn't forget → the clean dashboard. Shot on a phone; authenticity beats polish for this buyer.", effort: "M" },
  { name: "Scale checkpoints", what: "~Client 5: a small admin page so onboarding isn't manual SQL. ~Client 10: per-business dashboard logins. ~Client 25: second Twilio number. Unit economics hold: ~$7–13 cost vs $50 price.", effort: "L", note: "Nothing to build today — calendar reminders" },
];

const POLISH: Item[] = [
  { name: "Buttons that respond", what: "No action shows a spinner or disables while saving — taps feel dead on truck LTE, and a double-tap on “Log payment” saves it twice. One shared submit-button component fixes all of it.", effort: "S" },
  { name: "Confirm + undo on destructive taps", what: "“Mark declined” instantly vanishes the client with no confirm, no toast, no undo, and no Lost view to find them again.", effort: "S" },
  { name: "Loading + error screens", what: "Every navigation shows a frozen frame until the database answers; an error shows Next.js's unstyled default. A skeleton and a branded retry page take ~30 minutes.", effort: "S" },
  { name: "Glove-sized tap targets", what: "The 44px rule exists in the code but ~10 controls skip it — including the three tiny reminder icons where Done and Cancel sit 4px apart.", effort: "S" },
  { name: "Drawer manners", what: "The client panel ignores Escape, scrolls the page behind it, traps no focus, and the phone's back-gesture exits the whole app instead of closing it.", effort: "S" },
  { name: "Import rough edges", what: "Switching Paste→Photo keeps the old file (a CSV can be submitted as a photo); typing “300/mo” in the amount box renders NaN; a failed save fails silently; success shows no confirmation.", effort: "S" },
  { name: "Spanish-length layout pass", what: "“Cerrar sesión” + the language toggle crush the business name at 360px; “Recordatorios esta semana” wraps to 3 lines in a half-width tile.", effort: "S" },
  { name: "Varied avatar colors", what: "Thirty identical green circles scan poorly — hash the name into 6–8 hue pairs so the roster reads at a glance.", effort: "S" },
];

const DONT_BUILD: { name: string; why: string }[] = [
  { name: "Texting your customers directly", why: "Changes compliance posture entirely (per-customer opt-in, A2P risk) and puts you in Jobber's territory where you lose. Forward-a-link invoices capture ~80% of the value at ~0% of the risk." },
  { name: "Payment processing / card-on-file", why: "This market runs on Venmo, Zelle, and cash — money already moves fine. Processing adds fees, KYC, and disputes. Show the Venmo handle; don't be a fintech." },
  { name: "Route optimization / maps", why: "5–30 stops the operator knows by heart. Day grouping + an ordered day sheet is enough. It demos well and retains nobody." },
  { name: "Payroll / time clock", why: "“paid miguel 600” as an expense category covers the real behavior. Payroll is a compliance tarpit." },
  { name: "Native mobile app / QuickBooks sync", why: "SMS + the web dashboard IS the app. CSV export satisfies accountants until demand proves otherwise." },
];

function ItemCard({ it }: { it: Item }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-snug text-gray-900">{it.name}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${EFFORT_STYLE[it.effort]}`}>{EFFORT_WORD[it.effort]}</span>
      </div>
      <p className="mt-1.5 text-sm leading-5 text-gray-600">{it.what}</p>
      {it.note && <p className="mt-1.5 text-xs font-medium text-brand-dark">→ {it.note}</p>}
    </div>
  );
}

function Section({ Icon, title, count, children }: { Icon: typeof Zap; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-5 w-5 text-brand-dark" />
        <h2 className="text-base font-bold text-gray-900">{title}</h2>
        {count != null && <span className="text-sm text-gray-400">({count})</span>}
      </div>
      {children}
    </section>
  );
}

export default async function RoadmapPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Logo className="h-11 w-11 shrink-0 text-brand drop-shadow-sm" />
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">Internal · not linked anywhere</p>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">FieldText — Roadmap Deep Dive</h1>
            <p className="mt-0.5 text-sm text-gray-500">Holes &amp; what to add · July 6, 2026 · 4 independent review passes + live site probes</p>
          </div>
        </div>
        <Link href="/dashboard/audit" className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:border-brand/40">
          <ShieldCheck className="h-4 w-4 text-brand-dark" /><span className="hidden sm:inline">Defect audit</span>
        </Link>
      </header>

      {/* Applied status */}
      <section className="rounded-2xl border border-green-300 bg-green-50 p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-brand" />
          <h2 className="font-bold text-gray-900">Applied — July 7, 2026</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-700">
          Everything code-shaped on this page has been built and shipped: receivables (auto “who owes me”),
          conversation memory, rainout reschedule, pause/skip/move, expenses + tax CSV export, invoice
          forward-links, photo-text handling, crew day sheet + weekly/monthly digests, referral line, real
          signup saving, homepage pricing + demo widget, and the full dashboard/PWA polish pass.
          <strong> Still yours to do (not code):</strong> run migration <code>0006_roadmap.sql</code> in Supabase,
          set up the free cron pinger, verify eric@fieldtextapp.com receives mail, kill the Squarespace parking
          page, consolidate domains, and (deliberately skipped) voice notes + the demo video.
        </p>
      </section>

      {/* Verdict */}
      <section className="rounded-2xl border border-brand/25 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-brand-dark" />
          <h2 className="font-bold text-gray-900">The verdict, in one paragraph</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-700">
          The product's soul — text one number, it remembers everything — is right, and the foundations
          (bilingual pipeline, never trusting the AI blindly, quote follow-ups) are genuinely good.
          The four holes that matter: FieldText is a <strong>diary, not a book that balances</strong> (it never knows
          who owes you until you say so); the bot <strong>asks questions it can't hear the answers to</strong>;
          the <strong>funnel converts 0%</strong> (three disconnected sites, two fake signup forms, no pricing);
          and the dashboard <strong>doesn't yet feel like an installed app</strong>. Each one has a clear, sized fix below.
        </p>
      </section>

      {/* Four themes — columns */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {THEMES.map((t) => (
          <div key={t.title} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
            <t.Icon className="h-5 w-5 text-brand-dark" />
            <h3 className="mt-2 text-sm font-bold leading-snug text-gray-900">{t.title}</h3>
            <p className="mt-1.5 text-xs leading-5 text-gray-600">{t.body}</p>
          </div>
        ))}
      </section>

      {/* Start here */}
      <Section Icon={Rocket} title="Start here — the five that matter most">
        <div className="space-y-2">
          {START_HERE.map((s, i) => (
            <div key={s.name} className="flex gap-3 rounded-2xl border border-brand/20 bg-white p-4 shadow-sm">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-gray-900">{s.name}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${EFFORT_STYLE[s.effort]}`}>{EFFORT_WORD[s.effort]}</span>
                </div>
                <p className="mt-1 text-sm leading-5 text-gray-600">{s.why}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Quick wins */}
      <Section Icon={Zap} title="Quick wins — shippable same-day" count={QUICK_WINS.length}>
        <div className="rounded-2xl border border-amber-200/70 bg-amber-50/50 p-4">
          <ul className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
            {QUICK_WINS.map((q) => (
              <li key={q} className="flex gap-2 text-sm leading-5 text-gray-700"><Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />{q}</li>
            ))}
          </ul>
        </div>
      </Section>

      {/* Feature additions */}
      <Section Icon={MessageSquareText} title="Features — the operator's actual day" count={FEATURES.length}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {FEATURES.map((it) => <ItemCard key={it.name} it={it} />)}
        </div>
      </Section>

      {/* Conversation */}
      <Section Icon={MessageSquareText} title="The conversation — texts that should just work" count={CONVERSATION.length}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {CONVERSATION.map((it) => <ItemCard key={it.name} it={it} />)}
        </div>
      </Section>

      {/* Growth */}
      <Section Icon={TrendingUp} title="Growth — funnel, pricing, retention" count={GROWTH.length}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {GROWTH.map((it) => <ItemCard key={it.name} it={it} />)}
        </div>
      </Section>

      {/* Dashboard polish */}
      <Section Icon={Smartphone} title="Dashboard — make it feel professional" count={POLISH.length}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {POLISH.map((it) => <ItemCard key={it.name} it={it} />)}
        </div>
      </Section>

      {/* Don't build */}
      <section className="rounded-2xl border border-red-200/70 bg-red-50/40 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Ban className="h-5 w-5 text-red-600" />
          <h2 className="text-base font-bold text-gray-900">Deliberately don&apos;t build — scope traps</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {DONT_BUILD.map((d) => (
            <div key={d.name} className="rounded-xl border border-red-100 bg-white p-3.5 shadow-sm">
              <p className="text-sm font-semibold text-gray-900">{d.name}</p>
              <p className="mt-0.5 text-xs leading-5 text-gray-600">{d.why}</p>
            </div>
          ))}
        </div>
      </section>

      {/* What's right */}
      <section className="rounded-2xl border border-green-200/70 bg-green-50/50 p-5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-brand" />
          <h2 className="text-base font-bold text-gray-900">Confirmed right — don&apos;t touch</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-700">
          The one-number, operator-only texting model (compliance stays simple, costs stay ~$7–13/client) ·
          never trusting the AI&apos;s raw output — everything re-normalized in code · the quote follow-up cadence with
          auto-cancel on yes/no · the bilingual pipeline enforced by the compiler · quote confirmations that echo
          every saved field · review-before-commit import. These are the product&apos;s spine — every addition above
          builds on them, none replaces them.
        </p>
      </section>

      <footer className="flex items-center justify-center gap-4 pb-4 text-xs text-gray-400">
        <span>FieldText roadmap deep dive · July 6, 2026</span>
        <Link href="/dashboard/audit" className="font-medium text-brand-dark hover:underline">Defect audit →</Link>
      </footer>
    </main>
  );
}
