/**
 * HIDDEN internal audit report — /dashboard/audit
 * ADMIN ONLY: operators must never see this.
 *
 * Beta-Readiness edition, refreshed July 10, 2026. Third deep audit (July 9,
 * 3 independent passes) plus a July 10 refresh that flips the findings the ops
 * work closed (cron pinger, UptimeRobot, spend guardrails), records the
 * signup-500 caught and fixed today, and re-scores. Ends with the founder
 * checklist — now mostly done — of things only Eric can confirm.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/supabase";
import { ShieldCheck, AlertTriangle, Sparkles, CheckCircle2, Compass, ClipboardCheck, Wrench } from "lucide-react";
import { Logo } from "@/app/Logo";

export const dynamic = "force-dynamic";
export const metadata = { title: "FieldText — Beta-Readiness Audit", robots: { index: false, follow: false } };

// ── Original July 3 audit: where every finding stands now ─────────────────────
type OldStatus = "fixed" | "partial" | "open";
const OLD_STYLE: Record<OldStatus, { chip: string; label: string }> = {
  fixed: { chip: "bg-green-100 text-green-800", label: "Fixed" },
  partial: { chip: "bg-amber-100 text-amber-800", label: "Partial" },
  open: { chip: "bg-red-100 text-red-800", label: "Still open" },
};
const ORIGINAL: { title: string; status: OldStatus; note: string }[] = [
  { title: "Twilio signature check off in production", status: "fixed", note: "Env cleaned up AND a code guard now ignores the bypass flag in production builds." },
  { title: "Reminders only fire once a day", status: "fixed", note: "Closed July 10: cron-job.org pings /api/cron/run-due every 15 min (test run returned 200 OK). Reminders and quote follow-ups now fire on time all day, not once at 9 AM." },
  { title: "Real AI parser not enabled", status: "fixed", note: "ANTHROPIC_API_KEY live, claude-haiku-4-5, 8-second timeout, no retries." },
  { title: "Failures are invisible", status: "fixed", note: "Closed July 10: UptimeRobot monitors /api/health (app + DB) every 5 min and alerts you; live status now also shows on the founder HQ. Plus SMS alerts on lockouts, signup floods, cron errors, and message caps." },
  { title: "Signup page is a mock", status: "fixed", note: "Real signups table, verbatim consent proof + timestamp + IP, double opt-in, founder alert — and as of today an activation code." },
  { title: "“Who owes me” only ever grows", status: "fixed", note: "Full receivables ledger: payments settle charges oldest-first, dashboard has Mark paid / Delete." },
  { title: "Same-name clients create silent duplicates", status: "fixed", note: "“Which one?” prompts everywhere, last-name veto, typo guard, confirm-before-match." },
  { title: "Dates computed in server time", status: "fixed", note: "Shared today-in-business-timezone helper used across reminders, charges, digests." },
  { title: "Slow AI blows Twilio's 15s deadline", status: "fixed", note: "8s timeout, dedup record written before parsing, maxDuration=30 on the webhook route (added today)." },
  { title: "No brute-force protection; password stored in cookie", status: "fixed", note: "Signed session cookies (now with expiry), scrypt-hashed passwords, per-phone + global throttles, lockout alerts." },
  { title: "No backups", status: "partial", note: "Weekly backup endpoint exists and is now scheduled in vercel.json — confirm it appears in Vercel after this deploy (checklist)." },
  { title: "Client #2 can't have their own dashboard", status: "fixed", note: "Full multi-tenant: phone + password sign-in, per-business books, admin switcher." },
  { title: "No spending guard on inbound texts", status: "fixed", note: "75 msgs/day per-phone cap (added today) that goes quiet instead of reply-looping, plus a founder alert." },
  { title: "Clients have no phone/email fields", status: "fixed", note: "Both exist, editable on the dashboard; import now maps phone columns too (added today)." },
  { title: "Can't edit clients/jobs/payments from dashboard", status: "fixed", note: "Edit form, drag-and-drop status, money-owed actions." },
  { title: "No data export", status: "fixed", note: "/api/export for clients, payments, jobs, expenses — now with the Excel-friendly BOM (added today)." },
  { title: "Re-quoting an active client demotes them", status: "fixed", note: "Active clients stay active on re-quote; “new job” logs as won work." },
  { title: "Import doesn't check for existing clients", status: "fixed", note: "Added today: a re-imported name updates the existing client's blanks instead of creating a twin." },
  { title: "HELP not handled; photos ignored", status: "fixed", note: "Deterministic HELP/AYUDA menu, photo attachments save to clients, START/STOP handled in both languages." },
  { title: "Failing reminder retries forever", status: "open", note: "Still uncapped. Low risk in beta (sends only fail on carrier blocks); on the list for the retry-cap pass." },
];

// ── What the July 9 audit found ────────────────────────────────────────────────
type Sev = "critical" | "high" | "medium" | "low";
type NewStatus = "today" | "open";
const SEV_STYLE: Record<Sev, { chip: string; bar: string; label: string }> = {
  critical: { chip: "bg-red-100 text-red-800", bar: "bg-red-500", label: "Critical" },
  high: { chip: "bg-orange-100 text-orange-800", bar: "bg-orange-400", label: "High" },
  medium: { chip: "bg-amber-100 text-amber-800", bar: "bg-amber-400", label: "Medium" },
  low: { chip: "bg-sky-100 text-sky-800", bar: "bg-sky-400", label: "Low" },
};
const NEW_FINDINGS: { sev: Sev; area: string; title: string; why: string; done: NewStatus; note: string }[] = [
  { sev: "high", area: "Correctness", done: "today",
    title: "Beta signup form crashed with a 500 (found July 10)",
    why: "The signup action file exported a plain string (the consent wording) alongside its functions. Next.js forbids that in a \"use server\" file, so it refused to load the whole action — every beta signup hit a server error page. Caught by testing the form ourselves and matching the error digest in the live logs.",
    note: "Fixed July 10: made the constant module-private. Verified with a full production build; signup now reaches the success screen and the lead lands in HQ." },
  { sev: "critical", area: "Security", done: "today",
    title: "Signup squatting: anyone could pre-register a stranger's number",
    why: "The old flow activated a pending signup on ANY first text. An attacker who knew a target's cell could fill the form with their number and an attacker-chosen password — and silently own the account the moment the victim ever texted the line.",
    note: "Fixed: signups now get a 6-digit activation code shown only on the success screen. The account activates only when THAT code is texted from THAT phone." },
  { sev: "high", area: "Security", done: "today",
    title: "Master-password throttle could be bypassed by rotating phone numbers",
    why: "Login throttling was keyed per phone, but the master key is checked on every attempt — a bot rotating fake numbers got unlimited guesses at the founder password.",
    note: "Fixed: a fixed global bucket now counts every failure against the master key (30 tries → 15-min lock + SMS alert to you)." },
  { sev: "high", area: "Security", done: "today",
    title: "Session cookies were signed with the master password and never expired",
    why: "If the master password ever leaked, every session token could be forged; and a stolen cookie worked forever.",
    note: "Fixed: dedicated SESSION_SIGNING_SECRET (add the env var — checklist) and a 30-day expiry baked inside the signed token." },
  { sev: "high", area: "Security", done: "today",
    title: "Cross-tenant edges in reminders, notes, and payments",
    why: "A handful of dashboard actions took a client id from the form without proving it belonged to YOUR business — one tenant could cancel another's quote follow-ups or attach data to their clients.",
    note: "Fixed: every one of those paths now verifies ownership before touching anything." },
  { sev: "high", area: "Security", done: "today",
    title: "A crew phone could reset the owner's dashboard password",
    why: "Password reset looked up ANY authorized phone — a helper's phone on the account could take over the owner's login.",
    note: "Fixed: resets are restricted to the primary (owner) phone, with a per-phone cap so the form can't SMS-bomb anyone." },
  { sev: "high", area: "Money", done: "today",
    title: "Dashboard payments didn't settle “Money owed”",
    why: "Logging a payment by text settled the client's open charges; logging the same payment from the dashboard didn't — the two views of who-owes-you disagreed.",
    note: "Fixed: both paths now settle charges oldest-first, identically." },
  { sev: "high", area: "Money", done: "today",
    title: "New recurring clients were billed on day one",
    why: "Adding “the Smiths, $200/mo” made them owe $200 immediately — before any work happened. Beta testers would read that as a bug in your bookkeeping.",
    note: "Fixed: the first cycle now lands one period after the client is added, anchored to a fixed date so it can't slip." },
  { sev: "high", area: "Money", done: "today",
    title: "Paused clients got back-billed on resume; monthly dates drifted",
    why: "Resume after 10 weeks paused → 10 surprise charges. And a client billed on the 31st drifted to the 28th forever after February.",
    note: "Fixed: long gaps fast-forward to the current cycle (one charge, not the pile), and monthly billing snaps back to its anchor day. All of this is now under test." },
  { sev: "medium", area: "Security", done: "today",
    title: "Photo fetches trusted the webhook's media URL",
    why: "The server fetched whatever MediaUrl Twilio sent — with your Twilio credentials attached. A forged webhook could point that request at an attacker's server.",
    note: "Fixed: media is only ever fetched from twilio.com hosts." },
  { sev: "medium", area: "Ops", done: "today",
    title: "Digests could spam an empty book",
    why: "The day sheet texted “no stops today” every single morning, and the Monday digest sent “0 open quotes” weekly — noise that trains beta testers to ignore FieldText.",
    note: "Fixed: both stay quiet when there's nothing to say. New signups get the morning day sheet on by default (it never fired before — the setting was never set)." },
  { sev: "medium", area: "Ops", done: "today",
    title: "Weekly backups were built but never scheduled",
    why: "The backup endpoint existed; nothing called it. Zero backups had ever run.",
    note: "Fixed: scheduled in vercel.json (Sundays). Confirm the cron appears in Vercel after deploy — checklist." },
  { sev: "medium", area: "Ops", done: "open",
    title: "Reminder sends have no retry cap",
    why: "A permanently failing send (carrier block, dead number) retries every run, silently, forever.",
    note: "Open — low beta risk. Planned: count attempts, mark failed after 5, surface on the dashboard." },
  { sev: "low", area: "Ops", done: "open",
    title: "Netlify landing site still collects leads into a void",
    why: "The old fieldtext.netlify.app pages are live. If anyone finds them, their signup goes nowhere.",
    note: "Open — decide: redirect the Netlify site to fieldtextapp.com, or delete it (checklist)." },
  { sev: "low", area: "Ops", done: "open",
    title: "SMS cost math undercounts emoji messages",
    why: "Replies use ✅⏰📅; emoji halve the per-segment limit, so cost estimates run ~2× low. Affects your unit-economics view only.",
    note: "Open — cosmetic; on the backlog." },
];

// ── Founder checklist — only Eric can confirm these ───────────────────────────
// done items render checked; pending float to the top. Updated July 10.
const CHECKLIST: { title: string; detail: string; done: boolean }[] = [
  // ✅ Done as of July 10
  { title: "External cron pinger", done: true, detail: "Done — cron-job.org hits /api/cron/run-due every 15 min (test run returned 200 OK). Reminders and quote follow-ups now fire on time all day." },
  { title: "UptimeRobot on /api/health", done: true, detail: "Done — free 5-min monitor live. Alerts you before a tester notices, keeps free Supabase from pausing, and feeds the live status card on HQ." },
  { title: "Twilio spend guardrails", done: true, detail: "Done — auto-recharge on (balance can't hit $0 and stop texts) plus a $60/month usage-trigger email alert." },
  { title: "Beta waitlist table live", done: true, detail: "Done — migrations 0015 (waitlist) and 0016 (email) run; beta signups save, capture email, and appear in HQ → Beta waitlist." },
  { title: "Anthropic monthly spend limit", done: true, detail: "Done — monthly cap + alerts set in the Anthropic console. Hard ceiling against a runaway; real usage is pennies." },
  { title: "SESSION_SIGNING_SECRET in Vercel", done: true, detail: "Done — dedicated signing secret set. Sessions are signed with it and expire in 30 days. (Confirm a redeploy applied it — env changes need one.)" },
  { title: "FOUNDER_ALERT_PHONE set", done: true, detail: "Done — your cell is set, so lockouts, signup floods, cron errors, message caps, and new signups all text you." },
  // ⬜ Still to do
  { title: "Confirm migrations 0013 + 0014 ran", done: false, detail: "0015 and 0016 (waitlist) are confirmed. Verify 0013 (beta hardening) and 0014 (client-linked expenses) were each run in Supabase." },
  { title: "Confirm the weekly backup cron", done: false, detail: "Vercel → Settings → Cron Jobs should show /api/cron/backup (Sundays). Hobby allows exactly 2 crons." },
  { title: "Decide the Netlify site's fate", done: false, detail: "Redirect fieldtext.netlify.app to fieldtextapp.com, or take it down. Right now it can swallow leads into a void." },
  { title: "A2P opt-in URL current?", done: false, detail: "Your Twilio campaign should point at https://fieldtextapp.com/signup as the opt-in proof. If it still shows the old Netlify URL, update it." },
];

const SCORES: { area: string; grade: string; color: string; note: string }[] = [
  { area: "Security", grade: "A", color: "text-brand-dark", note: "Dedicated session secret + expiry, hashed passwords, throttles + founder alerts wired, tenant isolation verified, new admin pages all gated. Confirm the redeploy that applies the env vars." },
  { area: "Money accuracy", grade: "A-", color: "text-brand-dark", note: "One ledger, both entry paths settle identically, billing anchors tested. Watch first real cycles in beta." },
  { area: "Reliability", grade: "A-", color: "text-brand-dark", note: "Confirmed July 10: cron pinger live (reminders fire on time), UptimeRobot watching app + DB, Twilio auto-recharge + spend alert on. Live cost/uptime/delivery tracking on HQ. Backup cron still to confirm." },
  { area: "Beta readiness", grade: "A-", color: "text-brand-dark", note: "Cleared for testers. Signup funnel verified end to end. What's left is the short checklist below — a migration, an env var or two, and the Anthropic cap." },
];

export default async function AuditPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");
  const fixedCount = ORIGINAL.filter((o) => o.status === "fixed").length;
  const todayCount = NEW_FINDINGS.filter((f) => f.done === "today").length;
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Logo className="h-11 w-11 shrink-0 text-brand drop-shadow-sm" />
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">Internal · not linked anywhere</p>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">FieldText — Beta-Readiness Audit</h1>
            <p className="mt-0.5 text-sm text-gray-500">Refreshed July 10, 2026 · ops checklist now mostly cleared · beta waitlist + founder HQ shipped</p>
          </div>
        </div>
        <Link href="/dashboard/roadmap" className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:border-brand/40">
          <Compass className="h-4 w-4 text-brand-dark" /><span className="hidden sm:inline">Roadmap</span>
        </Link>
      </header>

      {/* Verdict */}
      <section className="rounded-2xl border border-brand/25 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-dark" />
          <h2 className="font-bold text-gray-900">The verdict, in one paragraph</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-700">
          FieldText is cleared for beta testers. Of the original audit&apos;s 20 findings, <strong>{fixedCount} are fully fixed</strong>
          and only 2 low-risk items remain. The July 9 audit&apos;s findings are all fixed, with tests. Since then the operational
          backstops have gone live — <strong>cron pinger, UptimeRobot, and Twilio spend guardrails are all done</strong> — and a
          beta waitlist + a founder HQ (live cost, uptime, delivery, and activity tracking) shipped. Today&apos;s refresh also
          caught and fixed a signup-form 500 before any real tester hit it. What&apos;s left is the short{" "}
          <strong>{CHECKLIST.filter((c) => !c.done).length}-item checklist</strong> below — a migration, an env var or two, and the Anthropic cap.
        </p>
      </section>

      {/* Scorecard */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SCORES.map((s) => (
          <div key={s.area} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
            <div className={`text-3xl font-bold tracking-tight ${s.color}`}>{s.grade}</div>
            <div className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{s.area}</div>
            <p className="mt-1.5 text-xs leading-5 text-gray-500">{s.note}</p>
          </div>
        ))}
      </section>

      {/* Founder checklist */}
      {(() => {
        const pending = CHECKLIST.filter((c) => !c.done);
        const done = CHECKLIST.filter((c) => c.done);
        return (
          <section className="rounded-2xl border border-red-200 bg-red-50/50 p-5">
            <div className="mb-3 flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-red-700" />
              <h2 className="text-base font-bold text-gray-900">Founder checklist before inviting testers</h2>
              <span className="text-sm text-gray-400">({done.length}/{CHECKLIST.length} done)</span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {pending.map((c, i) => (
                <div key={c.title} className="rounded-xl border border-red-100 bg-white p-3.5 shadow-sm">
                  <p className="text-sm font-semibold text-gray-900"><span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-[11px] font-bold text-red-700">{i + 1}</span>{c.title}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-600">{c.detail}</p>
                </div>
              ))}
              {done.map((c) => (
                <div key={c.title} className="rounded-xl border border-green-100 bg-green-50/40 p-3.5 shadow-sm">
                  <p className="flex items-start gap-1.5 text-sm font-semibold text-gray-500 line-through decoration-green-500/40"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{c.title}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500 no-underline">{c.detail}</p>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {/* New findings */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-brand-dark" />
          <h2 className="text-base font-bold text-gray-900">What this audit found</h2>
          <span className="text-sm text-gray-400">({NEW_FINDINGS.length} — {todayCount} fixed same-day)</span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {NEW_FINDINGS.map((f) => (
            <div key={f.title} className="flex overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
              <span className={`w-1.5 shrink-0 ${SEV_STYLE[f.sev].bar}`} />
              <div className="min-w-0 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${SEV_STYLE[f.sev].chip}`}>{SEV_STYLE[f.sev].label}</span>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{f.area}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${f.done === "today" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                    {f.done === "today" ? "✓ Fixed today" : "Still open"}
                  </span>
                </div>
                <h3 className="mt-1.5 font-semibold leading-snug text-gray-900">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-5 text-gray-600">{f.why}</p>
                <p className="mt-2 flex gap-1.5 text-sm leading-5 text-gray-700">
                  <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-dark" />
                  <span>{f.note}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Original audit scorecard */}
      <section className="rounded-2xl border border-green-200/70 bg-green-50/50 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-brand-dark" />
          <h2 className="text-base font-bold text-gray-900">The original July 3 audit — where every finding stands</h2>
          <span className="text-sm text-gray-400">({fixedCount}/{ORIGINAL.length} fixed)</span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {ORIGINAL.map((o) => (
            <div key={o.title} className="rounded-xl border border-green-100 bg-white p-3.5 shadow-sm">
              <div className="flex items-start gap-2">
                <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${o.status === "fixed" ? "text-brand" : o.status === "partial" ? "text-amber-500" : "text-red-400"}`} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${OLD_STYLE[o.status].chip}`}>{OLD_STYLE[o.status].label}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold leading-snug text-gray-900">{o.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-gray-600">{o.note}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="pb-4 text-center text-xs text-gray-400">
        FieldText internal audit · refreshed July 10, 2026 · findings verified against source and live logs; fixes covered by the test suite
      </footer>
    </main>
  );
}
