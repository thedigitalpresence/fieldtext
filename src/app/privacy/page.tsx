// Public privacy policy. Plain, SMS-focused — what carriers look for in
// toll-free / A2P verification. Not under /dashboard, so it's publicly viewable.
export const metadata = { title: "Privacy Policy — FieldText" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">
        Privacy <span className="text-brand">Policy</span>
      </h1>
      <p className="mt-1 text-sm text-gray-500">Last updated: June 2026</p>

      <div className="prose mt-8 space-y-6 text-gray-700">
        <Section title="Who we are">
          FieldText is a text-message-based CRM and reminder assistant for landscaping business owners,
          operated by Shack&apos;s Landing LLC. This policy explains what we collect and how we use it.
        </Section>

        <Section title="What we collect">
          When you sign up and use FieldText, we collect your name, business name, and mobile phone
          number, and the business information you choose to text us — such as client names, addresses,
          quotes, jobs, payments, and reminders. We also keep a log of the text messages you send and the
          replies we send back, so the service works and you have a record.
        </Section>

        <Section title="How we use your information">
          We use your information only to provide the service: to understand and store what you text in,
          to text you back confirmations, reminders, and follow-up nudges, and to answer questions you
          ask. We do not use it for anything else.
        </Section>

        <Section title="Text messages (SMS)">
          By providing your mobile number and opting in, you consent to receive recurring SMS from
          FieldText — confirmations, reminders, follow-up nudges, and account notifications. Message
          frequency varies. Message &amp; data rates may apply. Reply <strong>STOP</strong> at any time to
          opt out, or <strong>HELP</strong> for help. Opting out stops all further messages.
        </Section>

        <Section title="Sharing">
          <strong>We do not sell your information, and we never share your mobile number or messaging
          consent with third parties for marketing.</strong> We use a small number of service providers
          to run FieldText (for example, hosting, database, an SMS carrier, and a language model used only
          to interpret your texts) — they process your data solely to provide those functions on our
          behalf.
        </Section>

        <Section title="Data retention &amp; security">
          We keep your data for as long as your account is active, and protect it with industry-standard
          measures. You can ask us to delete your data at any time.
        </Section>

        <Section title="Contact">
          Questions about this policy or your data? Email{" "}
          <a className="text-brand underline" href="mailto:eric@fieldtextapp.com">eric@fieldtextapp.com</a>.
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900" dangerouslySetInnerHTML={{ __html: title }} />
      <p className="mt-1 leading-relaxed">{children}</p>
    </section>
  );
}
