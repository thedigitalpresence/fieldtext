/**
 * HIDDEN internal audit report — /dashboard/audit
 * Not linked from anywhere; protected by the dashboard password (middleware).
 * Compiled July 3, 2026 from a 3-agent deep audit (security, code quality,
 * product/launch) + live production probes. Owner-facing, plain English.
 */
import { ShieldCheck, AlertTriangle, Wrench, Sparkles, CheckCircle2, Clock3, Leaf } from "lucide-react";

export const metadata = { title: "FieldText — Internal Audit", robots: { index: false, follow: false } };

type Sev = "critical" | "high" | "medium" | "low";
type Finding = {
  sev: Sev;
  area: string;      // Security · Reliability · Product · Code
  title: string;     // plain English
  why: string;       // why it matters, founder language
  fix: string;       // what to do
  effort: string;    // "5 min" | "1 hr" | "half day"
};

const SEV_STYLE: Record<Sev, { chip: string; bar: string; label: string }> = {
  critical: { chip: "bg-red-100 text-red-800", bar: "bg-red-500", label: "Fix now" },
  high: { chip: "bg-orange-100 text-orange-800", bar: "bg-orange-400", label: "Fix soon" },
  medium: { chip: "bg-amber-100 text-amber-800", bar: "bg-amber-400", label: "Worth doing" },
  low: { chip: "bg-sky-100 text-sky-800", bar: "bg-sky-400", label: "Polish" },
};

const FINDINGS: Finding[] = [
  // ── CRITICAL — before charging anyone ──────────────────────────────────────
  {
    sev: "critical", area: "Security",
    title: "Twilio signature check is switched OFF in production",
    why: "We tested it live: a faked message POST was accepted. The code defaults this protection ON, but the env var TWILIO_VALIDATE_SIGNATURE=false was copied into Vercel from the demo config. Right now anyone who knows your cell number could forge texts “from you” and write into your book.",
    fix: "Vercel → Settings → Environment Variables → delete TWILIO_VALIDATE_SIGNATURE (or set it to true) → Redeploy. Also worth a code guard so this flag can never disable it in production.",
    effort: "5 min",
  },
  {
    sev: "critical", area: "Reliability",
    title: "Reminders only fire once a day (and can be ~23 hours late)",
    why: "Vercel’s free plan runs the reminder job once daily at 16:00 UTC. A reminder promised for “Friday 9 AM” can arrive the next day. The morning digest can literally never send — the hour check never matches. This is the core product promise.",
    fix: "Free fix: set up cron-job.org to hit the reminder endpoint every 10–15 minutes with the secret header (x-cron-secret). Or upgrade Vercel to Pro and schedule */10.",
    effort: "20 min",
  },
  {
    sev: "critical", area: "Product",
    title: "The real AI parser is not turned on in production",
    why: "No ANTHROPIC_API_KEY is set, so a simple keyword fallback is parsing your texts. It misses one-time quotes without “/mo”, garbles some names, can’t handle typos in trigger words, answers questions by dumping your whole database as a giant text, and photo import is disabled.",
    fix: "Add ANTHROPIC_API_KEY and ANTHROPIC_MODEL=claude-haiku-4-5 in Vercel env, redeploy. (Haiku keeps cost ~15× lower than the default model setting.)",
    effort: "5 min",
  },
  {
    sev: "critical", area: "Reliability",
    title: "If something breaks, nobody finds out",
    why: "Errors are swallowed silently: you text, nothing answers, and the evidence disappears (free-plan logs last ~1 hour). There’s no alerting of any kind.",
    fix: "Add free UptimeRobot on /api/health, plus a simple error alert (Sentry free tier, or an email/webhook ping in the two catch blocks).",
    effort: "1–2 hrs",
  },
  {
    sev: "critical", area: "Product",
    title: "The signup page is a mock — it saves nothing",
    why: "The form throws away name, phone, and the consent checkbox. You’d never know someone signed up — and you have no stored proof-of-consent, which is exactly what carriers ask for in an A2P dispute.",
    fix: "Add a signups table and a tiny API route that saves the form (and emails you). Onboarding can stay manual after that.",
    effort: "1 hr",
  },
  // ── HIGH ────────────────────────────────────────────────────────────────────
  {
    sev: "high", area: "Product",
    title: "“Who owes me” numbers only ever grow",
    why: "“Bob owes $450” logs an unpaid row — but when Bob pays, nothing marks the old row settled. Outstanding totals inflate forever and become wrong after the first settled debt.",
    fix: "When a payment comes in for a client, settle their open unpaid rows; add a paid/unpaid toggle on the dashboard.",
    effort: "half day",
  },
  {
    sev: "high", area: "Product",
    title: "Two clients with the same name → silent duplicates",
    why: "“Quoted Garcia $300/mo” with two Garcias on file quietly creates a third Garcia instead of asking which one (status updates already ask — quotes don’t). There’s also no merge tool, so duplicates pile up.",
    fix: "Make quotes/jobs/payments ask “which one?” exactly like status updates do; add a merge-duplicates action later.",
    effort: "1 hr",
  },
  {
    sev: "high", area: "Code",
    title: "Dates are computed in server time, not your timezone",
    why: "The server runs on UTC. Text “remind me Friday” at 9 PM and the weekday math can land a week off; reminders get stamped 9 AM UTC (1–2 AM Pacific); jobs logged in the evening get dated tomorrow.",
    fix: "One shared “today in business timezone” helper used everywhere dates are computed. (The real AI parser masks most of this once enabled — another reason for the API key.)",
    effort: "half day",
  },
  {
    sev: "high", area: "Reliability",
    title: "A slow AI response can blow Twilio’s 15-second deadline",
    why: "The parse call has no timeout (SDK default is 10 minutes). On a slow API day Twilio gives up, retries, and — because the dedup record is written after parsing — the retry can double-save your message.",
    fix: "Set an 8-second timeout with no retries on the AI call, and write the dedup record before parsing instead of after.",
    effort: "1 hr",
  },
  {
    sev: "high", area: "Security",
    title: "Login has no brute-force protection and the cookie stores the actual password",
    why: "One shared password, unlimited guesses, and the browser cookie contains the password itself for 30 days — a cookie leak is a full compromise with no way to log devices out.",
    fix: "Rate-limit login attempts and switch the cookie to a random session token. Bundle this with multi-tenant login when client #2 arrives.",
    effort: "half day",
  },
  {
    sev: "high", area: "Reliability",
    title: "Your clients’ black book has no backups",
    why: "Supabase free tier: no automated backups, and projects pause after ~7 idle days (site goes down). One bad edit could erase a paying customer’s history permanently.",
    fix: "UptimeRobot pings double as keep-alive; add a weekly export (or upgrade Supabase to Pro ~$25/mo once client #1 pays).",
    effort: "1 hr",
  },
  {
    sev: "high", area: "Product",
    title: "Client #2 can’t have their own dashboard yet",
    why: "Texting is already multi-tenant (each phone routes to its own business), but the dashboard is hard-wired to one business and one shared password — client #2 would see client #1’s entire book.",
    fix: "Per-business password + the login picking the business by password. Until then, sell client #2 as SMS-only.",
    effort: "half day",
  },
  {
    sev: "high", area: "Security",
    title: "No spending guard on the inbound text pipeline",
    why: "Every text from an authorized phone triggers an AI call and an SMS reply, with no daily cap. A phone auto-reply loop (driving mode, forwarding rule) could run up costs quietly.",
    fix: "Add a per-phone daily cap (~75 msgs) with a polite “paused” reply; set Twilio + Anthropic spend alerts in their consoles.",
    effort: "1 hr",
  },
  // ── MEDIUM ─────────────────────────────────────────────────────────────────
  {
    sev: "medium", area: "Product",
    title: "Clients have no phone or email fields",
    why: "“Follow up with Angela” — but her number isn’t in FieldText. Import files with phone columns silently drop them. Conspicuous gap for a $50/mo black book.",
    fix: "Add phone + email columns, map them in import, show them on the client card.",
    effort: "1–2 hrs",
  },
  {
    sev: "medium", area: "Product",
    title: "Can’t edit client details, jobs, or payments from the dashboard",
    why: "A typo’d name or fat-fingered “$4500” payment is permanent unless fixed by SQL. The SMS “correction” flow only targets the most recently touched client — and dashboard taps retarget it.",
    fix: "Edit form in the client drawer (name/address/amount/service) + delete on job/payment rows.",
    effort: "half day",
  },
  {
    sev: "medium", area: "Product",
    title: "No way to export your data",
    why: "Import exists in 3 flavors; export in zero. A customer who wants a backup (or wants to leave) has nothing — bad for trust, and it’s also your poor-man’s backup.",
    fix: "One /api/export CSV route + a download link in the dashboard.",
    effort: "1 hr",
  },
  {
    sev: "medium", area: "Product",
    title: "Re-quoting an active client demotes them out of your MRR",
    why: "“Quoted Angela $600/mo” for already-active Angela (an upsell) flips her back to “quoted”, drops her from active/MRR stats, and starts follow-up nudges.",
    fix: "Keep active clients active when re-quoted (or ask to confirm).",
    effort: "30 min",
  },
  {
    sev: "medium", area: "Product",
    title: "Import doesn’t check for existing clients",
    why: "Importing a list containing Angela when she’s already in the book creates a duplicate; re-running the same import doubles the entire book.",
    fix: "Match each import row against existing clients; update instead of insert on a clear match, flag dupes for review.",
    effort: "1–2 hrs",
  },
  {
    sev: "medium", area: "Reliability",
    title: "HELP texts aren’t handled; photos texted in are ignored",
    why: "Carriers expect a compliant HELP reply (business name, contact, STOP info) — right now HELP falls into the parser. And texting a photo of a client list (natural, since photo import exists) gets “I didn’t catch that.”",
    fix: "Add HELP/AYUDA keyword reply; detect photo messages and point at the import page. Also add /privacy + /terms links to the landing and signup pages — campaign reviewers look for them.",
    effort: "1 hr",
  },
  {
    sev: "medium", area: "Reliability",
    title: "A permanently failing reminder retries daily forever, silently",
    why: "If a send keeps failing (bad number, carrier block), it stays “pending” and retries every run with no cap and no alert.",
    fix: "Count attempts; after 5, mark it failed and show it on the dashboard.",
    effort: "1 hr",
  },
  {
    sev: "medium", area: "Code",
    title: "Name matching is a bit too forgiving on short names",
    why: "“Gary” can match “Mary”, “Jane” can match “Juan” (2 edits allowed on 4-letter names) — data could land on the wrong client without asking.",
    fix: "Require the first letter to match and allow fewer edits on short names.",
    effort: "30 min",
  },
  // ── LOW ────────────────────────────────────────────────────────────────────
  {
    sev: "low", area: "Code",
    title: "Multi-part texts can half-save",
    why: "“Quoted Smiths $300 and remind me Friday” — if part 2 fails after part 1 saved, you’re told “try again,” and retrying re-creates the quote.",
    fix: "Handle each action separately and reply per-part.",
    effort: "1 hr",
  },
  {
    sev: "low", area: "Code",
    title: "SMS cost math undercounts emoji messages ~2×",
    why: "Replies are full of ✅⏰📅 — emoji halve the per-segment character limit, so cost estimates run low. Doesn’t affect sending, just your unit economics view.",
    fix: "Detect emoji and use the 70-char segment size.",
    effort: "30 min",
  },
  {
    sev: "low", area: "Code",
    title: "Login page + a few error messages are English-only",
    why: "The product is bilingual but the login screen and two import errors bypass the translation dictionary.",
    fix: "Route those strings through the i18n dict.",
    effort: "30 min",
  },
  {
    sev: "low", area: "Code",
    title: "Tests only cover the fallback parser",
    why: "All 25 tests exercise parsing/normalizing. The action handlers, reminder scheduling, and import commit — where most of the bugs above live — have zero tests. (The dead-digest bug would have been caught instantly by one test with a fake clock.)",
    fix: "Add a test pass over intents + reminders against the local mock DB.",
    effort: "half day",
  },
  {
    sev: "low", area: "Reliability",
    title: "Docs drifted from reality",
    why: "LAUNCH.md and setup_all.sql still omit migration 0005 (your prod DB has it — this only bites on a rebuild), and three places still say “cron every 5 minutes.”",
    fix: "15-minute doc pass; LAUNCH.md is your runbook — keep it truthful.",
    effort: "15 min",
  },
];

const SOLID: { title: string; detail: string }[] = [
  { title: "Strangers can’t touch your data", detail: "Unknown numbers texting in are silently ignored — no reply, no data written, no AI spend. This also blocks SMS-pumping cost attacks." },
  { title: "STOP / START opt-out done right, in both languages", detail: "Carrier compliance (A2P) handled before anything else, including Spanish keywords — ahead of most MVPs." },
  { title: "Duplicate texts can’t double-save", detail: "Twilio retries are deduplicated by message ID." },
  { title: "The AI’s output is never trusted blindly", detail: "Forced structured output, then everything re-normalized by code before saving." },
  { title: "Database locked down", detail: "Row-level security on every table with zero public policies — a leaked public key reads nothing. Secrets never reach the browser." },
  { title: "Full audit trail", detail: "Every inbound and outbound message stored with its parsed meaning — great for debugging parse quality." },
  { title: "Injection attacks covered", detail: "SQL is fully parameterized; SMS replies are XML-escaped; dashboard rendering auto-escapes." },
  { title: "Login basics are right", detail: "httpOnly + secure + sameSite cookie, open-redirect blocked, auth fails closed if env vars are missing." },
  { title: "Import UX is genuinely good", detail: "Paste / CSV / photo → editable review → confirm. Nothing saves without your eyes on it. Capped at 500 rows." },
  { title: "Bilingual to the bone", detail: "EN/ES enforced by the compiler — a missing Spanish string is a build error, not a runtime surprise." },
  { title: "Solid docs + health check", detail: "LAUNCH.md runbook and /api/health are unusually good for a solo-founder MVP (they just need the drift fixes)." },
];

const SCORES: { area: string; grade: string; color: string; note: string }[] = [
  { area: "Security", grade: "B", color: "text-amber-600", note: "Strong foundations; one live misconfig (signature check off) and thin login hardening." },
  { area: "Reliability", grade: "C", color: "text-red-600", note: "Daily-only reminders + silent failures are the two launch blockers." },
  { area: "Product", grade: "B+", color: "text-brand-dark", note: "Feature-rich for an MVP; missing edit/export and client contact fields." },
  { area: "Code quality", grade: "B", color: "text-amber-600", note: "Clean architecture and shared normalization; timezone math and test coverage lag." },
];

const PLAN: { when: string; items: string[] }[] = [
  { when: "This week (before any paid client)", items: [
    "Delete TWILIO_VALIDATE_SIGNATURE from Vercel env → redeploy (5 min)",
    "Add ANTHROPIC_API_KEY + ANTHROPIC_MODEL=claude-haiku-4-5 (5 min)",
    "cron-job.org hitting the reminder endpoint every 10–15 min (20 min)",
    "UptimeRobot on /api/health + basic error alert (1–2 hrs)",
    "Wire the signup form to actually save (1 hr)",
  ]},
  { when: "Before client #1 pays", items: [
    "Settle unpaid → paid so “who owes me” stays true",
    "“Which one?” prompt on ambiguous names (stop duplicate clients)",
    "Weekly backup or Supabase Pro",
    "AI-call timeout + dedup-first ordering in the webhook",
    "Client phone/email fields + edit + CSV export",
  ]},
  { when: "Before client #2", items: [
    "Per-business dashboard login (multi-tenant)",
    "Session-token auth + login rate limiting",
    "Timezone-correct date math everywhere",
    "Daily per-phone message cap",
  ]},
];

export default function AuditPage() {
  const bySev = (s: Sev) => FINDINGS.filter((f) => f.sev === s);
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      {/* Header */}
      <header className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-sm"><Leaf className="h-6 w-6" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">Internal · not linked anywhere</p>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">FieldText — Full Audit</h1>
          <p className="mt-0.5 text-sm text-gray-500">Deep dive of code, security, and launch readiness · July 3, 2026 · 3 independent review passes + live production probes</p>
        </div>
      </header>

      {/* Verdict */}
      <section className="rounded-2xl border border-brand/25 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-dark" />
          <h2 className="font-bold text-gray-900">The verdict, in one paragraph</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-700">
          The bones are genuinely good — compliance, data safety, and the import flow are ahead of most MVPs.
          But <strong>five things must be fixed before charging anyone</strong>: the forged-message protection is
          switched off in production, reminders only run once a day, the real AI parser isn&apos;t enabled, failures are
          invisible, and the signup form saves nothing. All five together are roughly <strong>one afternoon of work</strong>.
        </p>
      </section>

      {/* Scorecard — columns */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SCORES.map((s) => (
          <div key={s.area} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
            <div className={`text-3xl font-bold tracking-tight ${s.color}`}>{s.grade}</div>
            <div className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{s.area}</div>
            <p className="mt-1.5 text-xs leading-5 text-gray-500">{s.note}</p>
          </div>
        ))}
      </section>

      {/* Action plan — three columns */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Clock3 className="h-5 w-5 text-brand-dark" />
          <h2 className="text-base font-bold text-gray-900">The plan, in order</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {PLAN.map((p, i) => (
            <div key={p.when} className={`rounded-2xl border p-4 shadow-sm ${i === 0 ? "border-red-200 bg-red-50/50" : i === 1 ? "border-amber-200 bg-amber-50/50" : "border-sky-200 bg-sky-50/50"}`}>
              <p className={`text-xs font-bold uppercase tracking-wide ${i === 0 ? "text-red-700" : i === 1 ? "text-amber-700" : "text-sky-700"}`}>{p.when}</p>
              <ul className="mt-2 space-y-1.5">
                {p.items.map((it) => (
                  <li key={it} className="flex gap-2 text-sm leading-5 text-gray-700"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400" />{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Findings by severity */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-brand-dark" />
          <h2 className="text-base font-bold text-gray-900">Every finding, plain English</h2>
          <span className="text-sm text-gray-400">({FINDINGS.length})</span>
        </div>
        <div className="space-y-6">
          {(["critical", "high", "medium", "low"] as Sev[]).map((sev) => (
            <div key={sev}>
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${SEV_STYLE[sev].chip}`}>{SEV_STYLE[sev].label}</span>
                <span className="text-xs text-gray-400">{bySev(sev).length} item{bySev(sev).length === 1 ? "" : "s"}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {bySev(sev).map((f) => (
                  <div key={f.title} className="flex overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
                    <span className={`w-1.5 shrink-0 ${SEV_STYLE[sev].bar}`} />
                    <div className="min-w-0 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{f.area}</span>
                        <span className="text-[11px] font-medium text-gray-400">⏱ {f.effort}</span>
                      </div>
                      <h3 className="mt-1.5 font-semibold leading-snug text-gray-900">{f.title}</h3>
                      <p className="mt-1.5 text-sm leading-5 text-gray-600">{f.why}</p>
                      <p className="mt-2 flex gap-1.5 text-sm leading-5 text-gray-700">
                        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-dark" />
                        <span><span className="font-semibold text-brand-dark">Fix:</span> {f.fix}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* What's already solid */}
      <section className="rounded-2xl border border-green-200/70 bg-green-50/50 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-brand-dark" />
          <h2 className="text-base font-bold text-gray-900">Already solid — verified in code</h2>
          <span className="text-sm text-gray-400">({SOLID.length})</span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {SOLID.map((s) => (
            <div key={s.title} className="rounded-xl border border-green-100 bg-white p-3.5 shadow-sm">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <div>
                  <p className="text-sm font-semibold text-gray-900">{s.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-gray-600">{s.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="pb-4 text-center text-xs text-gray-400">
        FieldText internal audit · July 3, 2026 · findings verified against source with file-level references on request
      </footer>
    </main>
  );
}
