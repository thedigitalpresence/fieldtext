import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">
        Field<span className="text-brand">Text</span>
      </h1>
      <p className="max-w-md text-gray-600">
        Run your landscaping business by text. Log quotes, jobs, payments, and reminders
        in plain language — FieldText understands it, saves it, and texts you back.
      </p>
      <Link
        href="/dashboard"
        className="rounded-lg bg-brand px-5 py-2.5 font-medium text-white hover:bg-brand-dark"
      >
        Owner dashboard
      </Link>
    </main>
  );
}
