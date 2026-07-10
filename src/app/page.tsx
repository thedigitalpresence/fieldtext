import Link from "next/link";
import { Check, Repeat } from "lucide-react";
import DemoWidget from "./DemoWidget";
import { Logo, IconBubble } from "./Logo";

export const metadata = { title: "FieldText: Run your business by text" };

const FOR_WHO = ["Landscapers", "Handymen", "House cleaners", "Painters", "Pool techs", "Pressure washers"];
const FEATURES = [
  "Log quotes, jobs, and payments as they happen",
  "Notes and photos on every client (gate codes, dogs, before/after)",
  "\"Who owes me?\" gets an instant answer",
  "\"Invoice Bob\" makes one you can forward to get paid",
  "Ask anything, like \"what's Monday look like?\"",
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center gap-10 px-6 py-14 text-center">
      {/* Hero */}
      <div className="flex flex-col items-center gap-5">
        <Logo className="h-12 w-12 text-brand drop-shadow-sm" />
        <h1 className="text-4xl font-bold tracking-tight">
          Field<span className="text-brand">Text</span>
        </h1>
        <div className="flex max-w-lg flex-col gap-2 text-gray-600 [text-wrap:balance]">
          <p className="text-xl font-semibold text-gray-900">Run your whole business with a text message.</p>
          <p className="text-lg">One number keeps everything straight and texts&nbsp;you&nbsp;back.</p>
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

      {/* Marquee feature: the follow-up close loop */}
      <section className="w-full max-w-lg rounded-2xl border border-brand/25 bg-brand/5 p-6 text-left shadow-sm">
        <div className="flex items-center gap-2.5">
          <IconBubble Icon={Repeat} className="h-11 w-11 shrink-0" />
          <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">Never let a quote go cold</p>
        </div>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-gray-900">It chases every quote for you.</h2>
        <p className="mt-2 text-gray-600">
          Send a quote and FieldText remembers so you don&apos;t have to. Everyone gets a
          <span className="font-semibold text-gray-900"> 4-touch follow-up</span>. It keeps checking in with you until
          the job is won or the customer&apos;s out.
        </p>
      </section>

      {/* What else it does */}
      <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-dark">It all happens right in your texts</p>
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
