import { login } from "../actions";
import { getBusiness } from "@/lib/supabase";
import { businessLang } from "@/lib/templates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: { error?: string; next?: string } }) {
  // Localize the one pre-auth page too (the rest of the product is bilingual).
  let es = false;
  try {
    es = businessLang(await getBusiness()) === "es";
  } catch {
    // no business row yet — default English
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6" lang={es ? "es" : "en"}>
      <form action={login} className="rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold">{es ? "Acceso del dueño" : "Owner login"}</h1>
        <p className="mt-1 text-sm text-gray-600">{es ? "Escribe la contraseña de tu panel." : "Enter your dashboard password."}</p>
        <input type="hidden" name="next" value={searchParams.next ?? "/dashboard"} />
        <label className="sr-only" htmlFor="password">{es ? "Contraseña" : "Password"}</label>
        <input
          id="password"
          type="password"
          name="password"
          required
          autoFocus
          placeholder={es ? "Contraseña" : "Password"}
          className="mt-5 min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        {searchParams.error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{es ? "Contraseña incorrecta." : "Incorrect password."}</p>
        )}
        <button type="submit" className="mt-4 min-h-[44px] w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-dark">
          {es ? "Entrar" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
