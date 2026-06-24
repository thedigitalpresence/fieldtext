"use client";

import { useState } from "react";

// Public consent / signup page. Used as opt-in proof for Twilio Toll-Free / A2P
// verification, and as the real front door for onboarding operators.
export default function SignupPage() {
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
          <div className="mb-3 text-4xl">🌱</div>
          <h1 className="mb-2 text-2xl font-bold">You&apos;re set!</h1>
          <p className="text-gray-600">
            We&apos;ll text you from FieldText to get started. Reply <span className="font-semibold">STOP</span> anytime to opt out.
          </p>
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
          Run your landscaping business by text. Log quotes, jobs, payments, and reminders in plain language —
          FieldText understands it, saves it, and texts you back. Sign up to start.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setDone(true);
          }}
          className="mt-6 space-y-4"
        >
          <Field label="Your name" name="name" type="text" required />
          <Field label="Business name" name="business" type="text" required />
          <Field label="Mobile number" name="phone" type="tel" required placeholder="(555) 123-4567" />

          <label className="flex items-start gap-2 text-sm text-gray-600">
            <input type="checkbox" required className="mt-1 h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand" />
            <span>
              I agree to receive recurring text messages from <span className="font-medium">FieldText</span> — quote and job
              reminders, follow-up nudges, confirmations, and account notifications — at the mobile number I provided.
              Message frequency varies. Message &amp; data rates may apply. Reply <span className="font-semibold">STOP</span> to
              opt out and <span className="font-semibold">HELP</span> for help.
            </span>
          </label>

          <button
            type="submit"
            className="w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-dark"
          >
            Sign up &amp; get started by text
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-400">
          By signing up you agree to our terms and to receive SMS as described above. We never share your number with
          third parties for marketing. Reply STOP to cancel, HELP for help.
        </p>
      </div>
    </main>
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
