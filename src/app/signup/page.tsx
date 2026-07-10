"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { submitWaitlist, type WaitlistResult } from "./actions";
import { Logo } from "@/app/Logo";

// Public BETA WAITLIST page. During beta this does NOT create an account — it
// saves a lead the founder reviews and hand-picks from. Also serves as written
// opt-in proof for Twilio A2P (we text selected testers). The full account
// flow is preserved in actions.ts (submitSignup) for open self-serve later.
export default function SignupPage() {
  const [state, formAction] = useFormState<WaitlistResult | null, FormData>(submitWaitlist, null);

  if (state?.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
          <Logo className="mx-auto mb-3 h-12 w-12 text-brand" />
          <h1 className="mb-2 text-2xl font-bold">You&apos;re on the list</h1>
          <p className="text-gray-600">
            Thanks for signing up for the FieldText beta. We&apos;re onboarding a small group at a time, by hand,
            so it stays personal. We&apos;ll <span className="font-medium">text you soon</span> to get you set up.
          </p>
          <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
            Questions in the meantime? Email{" "}
            <a href="mailto:eric@fieldtextapp.com" className="font-medium text-brand underline">eric@fieldtextapp.com</a>.
          </p>
          <p className="mt-3 text-xs text-gray-400">Reply STOP anytime to opt out · HELP for help.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-bold tracking-tight">
          Join the Field<span className="text-brand">Text</span> beta
        </h1>
        <p className="mt-1 text-gray-600">
          We&apos;re opening up to a small group of field-service pros first. Tell us a bit about you and
          we&apos;ll reach out to get you set up. This just adds you to the list — no account is created yet.
        </p>

        <form action={formAction} className="mt-6 space-y-4">
          <Field label="Your name" name="name" type="text" required />
          <Field label="Business name" name="business" type="text" placeholder="Optional" />
          <Field label="Mobile number" name="phone" type="tel" required placeholder="(555) 123-4567" />
          <Field label="What do you do?" name="trade" type="text" required placeholder="Landscaper, handyman, cleaner…" />
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="needs">What do you need it for?</label>
            <textarea
              id="needs"
              name="needs"
              rows={3}
              placeholder="What&apos;s a headache you'd want this to take off your plate?"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="language">Language</label>
              <select id="language" name="language" defaultValue="en" className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand">
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="timezone">Time zone</label>
              <select id="timezone" name="timezone" defaultValue="America/Los_Angeles" className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand">
                <option value="America/Los_Angeles">Pacific</option>
                <option value="America/Denver">Mountain</option>
                <option value="America/Phoenix">Arizona</option>
                <option value="America/Chicago">Central</option>
                <option value="America/New_York">Eastern</option>
                <option value="America/Anchorage">Alaska</option>
                <option value="Pacific/Honolulu">Hawaii</option>
              </select>
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-600">
            <input name="consent" type="checkbox" required className="mt-1 h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand" />
            <span>
              I agree to receive recurring SMS text messages from <span className="font-medium">FieldText</span> at the mobile
              number I provided, to log and manage my business, including confirmations, quote and job reminders, follow-up
              nudges, and account notifications. Message frequency varies. Message &amp; data rates may apply. Reply{" "}
              <span className="font-semibold">STOP</span> to opt out and <span className="font-semibold">HELP</span> for help.
              Consent is not a condition of any purchase.
            </span>
          </label>

          {state?.error && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{state.error}</p>
          )}

          <SubmitButton />
        </form>

        <p className="mt-4 text-center text-xs text-gray-400">
          By joining you agree to our <Link href="/terms" className="underline hover:text-gray-600">terms</Link> and{" "}
          <Link href="/privacy" className="underline hover:text-gray-600">privacy policy</Link>, and to receive SMS as
          described above. We never share your number with third parties for marketing. Reply STOP to cancel, HELP for help.
        </p>
      </div>
    </main>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-[44px] w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-dark disabled:opacity-60"
    >
      {pending ? "Adding you…" : "Join the beta list"}
    </button>
  );
}

function Field(props: { label: string; name: string; type: string; required?: boolean; placeholder?: string }) {
  const { label, ...rest } = props;
  return (
    <div>
      <label className="mb-1 block text-sm font-medium" htmlFor={rest.name}>
        {label}
      </label>
      <input
        id={rest.name}
        {...rest}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
      />
    </div>
  );
}
