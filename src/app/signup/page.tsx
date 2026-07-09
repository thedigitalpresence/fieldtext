"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { submitSignup, type SignupResult } from "./actions";

// Public consent / signup page. Used as opt-in proof for Twilio A2P
// verification, and as the real front door for onboarding operators.
// The form SAVES: signups table + proof-of-consent + founder SMS alert.
export default function SignupPage() {
  const [state, formAction] = useFormState<SignupResult | null, FormData>(submitSignup, null);

  if (state?.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
          <div className="mb-3 text-4xl">🌱</div>
          <h1 className="mb-2 text-2xl font-bold">One last step</h1>
          <p className="text-gray-600">
            Text <span className="font-semibold">START</span> to{" "}
            <a href="sms:+19714625343" className="font-semibold text-brand underline">(971) 462-5343</a>{" "}
            from your phone to activate. That confirms it&apos;s really you, and your black book goes live instantly.
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
          Field<span className="text-brand">Text</span>
        </h1>
        <p className="mt-1 text-gray-600">
          Run your business by text. Landscapers, handymen, cleaners, painters, pool techs, and anyone
          working out of a truck. Log quotes, jobs, payments, and reminders in plain language. FieldText
          saves it and texts you back. Sign up to join the beta.
        </p>

        <form action={formAction} className="mt-6 space-y-4">
          <Field label="Your name" name="name" type="text" required />
          <Field label="Business name" name="business" type="text" required />
          <Field label="Mobile number" name="phone" type="tel" required placeholder="(555) 123-4567" />
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="language">Language</label>
            <select id="language" name="language" defaultValue="en" className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand">
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
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
          By signing up you agree to our <Link href="/terms" className="underline hover:text-gray-600">terms</Link> and{" "}
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
      {pending ? "Signing you up…" : "Sign up & get started by text"}
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
