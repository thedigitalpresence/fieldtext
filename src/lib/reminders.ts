import { db, getPrimaryPhone } from "./supabase";
import { sendSms, logMessage } from "./twilio";
import { logSms } from "./billing";
import { money, periodLabel, businessLang, t } from "./templates";
import type { Business, Client, Reminder, Lang } from "./types";

export async function createReminder(args: {
  businessId: string;
  text: string;
  dueISO: string;
  clientId?: string | null;
  sourceMessageId?: string | null;
  kind?: "manual" | "quote_followup";
}): Promise<Reminder | null> {
  const { data, error } = await db()
    .from("reminders")
    .insert({
      business_id: args.businessId,
      client_id: args.clientId ?? null,
      text: args.text,
      due_at: args.dueISO,
      status: "pending",
      kind: args.kind ?? "manual",
      source_message_id: args.sourceMessageId ?? null,
    })
    .select("*")
    .single();
  if (error) {
    console.error("[reminders] create failed:", error.message);
    return null;
  }
  return data as Reminder;
}

/**
 * Auto-schedule the quote follow-up sequence (default +2/+5/+7/+14 days). The
 * stored text is the localized nudge sent at each step. Cancels any existing
 * pending sequence for this client first (so re-quoting resets the clock).
 */
export async function scheduleQuoteReminders(business: Business, client: Client): Promise<string[]> {
  await cancelQuoteReminders(client.id);
  const lang = businessLang(business);
  const days = business.settings?.quote_reminder_days ?? [2, 5, 7, 14];
  const now = Date.now();
  const amountStr = client.amount != null ? ` (${money(client.amount)}${periodLabel(client.billing_period, lang)})` : "";
  const text = t.quoteNudge(client.name, amountStr, lang);

  const due: string[] = [];
  for (const d of days) {
    const dueISO = new Date(now + d * 86400000).toISOString();
    const r = await createReminder({ businessId: business.id, clientId: client.id, text, dueISO, kind: "quote_followup" });
    if (r) due.push(dueISO);
  }
  return due;
}

/** Stop a client's pending quote follow-up sequence. Returns how many were cancelled. */
export async function cancelQuoteReminders(clientId: string): Promise<number> {
  const { data } = await db()
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("client_id", clientId)
    .eq("kind", "quote_followup")
    .eq("status", "pending")
    .select("id");
  return (data ?? []).length;
}

export function formatWhen(iso: string, timezone: string, lang: Lang = "en"): string {
  const locale = lang === "es" ? "es-ES" : "en-US";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export interface DueSummary { reminders_sent: number; quote_followups_sent: number; digest_sent: number }

export async function runAllDue(now = new Date()): Promise<DueSummary> {
  const summary: DueSummary = { reminders_sent: 0, quote_followups_sent: 0, digest_sent: 0 };
  const { data: businesses } = await db().from("businesses").select("*");
  for (const b of (businesses ?? []) as Business[]) {
    const s = await runDueForBusiness(b, now);
    summary.reminders_sent += s.reminders_sent;
    summary.quote_followups_sent += s.quote_followups_sent;
    summary.digest_sent += s.digest_sent;
  }
  return summary;
}

async function deliver(business: Business, body: string): Promise<boolean> {
  const phone = await getPrimaryPhone(business.id);
  if (!phone) {
    console.warn(`[reminders] no primary phone for ${business.name}; skipping`);
    return false;
  }
  if (phone.opted_out) {
    console.warn(`[reminders] ${phone.phone} opted out; skipping`);
    return false;
  }
  const res = await sendSms(phone.phone, body);
  if (res.ok) {
    const id = await logMessage({ businessId: business.id, direction: "outbound", body });
    await logSms(business, { direction: "outbound", body, messageId: id });
  }
  return res.ok;
}

export async function runDueForBusiness(business: Business, now: Date): Promise<DueSummary> {
  const summary: DueSummary = { reminders_sent: 0, quote_followups_sent: 0, digest_sent: 0 };
  const lang = businessLang(business);

  const { data: due } = await db()
    .from("reminders")
    .select("*")
    .eq("business_id", business.id)
    .eq("status", "pending")
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true });

  for (const r of (due ?? []) as Reminder[]) {
    // quote_followup text is already the full localized nudge; manual gets a prefix.
    const body = r.kind === "quote_followup" ? r.text : t.reminderDue(r.text, lang);
    const ok = await deliver(business, body);
    if (ok) {
      await db().from("reminders").update({ status: "sent", sent_at: now.toISOString() }).eq("id", r.id);
      if (r.kind === "quote_followup") summary.quote_followups_sent++;
      else summary.reminders_sent++;
    }
  }

  if (business.settings?.digest_enabled) {
    if (await maybeSendDigest(business, now)) summary.digest_sent++;
  }
  return summary;
}

async function maybeSendDigest(business: Business, now: Date): Promise<boolean> {
  const lang = businessLang(business);
  const hour = Number(business.settings?.digest_hour ?? 7);
  const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: business.timezone, hour: "numeric", hour12: false }).format(now));
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: business.timezone }).format(now);
  if (localHour !== hour) return false;
  if (business.settings?.last_digest_date === localDate) return false;

  const { data: openQuotes } = await db().from("clients").select("*").eq("business_id", business.id).eq("status", "quoted");
  const { data: pending } = await db().from("reminders").select("*").eq("business_id", business.id).eq("status", "pending");
  const todays = ((pending ?? []) as Reminder[]).filter((r) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: business.timezone }).format(new Date(r.due_at));
    return d === localDate;
  });

  const lines = lang === "es"
    ? [`☀️ ¡Buenos días! Hoy para ${business.name}:`, `• ${(openQuotes ?? []).length} cotización(es) por dar seguimiento`, `• ${todays.length} recordatorio(s) para hoy`]
    : [`☀️ Good morning! Today for ${business.name}:`, `• ${(openQuotes ?? []).length} open quote(s) to follow up`, `• ${todays.length} reminder(s) due today`];
  for (const r of todays.slice(0, 5)) lines.push(`   - ${r.text}`);

  const ok = await deliver(business, lines.join("\n"));
  if (ok) {
    const settings = { ...(business.settings ?? {}), last_digest_date: localDate };
    await db().from("businesses").update({ settings }).eq("id", business.id);
  }
  return ok;
}
