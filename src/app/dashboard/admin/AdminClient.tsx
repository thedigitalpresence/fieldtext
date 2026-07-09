"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { UserPlus, ArrowLeft, Check, Eye } from "lucide-react";
import { registerOperator, switchBusiness, setBusinessPassword } from "../actions";

type Row = { id: string; name: string; owner: string; lang: string; phone: string; hasPassword: boolean };
type Result = { ok: boolean; error?: string; slug?: string } | null;

const TZs = [
  ["America/Los_Angeles", "Pacific (PT)"],
  ["America/Denver", "Mountain (MT)"],
  ["America/Chicago", "Central (CT)"],
  ["America/New_York", "Eastern (ET)"],
  ["America/Phoenix", "Arizona"],
];

export default function AdminClient({ businesses }: { businesses: Row[] }) {
  const [state, formAction] = useFormState<Result, FormData>(registerOperator, null);

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-8 sm:px-6">
      <header className="flex items-center gap-3">
        <Link href="/dashboard" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Operators</h1>
          <p className="text-sm text-gray-500">Register a new operator, or open anyone&apos;s book.</p>
        </div>
      </header>

      {/* Register */}
      <section className="rounded-2xl border border-brand/25 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-brand-dark" />
          <h2 className="font-bold text-gray-900">Register a new operator</h2>
        </div>

        {state?.ok ? (
          <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            <p className="flex items-center gap-2 font-semibold"><Check className="h-4 w-4" /> Registered ✅</p>
            <p className="mt-1">They can text <span className="font-semibold">(971) 462-5343</span> right now — it goes to their own private book. They can also sign in at <span className="font-mono">/dashboard</span> with the password you set. Send them a text to say hi so they get the welcome message.</p>
          </div>
        ) : (
          <form action={formAction} className="space-y-3">
            <Field name="ownerName" label="Their name" placeholder="Miguel Torres" />
            <Field name="businessName" label="Business name" placeholder="Torres Landscaping" />
            <Field name="phone" label="Their mobile number" type="tel" placeholder="(503) 555-0142" />
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-600">Default language</span>
                <select name="lang" defaultValue="es" className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 focus:border-brand focus:outline-none">
                  <option value="es">Spanish</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-600">Timezone</span>
                <select name="timezone" defaultValue="America/Los_Angeles" className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 focus:border-brand focus:outline-none">
                  {TZs.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <Field name="password" label="Dashboard password (you choose, share with them)" placeholder="at least 6 characters" />

            {state?.error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{state.error}</p>}
            <SubmitButton />
          </form>
        )}
      </section>

      {/* Existing operators */}
      <section>
        <h2 className="mb-3 text-base font-bold text-gray-900">All operators ({businesses.length})</h2>
        <div className="divide-y divide-gray-50 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          {businesses.map((b) => (
            <div key={b.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-gray-900">{b.name} <span className="ml-1 rounded bg-gray-100 px-1.5 text-xs font-medium text-gray-500">{b.lang}</span></p>
                  <p className="truncate text-xs text-gray-500">{b.owner} · {b.phone}{!b.hasPassword && " · no dashboard login yet"}</p>
                </div>
                <form action={switchBusiness}>
                  <input type="hidden" name="businessId" value={b.id} />
                  <button className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:border-brand/40">
                    <Eye className="h-4 w-4" /> Open book
                  </button>
                </form>
              </div>
              <form action={setBusinessPassword} className="mt-2 flex gap-2">
                <input type="hidden" name="businessId" value={b.id} />
                <input name="password" placeholder={b.hasPassword ? "Reset dashboard password" : "Set a dashboard password (6+ chars)"} className="min-h-[40px] flex-1 rounded-lg border border-gray-200 px-2 text-sm focus:border-brand focus:outline-none" />
                <button className="min-h-[40px] shrink-0 rounded-lg bg-brand/10 px-3 text-sm font-medium text-brand-dark hover:bg-brand/20">Save</button>
              </form>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function Field({ name, label, type, placeholder }: { name: string; label: string; type?: string; placeholder?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-gray-600">{label}</span>
      <input name={name} type={type ?? "text"} required placeholder={placeholder} className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" />
    </label>
  );
}
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="min-h-[44px] w-full rounded-xl bg-brand px-4 font-medium text-white hover:bg-brand-dark disabled:opacity-60">
      {pending ? "Registering…" : "Register operator"}
    </button>
  );
}
