// Public terms of service. Brief and plain. Public (not under /dashboard).
export const metadata = { title: "Terms of Service — FieldText" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">
        Terms of <span className="text-brand">Service</span>
      </h1>
      <p className="mt-1 text-sm text-gray-500">Last updated: June 2026</p>

      <div className="mt-8 space-y-6 text-gray-700">
        <Section title="The service">
          FieldText, operated by Shack&apos;s Landing LLC, lets a landscaping business owner log and manage
          their business by text message — quotes, clients, jobs, payments, and reminders — and receive
          confirmations, reminders, and answers by SMS.
        </Section>

        <Section title="Your account">
          You are responsible for the accuracy of the information you provide and for activity on your
          account. Only authorized phone numbers you register may text the service.
        </Section>

        <Section title="Messaging consent">
          By signing up and providing your mobile number, you agree to receive recurring SMS from
          FieldText as described in our{" "}
          <a className="text-brand underline" href="/privacy">Privacy Policy</a>. Message frequency varies;
          message &amp; data rates may apply. Reply <strong>STOP</strong> to opt out, <strong>HELP</strong>{" "}
          for help.
        </Section>

        <Section title="Acceptable use">
          Use FieldText only for your own legitimate business. Do not use it for unlawful, harassing, or
          deceptive messaging. We may suspend accounts that violate these terms or carrier rules.
        </Section>

        <Section title="Disclaimer">
          The service is provided &quot;as is.&quot; We work hard to keep it reliable, but we don&apos;t
          guarantee uninterrupted or error-free operation. FieldText is a record-keeping and reminder
          tool, not a substitute for your own business judgment.
        </Section>

        <Section title="Contact">
          Questions? Email{" "}
          <a className="text-brand underline" href="mailto:eashackelford@gmail.com">eashackelford@gmail.com</a>.
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 leading-relaxed">{children}</p>
    </section>
  );
}
