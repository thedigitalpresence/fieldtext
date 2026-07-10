import Link from "next/link";
import { currentBusiness } from "@/lib/supabase";
import { config } from "@/lib/config";
import { businessLang } from "@/lib/templates";
import { Logo } from "@/app/Logo";
import {
  ArrowLeft, FileText, DollarSign, Repeat, StickyNote, Receipt, MessageCircle,
  UserCog, Wrench, Globe, LifeBuoy,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Help & guide", robots: { index: false, follow: false } };

function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

// One example: what you text → what FieldText texts back. [en, es] pairs.
type Ex = { you: [string, string]; ft: [string, string] };
type Section = { Icon: typeof FileText; title: [string, string]; blurb?: [string, string]; examples: Ex[] };

const SECTIONS: Section[] = [
  {
    Icon: FileText,
    title: ["Log a quote", "Registra una cotización"],
    blurb: [
      "Just say who and how much. FieldText saves it and starts chasing the follow-up for you.",
      "Solo di a quién y cuánto. FieldText lo guarda y empieza a darle seguimiento por ti.",
    ],
    examples: [
      {
        you: ["quoted Jane at 5 Oak St for $200/mo mowing", "coticé a Jane en 5 Oak por $200/mes"],
        ft: ["Got it ✅ Jane · $200/mo · Quoted. I'll chase the follow-up.", "Listo ✅ Jane · $200/mes · Cotizada. Le doy seguimiento."],
      },
      {
        you: ["need to send quote for Bob", "necesito mandar cotización a Bob"],
        ft: ["Added Bob as a prospect 📝. What's the address and a phone for Bob?", "Agregué a Bob como prospecto 📝. ¿Dirección y teléfono de Bob?"],
      },
    ],
  },
  {
    Icon: Repeat,
    title: ["The follow-up loop", "El seguimiento"],
    blurb: [
      "After a quote, FieldText nudges you until it's won or out. Reply IN, OUT, or 'no reply' — it schedules the next check (say 'remind me friday' to pick your own time).",
      "Después de una cotización, FieldText te recuerda hasta cerrarla. Responde ADENTRO, FUERA o 'sin respuesta' — agenda el siguiente aviso (di 'recuérdame el viernes' para elegir cuándo).",
    ],
    examples: [
      {
        you: ["(FieldText) Did you send Jane's quote? SENT / NOT YET / IN / OUT", "(FieldText) ¿Mandaste la cotización de Jane? ENVIADA / TODAVÍA NO / ADENTRO / FUERA"],
        ft: ["", ""],
      },
      {
        you: ["they're in", "adentro"],
        ft: ["🎉 Jane's in! Moved them to active.", "🎉 ¡Jane adentro! La pasé a activa."],
      },
      {
        you: ["no reply yet", "sin respuesta aún"],
        ft: ["👍 Staying on Jane — I'll check back in 6h.", "👍 Le sigo la pista a Jane — te aviso en 6 h."],
      },
    ],
  },
  {
    Icon: Wrench,
    title: ["Log a job", "Registra un trabajo"],
    blurb: ["Tell it what you did. It dates it and moves the client's next visit forward.", "Dile qué hiciste. Lo fecha y adelanta la próxima visita del cliente."],
    examples: [
      {
        you: ["mowed the smiths", "podé a los Smith"],
        ft: ["Logged ✅ mowing for The Smiths. Next visit in 7 days.", "Registrado ✅ podado para los Smith. Próxima visita en 7 días."],
      },
    ],
  },
  {
    Icon: DollarSign,
    title: ["Log a payment", "Registra un pago"],
    blurb: ["Payments settle what a client owes, so 'who owes me?' stays right.", "Los pagos saldan lo que debe un cliente, así 'quién me debe' queda al día."],
    examples: [
      {
        you: ["Bob paid 300", "Bob pagó 300"],
        ft: ["Payment ✅ $300 from Bob — Bob's all settled ✅", "Pago ✅ $300 de Bob — Bob está al día ✅"],
      },
      {
        you: ["Elena owes 450", "Elena debe 450"],
        ft: ["Noted ✅ Elena owes $450.", "Anotado ✅ Elena debe $450."],
      },
    ],
  },
  {
    Icon: StickyNote,
    title: ["Notes & photos", "Notas y fotos"],
    blurb: ["Keep gate codes, dogs, and details on a client. Text a photo and reply with the name to attach it.", "Guarda códigos de portón, perros y detalles. Manda una foto y responde con el nombre para adjuntarla."],
    examples: [
      {
        you: ["note for Elena: gate code 1187, big dog", "nota para Elena: código 1187, perro grande"],
        ft: ["Note saved ✅ to Elena.", "Nota guardada ✅ en Elena."],
      },
      {
        you: ["[photo] the smiths", "[foto] los Smith"],
        ft: ["Saved the photo to The Smiths 📸", "Guardé la foto en los Smith 📸"],
      },
    ],
  },
  {
    Icon: Receipt,
    title: ["Log an expense", "Registra un gasto"],
    blurb: ["Track costs. Add 'for <client>' and it saves to their card for job costing.", "Controla costos. Agrega 'para <cliente>' y se guarda en su ficha."],
    examples: [
      {
        you: ["spent 100 on mulch for Elena", "gasté 100 en mantillo para Elena"],
        ft: ["Expense ✅ $100 — mulch · saved to Elena's card.", "Gasto ✅ $100 — mantillo · guardado en Elena."],
      },
    ],
  },
  {
    Icon: MessageCircle,
    title: ["Ask anything", "Pregunta lo que sea"],
    blurb: ["Ask about your book in plain words.", "Pregunta sobre tu libreta con palabras normales."],
    examples: [
      { you: ["who owes me?", "¿quién me debe?"], ft: ["Bob owes $450 · Elena owes $120. Everyone else is settled ✅", "Bob debe $450 · Elena debe $120. Los demás al día ✅"] },
      { you: ["what's Monday look like?", "¿qué tengo el lunes?"], ft: ["☀️ Mon, sunny 72°. • The Smiths • Garcia • Jane", "☀️ Lun, soleado 72°. • Los Smith • Garcia • Jane"] },
      { you: ["Elena's notes", "notas de Elena"], ft: ["Elena: gate code 1187, big dog.", "Elena: código 1187, perro grande."] },
    ],
  },
  {
    Icon: UserCog,
    title: ["Manage clients", "Administra clientes"],
    blurb: ["Pause, bring back, reschedule, change a price, or remove someone.", "Pausa, reactiva, reagenda, cambia un precio o quita a alguien."],
    examples: [
      { you: ["pause the smiths until april", "pausa a los Smith hasta abril"], ft: ["Paused ⏸ The Smiths until Apr. Off the schedule, not lost.", "Pausado ⏸ los Smith hasta abr. Fuera del calendario, no perdidos."] },
      { you: ["move garcia to friday", "mueve a Garcia al viernes"], ft: ["Moved ✅ Garcia → Fri.", "Movido ✅ Garcia → vie."] },
      { you: ["the smiths are now 350", "los Smith ahora son 350"], ft: ["Updated ✅ The Smiths → $350/mo.", "Actualizado ✅ los Smith → $350/mes."] },
      { you: ["remove Bob", "quita a Bob"], ft: ["Done — took Bob off your active list. Pause instead? Reply 'pause Bob'.", "Listo — quité a Bob. ¿Mejor pausar? Responde 'pausa Bob'."] },
    ],
  },
];

export default async function HelpPage() {
  const business = await currentBusiness();
  const lang = businessLang(business);
  const es = lang === "es";
  const i = (pair: [string, string]) => (es ? pair[1] : pair[0]);
  const number = config.twilio.fromNumber();

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6" lang={lang}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Logo className="h-10 w-10 shrink-0 text-brand" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">{es ? "Cómo usar FieldText" : "How to use FieldText"}</h1>
            {number && <p className="text-sm text-gray-500">{es ? "Tu número: " : "Your number: "}<span className="font-semibold text-brand-dark">{fmtPhone(number)}</span></p>}
          </div>
        </div>
        <Link href="/dashboard" className="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:border-brand/40">
          <ArrowLeft className="h-4 w-4" />{es ? "Panel" : "Dashboard"}
        </Link>
      </div>

      {/* Intro */}
      <section className="rounded-2xl border border-brand/25 bg-brand/5 p-5">
        <p className="text-sm leading-6 text-gray-700">
          {es
            ? "Escríbele a FieldText como le hablarías a un ayudante — en español o inglés, con palabras normales. No hay comandos que memorizar. Abajo tienes ejemplos de todo lo que puede hacer. Si algo no queda claro, escribe AYUDA al número y te muestra un menú."
            : "Text FieldText like you'd text a helper — in plain words, English or Spanish. There are no commands to memorize. Below are examples of everything it can do. If you're ever stuck, text HELP to the number for a quick menu."}
        </p>
      </section>

      {/* Sections */}
      {SECTIONS.map((s) => (
        <section key={s.title[0]} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-dark"><s.Icon className="h-5 w-5" /></span>
            <h2 className="text-lg font-bold text-gray-900">{i(s.title)}</h2>
          </div>
          {s.blurb && <p className="mt-2 text-sm leading-6 text-gray-600">{i(s.blurb)}</p>}
          <div className="mt-3 space-y-2.5">
            {s.examples.map((ex, idx) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex justify-end">
                  <span className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3 py-2 text-sm text-white">{i(ex.you)}</span>
                </div>
                {i(ex.ft) && (
                  <div className="flex justify-start">
                    <span className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-sm text-gray-800">{i(ex.ft)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* Fix mistakes */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-dark"><Wrench className="h-5 w-5" /></span>
          <h2 className="text-lg font-bold text-gray-900">{es ? "Corregir un error" : "Fix a mistake"}</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          {es
            ? 'Si algo salió mal, responde "corrige" y dime qué cambiar — p. ej. "corrige, es 333 no 233". También puedes editar o borrar cualquier cosa en el panel.'
            : 'If something came out wrong, reply "fix" and tell me what to change — e.g. "fix, it\'s 333 not 233". You can also edit or delete anything from the dashboard.'}
        </p>
      </section>

      {/* Language + opt out */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-dark"><Globe className="h-5 w-5" /></span>
          <h2 className="text-lg font-bold text-gray-900">{es ? "Idioma y opciones" : "Language & opt-out"}</h2>
        </div>
        <ul className="mt-2 space-y-1.5 text-sm leading-6 text-gray-600">
          <li>• {es ? "Escribe en español o inglés — te responde en el mismo idioma." : "Text in English or Spanish — it replies in the same language."}</li>
          <li>• {es ? "Responde STOP para darte de baja, START para volver, AYUDA para el menú." : "Reply STOP to opt out, START to opt back in, HELP for the menu."}</li>
        </ul>
      </section>

      {/* Support */}
      <section className="rounded-2xl border border-brand/25 bg-brand/5 p-5 text-center">
        <LifeBuoy className="mx-auto h-6 w-6 text-brand-dark" />
        <p className="mt-2 text-sm text-gray-700">
          {es ? "¿Necesitas ayuda? Escríbenos a " : "Need a hand? Reach us at "}
          <a href="mailto:eric@fieldtextapp.com" className="font-semibold text-brand-dark underline">eric@fieldtextapp.com</a>.
        </p>
      </section>
    </main>
  );
}
