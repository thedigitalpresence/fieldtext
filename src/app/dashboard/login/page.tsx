import { login } from "../actions";
import { getBusiness } from "@/lib/supabase";
import { businessLang } from "@/lib/templates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: { error?: string; next?: string; mins?: string } }) {
  // Localize the one pre-auth page too (the rest of the product is bilingual).
  let es = false;
  try {
    es = businessLang(await getBusiness()) === "es";
  } catch {
    // no business row yet — default English
  }
  const T = {
    title: es ? "Iniciar sesión" : "Sign in",
    sub: es ? "Entra con tu número de teléfono y contraseña." : "Sign in with your mobile number and password.",
    phone: es ? "Número de teléfono" : "Mobile number",
    password: es ? "Contraseña" : "Password",
    error: es ? "Número o contraseña incorrectos." : "Wrong number or password.",
    locked: es
      ? `Demasiados intentos. Espera ${searchParams.mins ?? "15"} minutos.`
      : `Too many attempts. Try again in ${searchParams.mins ?? "15"} minutes.`,
    button: es ? "Entrar" : "Sign in",
    signup: es ? "¿No tienes cuenta? Regístrate" : "Don't have an account? Sign up",
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6" lang={es ? "es" : "en"}>
      <form action={login} className="rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold">{T.title}</h1>
        <p className="mt-1 text-sm text-gray-600">{T.sub}</p>
        <input type="hidden" name="next" value={searchParams.next ?? "/dashboard"} />

        <label className="mt-5 block text-sm font-medium text-gray-600" htmlFor="phone">{T.phone}</label>
        <input
          id="phone"
          type="tel"
          name="phone"
          autoFocus
          placeholder="(555) 123-4567"
          className="mt-1 min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />

        <label className="mt-3 block text-sm font-medium text-gray-600" htmlFor="password">{T.password}</label>
        <input
          id="password"
          type="password"
          name="password"
          required
          placeholder="••••••••"
          className="mt-1 min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />

        {searchParams.error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {searchParams.error === "locked" ? T.locked : T.error}
          </p>
        )}
        <button type="submit" className="mt-4 min-h-[44px] w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-dark">
          {T.button}
        </button>
        <p className="mt-4 text-center text-sm">
          <a href="/signup" className="text-brand hover:underline">{T.signup}</a>
        </p>
      </form>
    </main>
  );
}
