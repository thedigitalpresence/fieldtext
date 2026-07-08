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
  en: { quoted: "Quoted", active: "Active", completed: "Completed", lost: "Lost", paused: "Paused" },
  es: { quoted: "Cotizado", active: "Activo", completed: "Completado", lost: "Perdido", paused: "Pausado" },
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
      ? `Listo ✅ ${summary}. Responde "corrige" para corregir.`
      : `Got it ✅ ${summary}. Reply "fix" to correct.`,

  statusUpdated: (name: string, status: ClientStatus, lang: Lang) =>
    lang === "es"
      ? `Actualizado ✅ ${name} → ${statusWord(status, lang)}.`
      : `Updated ✅ ${name} → ${statusWord(status, lang)}.`,

  // Distinct copy per outcome — a routine "job done" must never read like a delete.
  clientCompleted: (name: string, lang: Lang) =>
    lang === "es"
      ? `Marqué a ${name} como completado ✅ (ya no está en tu lista activa). Si querías registrar una visita, responde "corrige".`
      : `Marked ${name} completed ✅ (off your active list). If you meant a finished visit, reply "fix".`,
  clientLost: (name: string, lang: Lang) =>
    lang === "es" ? `Marqué a ${name} como perdido. Responde "corrige" para corregir.` : `Marked ${name} lost. Reply "fix" to correct.`,

  jobLogged: (desc: string, who: string, date: string, lang: Lang) =>
    lang === "es" ? `Registrado ✅ ${desc} ${who} el ${date}.` : `Logged ✅ ${desc} ${who} on ${date}.`,
  jobNextVisit: (date: string, lang: Lang) =>
    lang === "es" ? ` Próxima visita ${date}.` : ` Next visit ${date}.`,
  jobScheduled: (desc: string, name: string, date: string, amount: string | null, lang: Lang) =>
    lang === "es"
      ? `Agendado ✅ ${desc} para ${name} el ${date}${amount ? ` (${amount})` : ""}.`
      : `Scheduled ✅ ${desc} for ${name} on ${date}${amount ? ` (${amount})` : ""}.`,

  paymentLogged: (amount: string, who: string, date: string, lang: Lang) =>
    lang === "es" ? `Registrado ✅ ${amount}${who} el ${date}.` : `Recorded ✅ ${amount}${who} on ${date}.`,
  balanceRemaining: (name: string, balance: string, lang: Lang) =>
    lang === "es" ? ` ${name} aún debe ${balance}.` : ` ${name} still owes ${balance}.`,
  allSettled: (name: string, lang: Lang) => (lang === "es" ? ` ${name} está al corriente ✅` : ` ${name} is all settled ✅`),
  paymentUnlinked: (lang: Lang) =>
    lang === "es"
      ? ` ⚠️ Sin cliente asignado — responde con el nombre para vincularlo.`
      : ` ⚠️ Not linked to a client — reply with the name to attach it.`,

  // roadmap confirmations
  expenseLogged: (amount: string, category: string, desc: string, lang: Lang) =>
    lang === "es"
      ? `Gasto ✅ ${amount} — ${desc || category}.`
      : `Expense ✅ ${amount} — ${desc || category}.`,
  infoSaved: (name: string, what: string, lang: Lang) =>
    lang === "es" ? `Guardado ✅ ${name} — ${what}.` : `Saved ✅ ${name} — ${what}.`,
  clientPaused: (name: string, until: string | null, lang: Lang) =>
    lang === "es"
      ? `Pausado ⏸ ${name}${until ? ` hasta ${until} (te recuerdo para reanudar)` : ""}. Fuera del calendario, no perdido.`
      : `Paused ⏸ ${name}${until ? ` until ${until} (I'll remind you to resume)` : ""}. Off the schedule, not lost.`,
  clientResumed: (name: string, next: string | null, lang: Lang) =>
    lang === "es" ? `Reactivado ✅ ${name}${next ? ` — próxima visita ${next}` : ""}.` : `Resumed ✅ ${name}${next ? ` — next visit ${next}` : ""}.`,
  visitSkipped: (name: string, next: string, lang: Lang) =>
    lang === "es" ? `Saltado ✅ ${name} — próxima visita ${next}.` : `Skipped ✅ ${name} — next visit ${next}.`,
  visitMoved: (name: string, date: string, lang: Lang) =>
    lang === "es" ? `Movido ✅ ${name} → ${date}.` : `Moved ✅ ${name} → ${date}.`,
  bulkMoved: (names: string, date: string, count: number, lang: Lang) =>
    lang === "es"
      ? `Movido ✅ ${count} parada(s) → ${date}: ${names}.`
      : `Moved ✅ ${count} stop(s) → ${date}: ${names}.`,
  nothingDueToday: (lang: Lang) =>
    lang === "es" ? "No hay visitas pendientes hoy — nada que mover." : "No stops due today — nothing to move.",
  priceChanged: (name: string, amount: string, lang: Lang) =>
    lang === "es" ? `Precio actualizado ✅ ${name} → ${amount}. Sigue activo.` : `Price updated ✅ ${name} → ${amount}. Still active.`,
  invoiceLink: (name: string, total: string, url: string, lang: Lang) =>
    lang === "es"
      ? `Factura para ${name} (${total}): ${url}\nReenvíala desde tu teléfono 👍`
      : `Invoice for ${name} (${total}): ${url}\nForward it from your phone 👍`,
  receiptLink: (name: string, total: string, url: string, lang: Lang) =>
    lang === "es" ? `Recibo para ${name} (${total}): ${url}` : `Receipt for ${name} (${total}): ${url}`,
  noOpenBalance: (name: string, lang: Lang) =>
    lang === "es" ? `${name} no debe nada ahora mismo ✅` : `${name} doesn't owe anything right now ✅`,

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
      ? 'No entendí bien — prueba p. ej. "coticé a Jane en 5 Oak por $200/mes" o "recuérdame llamar a Jane el viernes". Escribe AYUDA para ver todo.'
      : 'I didn\'t catch that — try e.g. "quoted Jane at 5 Oak St for $200/mo" or "remind me to call Jane friday". Text HELP for the full menu.',
  errorSaving: (lang: Lang) =>
    lang === "es" ? "Algo salió mal al guardar. Intenta de nuevo." : "Something went wrong saving that. Try again.",
  helpHint: (lang: Lang) =>
    lang === "es"
      ? [
          "FieldText — escribe como hablas:",
          '• "coticé a Jane en 5 Oak por $200/mes"',
          '• "corté el pasto de los Smith"',
          '• "Bob pagó 300" · "Bob debe 450"',
          '• "recuérdame llamar a Jane el viernes"',
          '• "llovió, muévelo a mañana" · "pausa a Jones hasta abril"',
          '• "factura Bob" · "gasté 84 en mulch"',
          '• "¿quién me debe?" · "¿qué toca el lunes?"',
          "Soporte: eric@fieldtextapp.com · STOP para darte de baja",
        ].join("\n")
      : [
          "FieldText — just text like you talk:",
          '• "quoted Jane at 5 Oak St for $200/mo"',
          '• "mowed the smiths"',
          '• "Bob paid 300" · "Bob owes 450"',
          '• "remind me to call Jane friday"',
          '• "rained out, push today to tomorrow" · "pause Jones til April"',
          '• "invoice Bob" · "spent 84 on mulch"',
          '• "who owes me?" · "what\'s Monday look like?"',
          "Support: eric@fieldtextapp.com · Reply STOP to unsubscribe",
        ].join("\n"),
  cancelWhat: (lang: Lang) =>
    lang === "es"
      ? '¿Cancelar qué? Un recordatorio ("cancela el recordatorio de Jane"), un cliente ("perdimos a Jones") — o responde STOP para darte de baja de todos los mensajes.'
      : 'Cancel what? A reminder ("cancel the Jane reminder"), a client ("lost the Jones account") — or reply STOP to unsubscribe from all texts.',
  welcome: (ownerName: string, lang: Lang) =>
    lang === "es"
      ? `¡Bienvenido a FieldText, ${ownerName}! 🌱 Este número es tu libreta. Prueba ahora: "coticé a Maria en 12 Elm por $200/mes". Escribe AYUDA cuando quieras.`
      : `Welcome to FieldText, ${ownerName}! 🌱 This number is your black book. Try it now: "quoted Maria at 12 Elm St for $200/mo". Text HELP anytime.`,
  photoHint: (lang: Lang) =>
    lang === "es"
      ? "📸 Recibí tu foto — para cargar una lista de clientes desde una foto, usa Importar en tu panel: fieldtext.vercel.app/dashboard/import"
      : "📸 Got your photo — to load a client list from a photo, use Import on your dashboard: fieldtext.vercel.app/dashboard/import",
  yesToAdd: (name: string, lang: Lang) =>
    lang === "es" ? `No encontré a "${name}". Responde SÍ para agregarlo, o manda el nombre correcto.` : `I don't know "${name}". Reply YES to add them, or send the right name.`,
};
