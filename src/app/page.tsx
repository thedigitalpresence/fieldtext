import Link from "next/link";
import { Leaf, Check } from "lucide-react";
import DemoWidget from "./DemoWidget";

export const metadata = { title: "FieldText: Run your business by text" };

const FOR_WHO = ["Landscapers", "Handymen", "House cleaners", "Painters", "Pool techs", "Pressure washers"];
const FEATURES = [
  "Text one number in plain language, English or Spanish",
  "Log quotes, jobs, and payments as they happen",
  "Keep notes and photos on every client (gate codes, dogs, before and after pics)",
  "Set reminders and get automatic follow-ups so nothing slips through",
  "Ask it anything, like \"who owes me?\" or \"what's Monday look like?\"",
  "It tracks who owes you and makes invoices you can forward to get paid",
  "Bring your whole client list by paste, spreadsheet, or a photo of your notebook",
  "A clean dashboard of your whole book, on your phone or computer",
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center gap-10 px-6 py-14 text-center">
      {/* Hero */}
      <div className="flex flex-col items-center gap-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-sm"><Leaf className="h-6 w-6" /></span>
        <h1 className="text-4xl font-bold tracking-tight">
          Field<span className="text-brand">Text</span>
        </h1>
        <div className="flex max-w-lg flex-col gap-2 text-gray-600">
          <p className="text-xl font-semibold text-gray-900">Run your whole business with a text message.</p>
          <p className="text-lg">If you work out of a truck, FieldText is your black book.</p>
          <p className="text-lg">Text one number like you talk. It keeps everything straight and texts you back.</p>
        </div>
        <p className="max-w-md text-sm text-gray-500">
          Built for people in the field: {FOR_WHO.join(", ")}, and anyone who runs jobs on the go.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-xl bg-brand px-6 py-3 font-semibold text-white shadow-sm hover:bg-brand-dark"
          >
            Become a beta tester
          </Link>
          <Link
            href="/dashboard"
            className="rounded-xl border border-gray-300 bg-white px-5 py-3 font-medium text-gray-700 hover:border-brand/40"
          >
            Sign in
          </Link>
        </div>
      </div>

      {/* Demo */}
      <DemoWidget />

      {/* What it does */}
      <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">What it does</p>
        <ul className="mx-auto mt-4 max-w-sm space-y-2 text-left text-sm text-gray-600">
          {FEATURES.map((f) => (
            <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{f}</li>
          ))}
        </ul>
        <p className="mt-5 text-sm font-medium text-brand-dark">Free while we&apos;re in beta.</p>
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
