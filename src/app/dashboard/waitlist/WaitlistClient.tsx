"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, MessageSquare, UserPlus, Trash2, Mail, Copy } from "lucide-react";
import { setWaitlistStatus, saveWaitlistNote, deleteWaitlistEntry } from "./actions";

export type Lead = {
  id: string;
  createdAt: string;
  name: string;
  business: string | null;
  phone: string;
  rawPhone: string;
  email: string | null;
  trade: string | null;
  needs: string | null;
  lang: string;
  timezone: string;
  status: string;
  notes: string | null;
};

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "invited", label: "Invited" },
  { key: "active", label: "Active" },
  { key: "passed", label: "Passed" },
];

const BADGE: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  invited: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-700",
  passed: "bg-gray-100 text-gray-500",
};

export default function WaitlistClient({ leads }: { leads: Lead[] }) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex items-center gap-3">
        <Link href="/dashboard" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Beta waitlist</h1>
          <p className="text-sm text-gray-500">Everyone who signed up. Pick who to invite, then onboard them under Operators.</p>
        </div>
      </header>
      <WaitlistPanel leads={leads} />
    </main>
  );
}

/** The filter tabs + lead cards, with no page chrome — embeddable in HQ. */
export function WaitlistPanel({ leads }: { leads: Lead[] }) {
  const [filter, setFilter] = useState("all");
  const counts = leads.reduce<Record<string, number>>((a, l) => ((a[l.status] = (a[l.status] ?? 0) + 1), a), {});
  const shown = filter === "all" ? leads : leads.filter((l) => l.status === filter);

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? leads.length : counts[f.key] ?? 0;
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${active ? "bg-brand text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {f.label} <span className={active ? "opacity-80" : "text-gray-400"}>{n}</span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-400">
          No signups here yet.
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((l) => (
            <LeadCard key={l.id} lead={l} />
          ))}
        </div>
      )}
    </div>
  );
}

function LeadCard({ lead: l }: { lead: Lead }) {
  const invite = inviteEmail(l);
  const [showInvite, setShowInvite] = useState(false);
  const [body, setBody] = useState(invite.body);
  const [copied, setCopied] = useState(false);
  const mailto = `mailto:${l.email ?? ""}?subject=${encodeURIComponent(invite.subject)}&body=${encodeURIComponent(body)}`;

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-gray-900">
            <span className="truncate">{l.name}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${BADGE[l.status] ?? BADGE.new}`}>{l.status}</span>
          </p>
          <p className="mt-0.5 text-sm text-gray-600">
            {l.trade ?? "—"}{l.business ? ` · ${l.business}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {l.phone} · {l.lang} · {l.timezone} · {relTime(l.createdAt)}
          </p>
        </div>
        <form action={deleteWaitlistEntry}>
          <input type="hidden" name="id" value={l.id} />
          <button title="Delete lead" aria-label="Delete lead" className="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500">
            <Trash2 className="h-4 w-4" />
          </button>
        </form>
      </div>

      {l.needs && (
        <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
          <span className="font-medium text-gray-500">Needs it for: </span>{l.needs}
        </p>
      )}

      {/* Quick actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={`sms:${l.rawPhone}`}
          className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:border-brand/40"
        >
          <MessageSquare className="h-4 w-4" /> Text
        </a>
        <button
          onClick={() => setShowInvite((v) => !v)}
          className={`flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:border-brand/40 ${showInvite ? "border-brand/40 bg-brand/5 text-brand-dark" : "border-gray-200 text-gray-700"}`}
        >
          <Mail className="h-4 w-4" /> Draft invite
        </button>
        <Link
          href="/dashboard/admin"
          className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:border-brand/40"
        >
          <UserPlus className="h-4 w-4" /> Onboard
        </Link>
        <div className="flex-1" />
        {[
          { s: "invited", label: "Invited" },
          { s: "active", label: "Active" },
          { s: "passed", label: "Pass" },
          { s: "new", label: "Reset" },
        ]
          .filter((b) => b.s !== l.status)
          .map((b) => (
            <form key={b.s} action={setWaitlistStatus}>
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="status" value={b.s} />
              <button className="min-h-[38px] rounded-lg bg-brand/10 px-3 text-sm font-medium text-brand-dark hover:bg-brand/20">
                {b.label}
              </button>
            </form>
          ))}
      </div>

      {/* Invite email draft */}
      {showInvite && (
        <div className="mt-3 rounded-xl border border-brand/20 bg-brand/5 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium text-gray-500">Subject</p>
            {l.email ? (
              <p className="truncate text-xs text-gray-500">to {l.email}</p>
            ) : (
              <p className="text-xs text-amber-700">No email on file — add the recipient in your mail app</p>
            )}
          </div>
          <p className="text-sm font-medium text-gray-800">{invite.subject}</p>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={13}
            className="mt-2 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm leading-relaxed focus:border-brand focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={mailto}
              className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-white hover:bg-brand-dark"
            >
              <Mail className="h-4 w-4" /> Open in email
            </a>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`Subject: ${invite.subject}\n\n${body}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch { /* clipboard blocked — user can select the text manually */ }
              }}
              className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:border-brand/40"
            >
              <Copy className="h-4 w-4" /> {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Private note */}
      <form action={saveWaitlistNote} className="mt-3 flex gap-2">
        <input type="hidden" name="id" value={l.id} />
        <input
          name="notes"
          defaultValue={l.notes ?? ""}
          placeholder="Private note (why you did / didn't pick them)…"
          className="min-h-[38px] flex-1 rounded-lg border border-gray-200 px-2 text-sm focus:border-brand focus:outline-none"
        />
        <button className="min-h-[38px] shrink-0 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-600 hover:border-brand/40">
          Save
        </button>
      </form>
    </div>
  );
}

// A ready-to-send onboarding email, lightly tailored to the lead's trade.
// Editable in the UI before sending.
function inviteEmail(l: Lead): { subject: string; body: string } {
  const first = l.name.split(/\s+/)[0] || l.name;
  const example = exampleTextFor(l.trade);
  return {
    subject: "You're in — welcome to the FieldText beta",
    body: `Hi ${first},

Thanks for signing up for the FieldText beta — you're in!

FieldText is simple: you run your business by texting one number in plain English. It keeps track for you and texts you right back.

To start, text this number: (971) 462-5343
Try something like: "${example}"

You'll get a reply in seconds. Everything you text — quotes, jobs, payments, reminders — shows up on your dashboard at fieldtextapp.com/dashboard (sign in with your mobile number; use "forgot password" to set a password by text).

It also chases your quotes for you: send one and it reminds you to follow up until the job is won or the customer passes.

This is an early beta, so I really want your honest take. Text me anything that's confusing or missing, or just reply to this email — you're one of the first people using this and it genuinely helps.

Talk soon,
Eric
eric@fieldtextapp.com`,
  };
}

function exampleTextFor(trade: string | null): string {
  const t = (trade ?? "").toLowerCase();
  if (/(landscap|lawn|mow|yard)/.test(t)) return "Quoted the Johnsons $200 a month for weekly mowing";
  if (/clean/.test(t)) return "Quoted Sarah $150 for a deep clean Friday";
  if (/paint/.test(t)) return "Quoted Mike $1,200 to paint the exterior";
  if (/pool/.test(t)) return "Quoted the Lees $120 a month for pool service";
  if (/(pressure|power)\s?wash/.test(t)) return "Quoted Tom $250 to pressure wash the driveway";
  if (/(handy|repair|fix|contractor)/.test(t)) return "Quoted Dave $85 to fix the fence";
  return "Quoted the Johnsons $200 for the job on Friday";
}

function relTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
