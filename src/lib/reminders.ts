import { db, getPrimaryPhone } from "./supabase";
import { sendSms, logMessage } from "./twilio";
import { logSms } from "./billing";
import { money, periodLabel, businessLang, t } from "./templates";
import { todayInTz } from "./normalize";
import { generateDueCharges, totalOutstanding, openBalances } from "./charges";
import type { AuthorizedPhone, Business, Client, Expense, Job, Reminder, Lang } from "./types";
import type { DayWeather } from "./weather";

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
  await cancelQuoteReminders(client.id, business.id);
  const lang = businessLang(business);
  const days = business.settings?.quote_reminder_days ?? [2, 5, 7, 14];
  const now = Date.now();
  const amountStr = client.amount != null ? ` (${money(client.amount)}${periodLabel(client.billing_period, lang)})` : "";
  // Interactive: the first nudge asks "did you send it?"; the reply drives the
  // close loop (won/lost/keep-chasing) from there.
  const text = t.quoteAskSent(client.name, amountStr, lang);

  const due: string[] = [];
  for (const d of days) {
    const dueISO = new Date(now + d * 86400000).toISOString();
    const r = await createReminder({ businessId: business.id, clientId: client.id, text, dueISO, kind: "quote_followup" });
    if (r) due.push(dueISO);
  }
  return due;
}

/** Stop a client's pending quote follow-up sequence. Returns how many were cancelled. */
export async function cancelQuoteReminders(clientId: string, businessId?: string): Promise<number> {
  let q = db()
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("client_id", clientId)
    .eq("kind", "quote_followup")
    .eq("status", "pending");
  // Tenant scoping: clientId can be a client-controlled form value — never let
  // it cancel another business's reminders.
  if (businessId) q = q.eq("business_id", businessId);
  const { data } = await q.select("id");
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

export interface DueSummary {
  reminders_sent: number; quote_followups_sent: number; digest_sent: number;
  charges_created: number; weekly_sent: number; monthly_sent: number; season_sent: number;
}
const emptySummary = (): DueSummary => ({
  reminders_sent: 0, quote_followups_sent: 0, digest_sent: 0,
  charges_created: 0, weekly_sent: 0, monthly_sent: 0, season_sent: 0,
});

export async function runAllDue(now = new Date()): Promise<DueSummary> {
  const summary = emptySummary();
  const { data: businesses } = await db().from("businesses").select("*");
  for (const b of (businesses ?? []) as Business[]) {
    try {
      const s = await runDueForBusiness(b, now);
      summary.reminders_sent += s.reminders_sent;
      summary.quote_followups_sent += s.quote_followups_sent;
      summary.digest_sent += s.digest_sent;
      summary.charges_created += s.charges_created;
      summary.weekly_sent += s.weekly_sent;
      summary.monthly_sent += s.monthly_sent;
      summary.season_sent += s.season_sent;
    } catch (e) {
      // One broken business must never stall every other business's reminders.
      console.error(`[reminders] business ${b.id} failed:`, e);
    }
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
    console.warn(`[reminders] primary phone opted out; skipping`);
    return false;
  }
  const res = await sendSms(phone.phone, body);
  if (res.ok) {
    const id = await logMessage({ businessId: business.id, direction: "outbound", body });
    await logSms(business, { direction: "outbound", body, messageId: id });
  }
  return res.ok;
}

/** All non-opted-out phones for a business (crew day sheet goes to everyone). */
async function allPhones(businessId: string): Promise<AuthorizedPhone[]> {
  const { data } = await db().from("authorized_phones").select("*").eq("business_id", businessId);
  return ((data ?? []) as AuthorizedPhone[]).filter((p) => !p.opted_out);
}

export async function runDueForBusiness(business: Business, now: Date): Promise<DueSummary> {
  const summary = emptySummary();
  const lang = businessLang(business);

  // Receivables first: generate any billing-cycle charges that came due.
  summary.charges_created = await generateDueCharges(business, now);

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
      if (r.kind === "quote_followup") {
        summary.quote_followups_sent++;
        // Arm the close loop: the owner's next reply ("sent it" / "they're in" /
        // "no reply") is read as a status update on THIS client. 18h window so a
        // reply hours later still lands.
        if (r.client_id) {
          const pending = {
            kind: "quote_status",
            action: { intent: "update_status", confidence: 1, client_id: r.client_id },
            expiresAt: new Date(now.getTime() + 18 * 60 * 60 * 1000).toISOString(),
          };
          const phone = await getPrimaryPhone(business.id);
          if (phone) await db().from("authorized_phones").update({ pending_state: pending }).eq("id", phone.id);
        }
      } else summary.reminders_sent++;
    }
  }

  if (business.settings?.digest_enabled) {
    if (await maybeSendDaySheet(business, now)) summary.digest_sent++;
  }
  if (business.settings?.weekly_digest_enabled !== false) {
    if (await maybeSendWeekly(business, now)) summary.weekly_sent++;
  }
  if (await maybeSendMonthlySummary(business, now)) summary.monthly_sent++;
  if (await maybeSendSeasonNudge(business, now)) summary.season_sent++;
  return summary;
}

// Fire when we're AT or PAST the send hour and haven't sent today — correct even
// on infrequent cron. (The old `localHour === hour` gate made digests unreachable.)
function pastHourAndUnsent(business: Business, now: Date, lastKey: string | undefined, hourSetting?: number): { fire: boolean; localDate: string } {
  const hour = Number(hourSetting ?? business.settings?.digest_hour ?? 7);
  const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: business.timezone, hour: "numeric", hour12: false }).format(now));
  const localDate = todayInTz(business.timezone, now);
  return { fire: localHour >= hour && lastKey !== localDate, localDate };
}

async function saveSetting(business: Business, patch: Record<string, unknown>): Promise<void> {
  const settings = { ...(business.settings ?? {}), ...patch };
  await db().from("businesses").update({ settings }).eq("id", business.id);
  (business as { settings: unknown }).settings = settings; // keep the in-memory copy honest for later gates
}

/**
 * Morning crew day sheet (digest v2): today's stops in order with addresses,
 * scheduled one-off jobs, and today's reminders — sent to EVERY authorized
 * phone in that phone's language (ES crew, EN owner).
 */
async function maybeSendDaySheet(business: Business, now: Date): Promise<boolean> {
  const { fire, localDate } = pastHourAndUnsent(business, now, business.settings?.last_digest_date);
  if (!fire) return false;

  const [{ data: activeRows }, { data: jobRows }, { data: pending }] = await Promise.all([
    db().from("clients").select("*").eq("business_id", business.id).eq("status", "active"),
    db().from("jobs").select("*").eq("business_id", business.id).eq("status", "scheduled"),
    db().from("reminders").select("*").eq("business_id", business.id).eq("status", "pending"),
  ]);
  const stops = ((activeRows ?? []) as Client[]).filter((c) => c.next_service_on && c.next_service_on <= localDate);
  const oneOffs = ((jobRows ?? []) as Job[]).filter((j) => j.scheduled_on && j.scheduled_on <= localDate);
  const todays = ((pending ?? []) as Reminder[]).filter((r) => todayInTz(business.timezone, new Date(r.due_at)) === localDate);
  // Nothing on the books today → stay quiet instead of texting "no stops" daily.
  if (!stops.length && !oneOffs.length && !todays.length) return false;

  // Today's weather rides along when the business has set a city (same source
  // as the dashboard: NWS first, Open-Meteo fallback; best-effort).
  const { lat, lon } = business.settings ?? {};
  const wx: Partial<Record<Lang, DayWeather>> = {};
  if (typeof lat === "number" && typeof lon === "number") {
    const { getForecast } = await import("./weather");
    for (const lg of ["en", "es"] as Lang[]) {
      const fc = await getForecast(lat, lon, business.timezone, lg).catch(() => [] as DayWeather[]);
      const w = fc.find((f) => f.date === localDate);
      if (w) wx[lg] = w;
    }
  }

  const build = (lang: Lang): string => {
    const lines = [lang === "es" ? `☀️ Hoja del día — ${business.name}` : `☀️ Day sheet — ${business.name}`];
    const w = wx[lang];
    if (w) {
      const rain = w.precip != null && w.precip >= 30 ? (lang === "es" ? ` · lluvia ${w.precip}%` : ` · rain ${w.precip}%`) : "";
      lines.push(`${w.emoji} ${w.label}, ${w.hi}°/${w.lo}°${rain}`);
    }
    if (stops.length) {
      lines.push(lang === "es" ? `Paradas de hoy (${stops.length}):` : `Today's stops (${stops.length}):`);
      for (const c of stops.slice(0, 10)) {
        const overdue = c.next_service_on! < localDate ? " ⚠️" : "";
        lines.push(`• ${c.name}${c.address ? ` — ${c.address}` : ""}${c.service_description ? ` (${c.service_description})` : ""}${overdue}`);
      }
    } else {
      lines.push(lang === "es" ? "Sin paradas programadas hoy." : "No stops scheduled today.");
    }
    for (const j of oneOffs.slice(0, 5)) lines.push(`• 🛠 ${j.description}${j.amount != null ? ` (${money(Number(j.amount))})` : ""}`);
    for (const r of todays.slice(0, 5)) lines.push(`• ⏰ ${r.text}`);
    return lines.join("\n");
  };

  const phones = await allPhones(business.id);
  let sentAny = false;
  const bizLang = businessLang(business);
  for (const p of phones) {
    const res = await sendSms(p.phone, build((p.language as Lang) ?? bizLang));
    if (res.ok) sentAny = true;
  }
  if (sentAny) {
    const id = await logMessage({ businessId: business.id, direction: "outbound", body: build(bizLang) });
    await logSms(business, { direction: "outbound", body: build(bizLang), messageId: id });
    await saveSetting(business, { last_digest_date: localDate });
  }
  return sentAny;
}

/** Monday money digest: open quotes worth $X + who owes — the retention heartbeat. */
async function maybeSendWeekly(business: Business, now: Date): Promise<boolean> {
  const localDate = todayInTz(business.timezone, now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: business.timezone, weekday: "long" }).format(now).toLowerCase();
  if (weekday !== "monday") return false;
  const { fire } = pastHourAndUnsent(business, now, business.settings?.last_weekly_digest_date);
  if (!fire) return false;

  const lang = businessLang(business);
  const { data: quotedRows } = await db().from("clients").select("*").eq("business_id", business.id).eq("status", "quoted");
  const quoted = (quotedRows ?? []) as Client[];
  const potential = quoted.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const outstanding = await totalOutstanding(business.id);
  // Empty book → "0 open quotes" every Monday reads as spam. Stay quiet.
  if (!quoted.length && outstanding <= 0.004) return false;

  const lines = lang === "es"
    ? [`📋 Semana — ${business.name}:`, `• ${quoted.length} cotización(es) abiertas${potential ? ` por ${money(potential)}` : ""}`]
    : [`📋 This week — ${business.name}:`, `• ${quoted.length} open quote(s)${potential ? ` worth ${money(potential)}` : ""}`];
  for (const c of quoted.slice(0, 5)) lines.push(`   - ${c.name}: ${money(c.amount)}${periodLabel(c.billing_period, lang)}`);
  if (outstanding > 0.004) lines.push(lang === "es" ? `• Te deben ${money(outstanding)} — "¿quién me debe?" para ver` : `• You're owed ${money(outstanding)} — text "who owes me?" to see`);

  const ok = await deliver(business, lines.join("\n"));
  if (ok) await saveSetting(business, { last_weekly_digest_date: localDate });
  return ok;
}

/** 1st-of-month "you made $X" summary + referral line — the screenshot text. */
async function maybeSendMonthlySummary(business: Business, now: Date): Promise<boolean> {
  const localDate = todayInTz(business.timezone, now);
  if (!localDate.endsWith("-01")) return false;
  const thisMonth = localDate.slice(0, 7);
  if (business.settings?.last_monthly_summary === thisMonth) return false;
  const { fire } = pastHourAndUnsent(business, now, undefined);
  if (!fire) return false;

  const lang = businessLang(business);
  // Previous month bounds.
  const [y, m] = thisMonth.split("-").map(Number);
  const prevStart = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`;
  const prevMonthName = new Date(prevStart + "T12:00:00Z").toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { month: "long" });

  const [{ data: payRows }, { data: expRows }, { data: jobRows }] = await Promise.all([
    db().from("payments").select("*").eq("business_id", business.id).gte("paid_on", prevStart).lte("paid_on", localDate),
    db().from("expenses").select("*").eq("business_id", business.id).gte("spent_on", prevStart).lte("spent_on", localDate),
    db().from("jobs").select("*").eq("business_id", business.id).gte("performed_on", prevStart).lte("performed_on", localDate),
  ]);
  const collected = ((payRows ?? []) as { amount: number; paid_on: string | null }[])
    .filter((p) => (p.paid_on ?? "") < localDate).reduce((s, p) => s + Number(p.amount), 0);
  const spent = ((expRows ?? []) as Expense[]).filter((e) => e.spent_on < localDate).reduce((s, e) => s + Number(e.amount), 0);
  const jobsDone = ((jobRows ?? []) as Job[]).filter((j) => (j.performed_on ?? "") < localDate).length;
  if (collected === 0 && jobsDone === 0) return false; // nothing to brag about — stay quiet

  const code = business.settings?.referral_code ?? business.slug.split("-")[0].toUpperCase();
  const lines = lang === "es"
    ? [
        `🏆 ${prevMonthName} — ${business.name}:`,
        `• Cobrado: ${money(collected)}`,
        ...(spent > 0 ? [`• Gastos: ${money(spent)} · Neto: ${money(collected - spent)}`] : []),
        `• Trabajos hechos: ${jobsDone}`,
        `¿Conoces a otro jardinero ahogado en notas? Que envíe ${code} al mismo número — un mes gratis para los dos.`,
      ]
    : [
        `🏆 ${prevMonthName} — ${business.name}:`,
        `• Collected: ${money(collected)}`,
        ...(spent > 0 ? [`• Expenses: ${money(spent)} · Net: ${money(collected - spent)}`] : []),
        `• Jobs done: ${jobsDone}`,
        `Know another landscaper drowning in sticky notes? Have them text ${code} to this number — you both get a month free.`,
      ];
  const ok = await deliver(business, lines.join("\n"));
  if (ok) await saveSetting(business, { last_monthly_summary: thisMonth });
  return ok;
}

/** Feb/Sep: "book the season" nudge — turn the existing book into the big weeks. */
async function maybeSendSeasonNudge(business: Business, now: Date): Promise<boolean> {
  const localDate = todayInTz(business.timezone, now);
  const month = localDate.slice(5, 7);
  if (month !== "02" && month !== "09") return false;
  const key = localDate.slice(0, 7);
  if (business.settings?.last_season_nudge === key) return false;
  const { fire } = pastHourAndUnsent(business, now, undefined);
  if (!fire) return false;

  const { data: activeRows } = await db().from("clients").select("*").eq("business_id", business.id).in("status", ["active", "paused"]);
  const count = ((activeRows ?? []) as Client[]).length;
  if (count === 0) return false;

  const lang = businessLang(business);
  const season = month === "02" ? (lang === "es" ? "primavera" : "spring") : (lang === "es" ? "otoño" : "fall");
  const body = lang === "es"
    ? `🌱 Se acerca ${season}: tienes ${count} cliente(s) en tu libreta para ofrecerles limpieza/mantillo. Pregunta "¿qué toca el lunes?" o revisa tu panel para armar la lista.`
    : `🌱 ${season[0].toUpperCase() + season.slice(1)} is coming: you have ${count} client(s) in your book to pitch cleanups/mulch. Text "who's active?" or check your dashboard to build the call list.`;
  const ok = await deliver(business, body);
  if (ok) await saveSetting(business, { last_season_nudge: key });
  return ok;
}
