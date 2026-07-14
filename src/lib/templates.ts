/**
 * Outbound SMS copy, keyed by language. Confirmations, reminders, follow-up
 * nudges, and clarifying questions — all short and natural. One template set per
 * language; adding a language = add a block here. The parsing/normalization
 * pipeline is shared and language-agnostic.
 */
import { config } from "./config";
import type { Lang, BillingPeriod, ClientStatus, Client, Business } from "./types";

/** Bare host of the app URL (no scheme), for short SMS links. */
function appHost(): string {
  return config.appUrl().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

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
      ? `Listo — quité a ${name} de tu lista activa ✅. ¿Prefieres pausarlo para más adelante? Responde "pausa ${name}". Si era una visita terminada, responde "corrige".`
      : `Done — took ${name} off your active list ✅. Want to pause them for later instead? Reply "pause ${name}". If you meant a finished visit, reply "fix".`,
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
  expenseLoggedFor: (amount: string, client: string, desc: string, lang: Lang) =>
    lang === "es"
      ? `Gasto ✅ ${amount} — ${desc} · guardado en la ficha de ${client}.`
      : `Expense ✅ ${amount} — ${desc} · saved to ${client}'s card.`,
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

  flagged: (lang: Lang) =>
    lang === "es"
      ? `🚩 Anotado y enviado al equipo. ¡Gracias, esto ayuda mucho durante la beta!`
      : `🚩 Got it, flagged for the team. Thanks, this really helps during beta!`,

  // A reminder linked to a client keeps their name in the text ("send · Elena
  // Shackelford"), so a thin task never fires as a context-free "Reminder: send".
  taggedReminder: (text: string, clientName: string | null | undefined): string => {
    if (!clientName) return text;
    const first = clientName.split(/\s+/)[0]?.toLowerCase() ?? "";
    return first && text.toLowerCase().includes(first) ? text : `${text} · ${clientName}`;
  },

  notSure: (text: string, lang: Lang) => {
    const q = text.trim().replace(/\s+/g, " ").slice(0, 60);
    return lang === "es"
      ? `No estoy 100% seguro de qué quisiste decir con "${q}". ¿Lo puedes decir de otra forma? Por ejemplo: "recuérdame mañana cotizar a Mitch" o "el teléfono de Mitch es 555-1234".`
      : `I'm not totally sure what you meant by "${q}". Can you say it another way? For example: "remind me tomorrow to quote Mitch" or "Mitch's phone is 555-1234".`;
  },

  // Asked when a reminder has a day but no time: never assume 9 AM silently.
  whatTimeRemind: (dayStr: string, lang: Lang) =>
    lang === "es"
      ? `Listo, ${dayStr}. ¿A qué hora te escribo? (ej. "9am", "2:30pm", "mediodía")`
      : `Got it, ${dayStr}. What time should I text you? (e.g. "9am", "2:30pm", "noon")`,

  // Offered after a THIN reminder task ("send"): fixing it is one reply away.
  reminderClarifyOffer: (lang: Lang) =>
    lang === "es"
      ? `¿Quieres agregar detalle? Responde con la tarea completa (ej. "enviar la cotización") y la actualizo.`
      : `Want to add detail? Reply with the full task (e.g. "send the quote") and I'll update it.`,
  reminderUpdated: (when: string, text: string, lang: Lang) =>
    lang === "es" ? `Actualizado ✅ Te aviso el ${when}: ${text}` : `Updated ✅ I'll text you ${when}: ${text}`,

  reminderSetProspect: (when: string, name: string, lang: Lang) =>
    lang === "es"
      ? `Recordatorio listo ✅ Agregué a ${name} y te aviso el ${when} para cotizarle. Cuando toque, responde BORRADOR y te escribo el mensaje.`
      : `Reminder set ✅ Added ${name} and I'll text you ${when} to quote them. When it's time, reply DRAFT and I'll write the message.`,

  // Said right when a quote is logged, so the owner KNOWS the chase is armed.
  followupPlan: (days: number, lang: Lang) => {
    if (lang === "es") return days === 1 ? `📣 Te recuerdo mañana para darle seguimiento.` : `📣 Te recuerdo en ${days} días para darle seguimiento.`;
    return days === 1 ? `📣 I'll remind you tomorrow to follow up.` : `📣 I'll remind you in ${days} days to follow up.`;
  },

  quoteNudge: (name: string, amountStr: string, lang: Lang) =>
    lang === "es"
      ? `📣 Da seguimiento a ${name}${amountStr} — la cotización sigue abierta.`
      : `📣 Follow up with ${name}${amountStr} — quote still open.`,
  // Interactive close-loop nudges — each asks a status so the reply drives the next step.
  quoteAskSent: (name: string, amountStr: string, lang: Lang) =>
    lang === "es"
      ? `📣 ¿Ya le mandaste la cotización a ${name}${amountStr}? Responde ENVIADA, TODAVÍA NO — o si ya decidió: ADENTRO / FUERA.`
      : `📣 Did you send ${name} their quote${amountStr}? Reply SENT, NOT YET — or if they decided: IN / OUT.`,
  quoteAskReply: (name: string, amountStr: string, lang: Lang) =>
    lang === "es"
      ? `📣 ¿Alguna respuesta de ${name} sobre la cotización${amountStr}? Responde ADENTRO, FUERA, o SIN RESPUESTA.`
      : `📣 Any word back from ${name} on the quote${amountStr}? Reply IN, OUT, or NO REPLY.`,
  // Pre-send quote to-do reminder — specific, with the details, and offers a draft.
  quoteTodo: (client: { name: string; address?: string | null; service_description?: string | null; amount?: number | null; billing_period?: string | null }, lang: Lang) => {
    const bits: string[] = [];
    if (client.address) bits.push(client.address);
    if (client.service_description) bits.push(client.service_description);
    if (client.amount != null) bits.push(`${money(client.amount)}${periodLabel(client.billing_period, lang)}`);
    const detail = bits.length ? ` (${bits.join(" · ")})` : "";
    return lang === "es"
      ? `📣 Recordatorio de cotización: ${client.name} sigue esperando su precio${detail}. Responde BORRADOR y te escribo un mensaje para enviarle, o ENVIADA cuando ya salga.`
      : `📣 Quote reminder: ${client.name} is still waiting on a quote${detail}. Reply DRAFT and I'll write a message you can send them, or SENT once it's out.`;
  },
  // The draft is sent as TWO texts: (1) this instruction text, then (2) the clean
  // message on its own so it's trivial to copy and paste. No surrounding quotes,
  // no em-dashes. The instruction makes the price fill-in unmistakable.
  quoteDraftIntro: (client: { name: string; amount?: number | null; billing_period?: string | null }, lang: Lang) => {
    const priceKnown = client.amount != null;
    const priceStr = priceKnown ? `${money(client.amount)}${periodLabel(client.billing_period, lang)}` : "";
    if (lang === "es") {
      return priceKnown
        ? `Aquí tienes un borrador para ${client.name}. Copia el siguiente mensaje y envíaselo. Antes de enviar, revisa que el precio (${priceStr}) esté bien. Responde ENVIADA cuando salga.`
        : `Aquí tienes un borrador para ${client.name}. Copia el siguiente mensaje y envíaselo. IMPORTANTE: cambia $___ por tu precio real antes de enviarlo. Responde ENVIADA cuando salga.`;
    }
    return priceKnown
      ? `Here's a draft for ${client.name}. Copy the next message and send it to them. Before you send, double check the price (${priceStr}) is right. Reply SENT once it's out.`
      : `Here's a draft for ${client.name}. Copy the next message and send it to them. IMPORTANT: replace $___ with your real price before you send. Reply SENT once it's out.`;
  },
  // Text 2: the customer-facing message, no quotes so it copies cleanly.
  quoteDraftMessage: (client: { name: string; address?: string | null; service_description?: string | null; amount?: number | null; billing_period?: string | null }, lang: Lang) => {
    const first = client.name.split(/\s+/)[0] || client.name;
    const service = client.service_description || (lang === "es" ? "el trabajo" : "the work");
    const at = client.address ? (lang === "es" ? ` en ${client.address}` : ` at ${client.address}`) : "";
    const price = client.amount != null ? `${money(client.amount)}${periodLabel(client.billing_period, lang)}` : "$___";
    return lang === "es"
      ? `¡Hola ${first}! Gracias por escribirnos. Para ${service}${at}, lo podemos hacer por ${price}. Avísame si quieres seguir adelante.`
      : `Hi ${first}! Thanks for reaching out. For ${service}${at}, we can do ${price}. Let me know if you'd like to move forward.`;
  },
  quoteDraftSentAck: (name: string, days: number, lang: Lang) =>
    lang === "es"
      ? `¡Bien! Marqué la cotización de ${name} como enviada. Te recuerdo en ${days} día${days === 1 ? "" : "s"} para darle seguimiento. 📣`
      : `Nice. Marked ${name}'s quote as sent. I'll remind you in ${days} day${days === 1 ? "" : "s"} to follow up. 📣`,
  quoteDraftSkip: (name: string, lang: Lang) =>
    lang === "es" ? `👍 Sin problema — te recuerdo de nuevo con ${name}.` : `👍 No problem — I'll remind you again about ${name}.`,

  quoteWon: (name: string, lang: Lang) =>
    lang === "es" ? `🎉 ¡${name} aceptó! Los pasé a activos.` : `🎉 ${name} is in! Moved them to active.`,
  quoteLostAck: (name: string, lang: Lang) =>
    lang === "es" ? `Anotado — ${name} pasó. Los quité de cotizaciones.` : `Noted — ${name} passed. Off your quotes.`,
  quoteChaseAgain: (name: string, when: string, lang: Lang) =>
    lang === "es" ? `👍 Le sigo la pista a ${name} — te recuerdo ${when}.` : `👍 Staying on ${name} — I'll check back with you ${when}.`,

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
      ? 'No entendí bien — prueba p. ej. "coticé a Jane en 5 Oak por $200/mes" o "recuérdame llamar a Jane el viernes". Escribe AYUDA para ver todo, o escribe a eric@fieldtextapp.com.'
      : 'I didn\'t catch that — try e.g. "quoted Jane at 5 Oak St for $200/mo" or "remind me to call Jane friday". Text HELP for the full menu, or reach us at eric@fieldtextapp.com.',
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
          '• ¿Algo raro o roto? Escribe "reporta" + qué pasó 🚩',
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
          '• Something weird or broken? Text "flag" + what happened 🚩',
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
      ? `📸 Recibí tu foto — para cargar una lista de clientes desde una foto, usa Importar en tu panel: ${appHost()}/dashboard/import`
      : `📸 Got your photo — to load a client list from a photo, use Import on your dashboard: ${appHost()}/dashboard/import`,
  photoWho: (lang: Lang) =>
    lang === "es"
      ? "📸 ¿De qué cliente es esta foto? Responde con el nombre — o IMPORTAR si es una lista de clientes."
      : "📸 Whose site is this photo from? Reply with the client name — or IMPORT if it's a client list to load.",
  photoAfterAnswer: (lang: Lang) =>
    lang === "es"
      ? "📸 Recibí tu foto. Primero responde mi pregunta de arriba, y vuelve a enviarla para guardarla."
      : "📸 Got your photo. Answer my question above first, then send it again and I'll file it.",
  photoSaved: (count: number, name: string, lang: Lang) =>
    lang === "es"
      ? `Guardé ${count > 1 ? `${count} fotos` : "la foto"} en la ficha de ${name} 📸 — la ves en tu panel.`
      : `Saved ${count > 1 ? `${count} photos` : "the photo"} to ${name} 📸 — it's on their card in your dashboard.`,
  noteSaved: (name: string, lang: Lang) =>
    lang === "es" ? `Nota guardada ✅ en la ficha de ${name}.` : `Note saved ✅ to ${name}.`,
  anyNotes: (name: string, lang: Lang) =>
    lang === "es"
      ? `¿Algo que anotar sobre ${name}? Código del portón, perros, dónde estacionar... también puedes mandar una foto del sitio. Responde OMITIR para terminar.`
      : `Anything to note about ${name}? Gate codes, dogs, where to park... you can also text a photo of the site. Reply SKIP to finish.`,
  prospectAdded: (name: string, lang: Lang) =>
    lang === "es"
      ? `Añadí a ${name} como prospecto 📝 (aún sin cotizar).`
      : `Added ${name} as a prospect 📝 (not quoted yet).`,
  whenIsTheJob: (name: string, lang: Lang) =>
    lang === "es"
      ? `¿Para cuándo es el trabajo de ${name}? Algo como "el viernes" o "el 24" me sirve. ¿Sin fecha aún? Responde OMITIR.`
      : `When's the job for ${name}? Something like "friday" or "the 24th" works. Not booked yet? Reply SKIP.`,

  needSchedule: (name: string, lang: Lang) =>
    lang === "es"
      ? `¿Cuándo arrancas con ${name}? Dime cada cuánto y qué día, como "semanal los lunes desde el próximo lunes" o "mensual el 1". ¿Aún no sabes? Responde OMITIR.`
      : `When are you starting with ${name}? Tell me how often and what day, like "weekly on Mondays starting next Monday" or "monthly on the 1st". Not sure yet? Reply SKIP.`,
  scheduleSaved: (name: string, when: string, lang: Lang) =>
    lang === "es" ? `Agendado ✅ ${name} — ${when}.` : `Scheduled ✅ ${name} — ${when}.`,
  allSet: (name: string, lang: Lang) =>
    lang === "es" ? `Listo ✅ ${name} está completo.` : `All set ✅ ${name} is fully saved.`,
  yesToAdd: (name: string, lang: Lang) =>
    lang === "es" ? `No encontré a "${name}". Responde SÍ para agregarlo, o manda el nombre correcto.` : `I don't know "${name}". Reply YES to add them, or send the right name.`,
  resetCode: (code: string, lang: Lang) =>
    lang === "es"
      ? `Tu código para restablecer la contraseña de FieldText es ${code}. Vence en 15 minutos. Si no lo pediste, ignora este mensaje.`
      : `Your FieldText password reset code is ${code}. It expires in 15 minutes. If you didn't request it, ignore this message.`,
  needInfo: (name: string, missing: string[], lang: Lang) => {
    const words: Record<string, [string, string]> = {
      name: ["their full name", "su nombre completo"],
      address: ["the address", "la dirección"],
      phone: ["a phone number", "un teléfono"],
      service: ["the service", "el servicio"],
    };
    const list = missing.map((m) => (lang === "es" ? words[m]?.[1] : words[m]?.[0])).filter(Boolean);
    const joined = list.length > 1 ? list.slice(0, -1).join(", ") + (lang === "es" ? " y " : " and ") + list[list.length - 1] : list[0];
    return lang === "es" ? `¿Me das ${joined} de ${name}?` : `What's ${joined} for ${name}?`;
  },
  didYouMean: (candidate: string, given: string, lang: Lang) =>
    lang === "es"
      ? `¿Te refieres a ${candidate}? Responde SÍ — o NUEVO para agregar "${given}" como cliente nuevo.`
      : `Did you mean ${candidate}? Reply YES — or NEW to add "${given}" as a new client.`,
  reAddRemoved: (candidate: string, given: string, lang: Lang) =>
    lang === "es"
      ? `${candidate} fue quitado antes. ¿Volver a agregarlo? Responde SÍ — o NUEVO para crear a "${given}" aparte.`
      : `${candidate} was removed earlier. Add them back? Reply YES — or NEW to create "${given}" as a separate client.`,
};
