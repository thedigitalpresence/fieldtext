import { login } from "../actions";

export const dynamic = "force-dynamic";

export default function LoginPage({ searchParams }: { searchParams: { error?: string; next?: string } }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <form action={login} className="rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold">Owner login</h1>
        <p className="mt-1 text-sm text-gray-600">Enter your dashboard password.</p>
        <input type="hidden" name="next" value={searchParams.next ?? "/dashboard"} />
        <input
          type="password"
          name="password"
          required
          autoFocus
          placeholder="Password"
          className="mt-5 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        {searchParams.error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Incorrect password.</p>
        )}
        <button type="submit" className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-dark">
          Sign in
        </button>
      </form>
    </main>
  );
}
