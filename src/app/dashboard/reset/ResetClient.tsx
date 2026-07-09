"use client";

import { useFormState, useFormStatus } from "react-dom";
import { requestResetAction, completeResetAction } from "../actions";

type Step1 = { sent: boolean; phone: string; error?: string };

export default function ResetClient() {
  const [step1, requestAction] = useFormState<Step1, FormData>(requestResetAction, { sent: false, phone: "" });

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold">Reset password</h1>

        {!step1.sent ? (
          <>
            <p className="mt-1 text-sm text-gray-600">Enter your mobile number and we&apos;ll text you a code.</p>
            <form action={requestAction} className="mt-5 space-y-3">
              <input
                name="phone"
                type="tel"
                required
                autoFocus
                placeholder="(555) 123-4567"
                className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              {step1.error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{step1.error}</p>}
              <Submit label="Text me a code" pendingLabel="Sending…" />
            </form>
          </>
        ) : (
          <Step2 phone={step1.phone} />
        )}

        <p className="mt-4 text-center text-sm">
          <a href="/dashboard/login" className="text-brand hover:underline">Back to sign in</a>
        </p>
      </div>
    </main>
  );
}

function Step2({ phone }: { phone: string }) {
  const [state, action] = useFormState<{ ok: boolean; error?: string }, FormData>(completeResetAction, { ok: false });
  return (
    <>
      <p className="mt-1 text-sm text-gray-600">
        We texted a 6-digit code to <span className="font-medium">{maskPhone(phone)}</span>. Enter it and choose a new password.
      </p>
      <form action={action} className="mt-5 space-y-3">
        <input type="hidden" name="phone" value={phone} />
        <input
          name="code"
          inputMode="numeric"
          required
          autoFocus
          placeholder="6-digit code"
          className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 tracking-widest focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <input
          name="password"
          type="password"
          required
          placeholder="New password (6+ characters)"
          className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        {state.error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{state.error}</p>}
        <Submit label="Set new password" pendingLabel="Saving…" />
      </form>
    </>
  );
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-[44px] w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-dark disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function maskPhone(p: string): string {
  return p.length >= 4 ? `•••• ${p.slice(-4)}` : p;
}
