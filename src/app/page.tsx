import Link from "next/link";
import { Leaf, Check } from "lucide-react";
import DemoWidget from "./DemoWidget";

export const metadata = { title: "FieldText — Run your landscaping business by text" };

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center gap-10 px-6 py-14 text-center">
      {/* Hero */}
      <div className="flex flex-col items-center gap-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-sm"><Leaf className="h-6 w-6" /></span>
        <h1 className="text-4xl font-bold tracking-tight">
          Field<span className="text-brand">Text</span>
        </h1>
        <p className="max-w-md text-lg text-gray-600">
          Run your whole landscaping business with a text message. Quotes, jobs, payments,
          reminders — text one number in plain language, English or Spanish. No app to learn.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-xl bg-brand px-6 py-3 font-semibold text-white shadow-sm hover:bg-brand-dark"
          >
            Get started — founding member $29/mo
          </Link>
          <Link
            href="/dashboard"
            className="rounded-xl border border-gray-300 bg-white px-5 py-3 font-medium text-gray-700 hover:border-brand/40"
          >
            Owner sign in
          </Link>
        </div>
      </div>

      {/* Demo */}
      <DemoWidget />

      {/* Pricing — on the page, no "contact us" games */}
      <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">Simple pricing</p>
        <div className="mt-2 flex items-baseline justify-center gap-2">
          <span className="text-4xl font-bold tracking-tight text-gray-900">$49</span>
          <span className="text-gray-500">/month</span>
        </div>
        <p className="mt-1 text-sm font-medium text-brand-dark">
          Founding members: $29/mo locked for life — first 10 businesses only.
        </p>
        <ul className="mx-auto mt-4 max-w-xs space-y-2 text-left text-sm text-gray-600">
          {[
            "Unlimited texting — your whole black book by SMS",
            "Automatic quote follow-ups + morning day sheet",
            "Knows who owes you — invoices your customers can open",
            "Concierge setup: text a photo of your notebook, we load it",
            "English + Spanish, you and your crew",
          ].map((f) => (
            <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{f}</li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-gray-400">30-day pilot. No contract — export your data anytime.</p>
      </section>

      {/* Footer */}
      <footer className="flex items-center gap-4 text-xs text-gray-400">
        <Link href="/privacy" className="hover:text-gray-600 hover:underline">Privacy</Link>
        <span>·</span>
        <Link href="/terms" className="hover:text-gray-600 hover:underline">Terms</Link>
        <span>·</span>
        <a href="mailto:eric@fieldtextapp.com" className="hover:text-gray-600 hover:underline">eric@fieldtextapp.com</a>
      </footer>
    </main>
  );
}
