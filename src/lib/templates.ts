/**
 * Outbound SMS copy, keyed by language. Confirmations, reminders, follow-up
 * nudges, and clarifying questions — all short and natural. One template set per
 * language; adding a language = add a block here. The parsing/normalization
 * pipeline is shared and language-agnostic.
 */
import type { Lang, BillingPeriod, ClientStatus, Client, Business } from "./types";

/** The operator's language (default English). */
export function businessLang(b: Pick<Business, "settings">): Lang {
  return b.settings?.language === "es" ? "es" : "en";
}

// ── Shared display formatters (used in texts AND the dashboard) ───────────────
export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(2)}`;
}
const PERIOD_LABEL: Record<Lang, Record<BillingPeriod, string>> = {
  en: { monthly: "/mo", weekly: "/wk", biweekly: "/2wk", one_time: " one-time" },
  es: { monthly: "/mes", weekly: "/sem", biweekly: "/2sem", one_time: " única vez" },
};
export function periodLabel(p: string | null | undefined, lang: Lang = "en"): string {
  if (!p) return "";
  return PERIOD_LABEL[lang][p as BillingPeriod] ?? ` ${p}`;
}
const STATUS_WORD: Record<Lang, Record<ClientStatus, string>> = {
  en: { quoted: "Quoted", active: "Active", completed: "Completed", lost: "Lost" },
  es: { quoted: "Cotizado", active: "Activo", completed: "Completado", lost: "Perdido" },
};
export function statusWord(s: ClientStatus, lang: Lang = "en"): string {
  return STATUS_WORD[lang][s];
}

/** A clean one-line summary of a client, e.g. "Angela Jones — 333 Jones Ave · $500/mo · full coverage · Quoted". */
export function clientSummary(c: Pick<Client, "name" | "address" | "amount" | "billing_period" | "service_description" | "status">, lang: Lang): string {
  const parts = [
    c.name,
    c.address || null,
    c.amount != null ? `${money(c.amount)}${periodLabel(c.billing_period, lang)}` : null,
    c.service_description || null,
    statusWord(c.status, lang),
  ].filter(Boolean);
  return parts.join(" · ");
}

// ── Templated messages ────────────────────────────────────────────────────────
export const t = {
  quoteLogged: (summary: string, lang: Lang) =>
    lang === "es"
      ? `Listo ✅ ${summary}. Responde "no" para corregir.`
      : `Got it ✅ ${summary}. Reply "no" to fix.`,

  statusUpdated: (name: string, status: ClientStatus, lang: Lang) =>
    lang === "es"
      ? `Actualizado ✅ ${name} → ${statusWord(status, lang)}.`
      : `Updated ✅ ${name} → ${statusWord(status, lang)}.`,

  clientRemoved: (name: string, lang: Lang) =>
    lang === "es" ? `Listo ✅ Quité a ${name} de tu lista.` : `Got it ✅ Removed ${name} from your list.`,

  jobLogged: (desc: string, who: string, date: string, lang: Lang) =>
    lang === "es" ? `Registrado ✅ ${desc} ${who} el ${date}.` : `Logged ✅ ${desc} ${who} on ${date}.`,

  paymentLogged: (amount: string, who: string, date: string, lang: Lang) =>
    lang === "es" ? `Registrado ✅ ${amount}${who} el ${date}.` : `Recorded ✅ ${amount}${who} on ${date}.`,

  reminderSet: (when: string, text: string, lang: Lang) =>
    lang === "es" ? `Recordatorio listo ✅ Te aviso el ${when}: ${text}` : `Reminder set ✅ I'll text you ${when}: ${text}`,

  reminderDue: (text: string, lang: Lang) => (lang === "es" ? `⏰ Recordatorio: ${text}` : `⏰ Reminder: ${text}`),

  quoteNudge: (name: string, amountStr: string, lang: Lang) =>
    lang === "es"
      ? `📣 Da seguimiento a ${name}${amountStr} — la cotización sigue abierta.`
      : `📣 Follow up with ${name}${amountStr} — quote still open.`,

  languageSet: (lang: Lang) =>
    lang === "es"
      ? `Listo ✅ Ahora te escribiré en español.`
      : `Got it ✅ I'll text you in English from now on.`,

  optedOut: (lang: Lang) =>
    lang === "es"
      ? `Te diste de baja de FieldText. No te enviaremos más mensajes. Responde START para reactivar.`
      : `You're unsubscribed from FieldText. We won't text you again. Reply START to resume.`,
  optedIn: (lang: Lang) =>
    lang === "es" ? `Listo ✅ Reactivaste los mensajes de FieldText.` : `Got it ✅ FieldText messages are back on.`,

  // clarifying questions
  whoIsQuoteFor: (lang: Lang) => (lang === "es" ? "¿Para quién es la cotización?" : "Who is the quote for?"),
  whatAmount: (name: string, lang: Lang) =>
    lang === "es" ? `¿Cuál es el precio para la cotización de ${name}?` : `What's the price for the ${name} quote?`,
  whichClient: (options: string, lang: Lang) =>
    lang === "es" ? `¿Cuál? ${options}. Responde con la dirección.` : `Which one? ${options}. Reply with the address.`,
  notFound: (q: string, lang: Lang) =>
    lang === "es" ? `No encontré un cliente que coincida con "${q}". ¿Lo agrego?` : `I couldn't find a client matching "${q}". Want me to add them?`,
  howMuchPayment: (lang: Lang) => (lang === "es" ? "¿De cuánto fue el pago?" : "How much was the payment?"),
  whenRemind: (lang: Lang) => (lang === "es" ? "¿Cuándo te recuerdo?" : "When should I remind you?"),
  didntCatch: (lang: Lang) =>
    lang === "es"
      ? 'No entendí bien — prueba p. ej. "coticé a Jane en 5 Oak por $200/mes" o "recuérdame llamar a Jane el viernes".'
      : 'I didn\'t catch that — try e.g. "quoted Jane at 5 Oak St for $200/mo" or "remind me to call Jane friday".',
  errorSaving: (lang: Lang) =>
    lang === "es" ? "Algo salió mal al guardar. Intenta de nuevo." : "Something went wrong saving that. Try again.",
  helpHint: (lang: Lang) =>
    lang === "es"
      ? "Puedo registrar cotizaciones, trabajos, pagos, cambios de estado y recordatorios — o responder preguntas como \"¿a quién tengo que dar seguimiento?\"."
      : "I can log quotes, jobs, payments, status changes, and reminders — or answer questions like \"who do I need to follow up with?\".",
};
