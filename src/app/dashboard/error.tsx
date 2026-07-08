"use client";

// Branded error boundary with a retry — instead of Next's unstyled default.
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-4xl">🌱</div>
      <h1 className="text-xl font-bold text-gray-900">Something went wrong loading your book</h1>
      <p className="text-sm text-gray-500">
        Your data is safe — this is usually a hiccup reaching the database. Try again, and if it keeps
        happening, email <a className="text-brand underline" href="mailto:eric@fieldtextapp.com">eric@fieldtextapp.com</a>.
      </p>
      <button
        onClick={reset}
        className="min-h-[44px] rounded-xl bg-brand px-5 font-medium text-white hover:bg-brand-dark"
      >
        Try again
      </button>
    </main>
  );
}
