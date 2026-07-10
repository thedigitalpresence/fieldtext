import { db, currentBusiness, currentSession, listBusinesses } from "@/lib/supabase";
import { config } from "@/lib/config";
import { dict } from "@/i18n";
import { businessLang, money, periodLabel } from "@/lib/templates";
import { monthlyEquivalent } from "@/lib/intents";
import { totalOutstanding, openBalances, nextCycleDate } from "@/lib/charges";
import { listPhotos } from "@/lib/attachments";
import { getForecast, type DayWeather } from "@/lib/weather";
import DashboardClient from "./DashboardClient";
import type { Client, Job, Payment, Reminder, Message, Lang } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

function fmtShort(d: string | null, lang: Lang): string {
  if (!d) return "—";
  return new Date(d.length <= 10 ? d + "T00:00:00" : d).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    month: "short", day: "numeric",
  });
}
function fmtExact(d: string | null, lang: Lang): string {
  if (!d) return "—";
  return new Date(d.length <= 10 ? d + "T00:00:00" : d).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}
function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
function relativeTime(iso: string, lang: Lang): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  const u = (n: number, unit: string) => (lang === "es" ? `hace ${n}${unit}` : `${n}${unit} ago`);
  if (min < 1) return lang === "es" ? "ahora" : "just now";
  if (min < 60) return u(min, "m");
  const h = Math.floor(min / 60);
  if (h < 24) return u(h, "h");
  return u(Math.floor(h / 24), "d");
}

function activityText(m: Message, lang: Lang): string {
  const e = (m.parsed_entities ?? {}) as Record<string, any>;
  const first = Array.isArray(e.actions) ? e.actions[0] : e; // ParseResult or legacy
  const name: string | undefined = first?.client_name;
  const amt = first?.amount;
  switch (m.parsed_intent) {
    case "log_quote":
      return lang === "es"
        ? `Cotización — ${name ?? "cliente"}${amt != null ? `, ${money(amt)}${periodLabel(first?.billing_period, lang)}` : ""}`
        : `Logged quote — ${name ?? "client"}${amt != null ? `, ${money(amt)}${periodLabel(first?.billing_period, lang)}` : ""}`;
    case "update_status": {
      const s = first?.status;
      if (s === "lost" || s === "completed") return lang === "es" ? `Quitado — ${name ?? "cliente"}` : `Removed — ${name ?? "client"}`;
      if (s === "active") return lang === "es" ? `Activado — ${name ?? "cliente"}` : `Marked active — ${name ?? "client"}`;
      return lang === "es" ? `Actualizado — ${name ?? "cliente"}` : `Updated — ${name ?? "client"}`;
    }
    case "log_job": return lang === "es" ? `Trabajo — ${first?.job_description ?? m.body}` : `Logged job — ${first?.job_description ?? m.body}`;
    case "log_payment": return lang === "es" ? `Pago — ${amt != null ? money(amt) : ""}${name ? ` de ${name}` : ""}` : `Payment — ${amt != null ? money(amt) : ""}${name ? ` from ${name}` : ""}`;
    case "set_reminder": return lang === "es" ? `Recordatorio — ${first?.reminder_text ?? ""}` : `Set reminder — ${first?.reminder_text ?? ""}`;
    case "query": return lang === "es" ? `Pregunta — "${first?.query_text ?? m.body}"` : `Asked — "${first?.query_text ?? m.body}"`;
    case "set_language": return lang === "es" ? "Cambió el idioma" : "Changed language";
    default: return m.body;
  }
}

export default async function DashboardPage({ searchParams }: { searchParams?: { imported?: string; cityerr?: string } }) {
  const business = await currentBusiness();
  const session = await currentSession();
  const importedCount = Number(searchParams?.imported ?? 0) || 0;
  const bid = business.id;
  // Admin (founder) sees a business switcher + a link to register operators.
  const admin = session?.kind === "admin"
    ? { currentId: bid, businesses: (await listBusinesses()).map((b) => ({ id: b.id, name: b.name })) }
    : null;
  const lang = businessLang(business);
  const d = dict(lang);

  const [{ data: clientRows }, { data: jobRows }, { data: schedJobRows }, { data: payRows }, { data: remRows }, { data: msgRows }] =
    await Promise.all([
      db().from("clients").select("*").eq("business_id", bid).order("updated_at", { ascending: false }),
      db().from("jobs").select("*").eq("business_id", bid).order("performed_on", { ascending: false }).limit(30),
      db().from("jobs").select("*").eq("business_id", bid).eq("status", "scheduled"),
      db().from("payments").select("*").eq("business_id", bid).order("created_at", { ascending: false }).limit(30),
      db().from("reminders").select("*").eq("business_id", bid).eq("status", "pending").order("due_at", { ascending: true }),
      db().from("messages").select("*").eq("business_id", bid).eq("direction", "inbound").order("created_at", { ascending: false }).limit(30),
    ]);

  const clients = (clientRows ?? []) as Client[];
  const jobs = (jobRows ?? []) as Job[];
  const schedJobs = (schedJobRows ?? []) as Job[];
  const payments = (payRows ?? []) as Payment[];
  const reminders = (remRows ?? []) as Reminder[];
  const messages = (msgRows ?? []) as Message[];
  const nameOf = (id: string | null) => clients.find((c) => c.id === id)?.name ?? "—";

  const active = clients.filter((c) => c.status === "active");
  const quoted = clients.filter((c) => c.status === "quoted");
  const mrr = active.reduce((s, c) => s + monthlyEquivalent(c), 0);
  const potential = quoted.reduce((s, c) => s + monthlyEquivalent(c), 0);
  const weekEnd = Date.now() + 7 * 86400000;
  const remindersThisWeek = reminders.filter((r) => new Date(r.due_at).getTime() <= weekEnd).length;
  // Outstanding now comes from the receivables ledger (charges), not manual "owes" rows.
  const outstanding = await totalOutstanding(bid);
  const scheduledThisWeek = active.filter((c) => c.next_service_on && new Date(c.next_service_on + "T00:00:00").getTime() <= weekEnd).length;

  // ── Schedule: 42 days of stops, jobs, reminders — plus weather when a city is set ──
  const tz = business.timezone || "America/New_York";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const HORIZON = 42; // six full weeks — covers "this month" from any day
  const addDays = (ymd: string, n: number) => {
    const [y, m, dd] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
  };
  const endStr = addDays(todayStr, HORIZON - 1);
  const weekdayNum = (ymd: string) => new Date(ymd + "T00:00:00Z").getUTCDay(); // 0=Sun
  const DAY_NUM: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  type SvcItem = { id: string; name: string; address: string | null; overdue: boolean };
  const svcByDate = new Map<string, SvcItem[]>();
  const pushSvc = (date: string, item: SvcItem) => (svcByDate.get(date) ?? svcByDate.set(date, []).get(date)!).push(item);
  for (const c of active) {
    const item = { id: c.id, name: c.name, address: c.address, overdue: false };
    if (c.next_service_on) {
      // Overdue visits surface on TODAY; then project the recurring cadence forward.
      let d0 = c.next_service_on;
      if (d0 < todayStr) {
        pushSvc(todayStr, { ...item, overdue: true });
        if (!c.service_interval) continue;
        while (d0 < todayStr) d0 = nextCycleDate(d0, c.service_interval);
        if (d0 === todayStr) d0 = nextCycleDate(d0, c.service_interval); // today already shown as overdue
      }
      for (let d = d0, guard = 0; d <= endStr && guard < 60; guard++) {
        pushSvc(d, item);
        if (!c.service_interval) break;
        d = nextCycleDate(d, c.service_interval);
      }
    } else if (c.service_day && c.service_day in DAY_NUM) {
      // No concrete next date, but a weekly route day — show them on that day each week.
      let d = addDays(todayStr, (DAY_NUM[c.service_day] - weekdayNum(todayStr) + 7) % 7);
      for (let guard = 0; d <= endStr && guard < 8; guard++, d = addDays(d, 7)) pushSvc(d, item);
    }
  }
  for (const list of svcByDate.values()) list.sort((a, b) => Number(b.overdue) - Number(a.overdue));

  const jobsByDate = new Map<string, { id: string; description: string; who: string | null }[]>();
  for (const j of schedJobs) {
    if (!j.scheduled_on) continue;
    const date = j.scheduled_on < todayStr ? todayStr : j.scheduled_on; // stale scheduled jobs surface today
    if (date > endStr) continue;
    (jobsByDate.get(date) ?? jobsByDate.set(date, []).get(date)!).push({
      id: j.id, description: j.description, who: j.client_id ? nameOf(j.client_id) : null,
    });
  }

  type RemItem = { id: string; clientId: string | null; text: string; who: string | null; overdue: boolean };
  const remByDate = new Map<string, RemItem[]>();
  for (const r of reminders) {
    const due = new Date(r.due_at).toLocaleDateString("en-CA", { timeZone: tz });
    const date = due < todayStr ? todayStr : due;
    if (date > endStr) continue;
    (remByDate.get(date) ?? remByDate.set(date, []).get(date)!).push({
      id: r.id, clientId: r.client_id, text: r.text,
      who: r.client_id ? nameOf(r.client_id) : null, overdue: due < todayStr,
    });
  }

  // Weather (optional): city geocoded once at set-time; forecast covers ≤16 days.
  let weatherByDate = new Map<string, DayWeather>();
  const { lat, lon } = business.settings ?? {};
  if (typeof lat === "number" && typeof lon === "number") {
    const fc = await getForecast(lat, lon, tz, lang).catch(() => [] as DayWeather[]);
    weatherByDate = new Map(fc.map((w) => [w.date, w]));
  }

  const locale = lang === "es" ? "es-ES" : "en-US";
  const schedule = {
    city: business.settings?.city ?? null,
    cityErr: searchParams?.cityerr === "1",
    days: Array.from({ length: HORIZON }, (_, i) => {
      const date = addDays(todayStr, i);
      const dt = new Date(date + "T00:00:00");
      return {
        date,
        isToday: i === 0,
        weekdayStr: dt.toLocaleDateString(locale, { weekday: "long" }),
        dateShort: dt.toLocaleDateString(locale, { month: "short", day: "numeric" }),
        weather: weatherByDate.get(date) ?? null,
        services: svcByDate.get(date) ?? [],
        jobs: jobsByDate.get(date) ?? [],
        reminders: remByDate.get(date) ?? [],
      };
    }),
  };

  // Group quote follow-ups + earliest-next per client.
  const quoteSeq = new Map<string, Reminder[]>();
  const manual: Reminder[] = [];
  for (const r of reminders) {
    if (r.kind === "quote_followup" && r.client_id) {
      const arr = quoteSeq.get(r.client_id) ?? [];
      arr.push(r);
      quoteSeq.set(r.client_id, arr);
    } else manual.push(r);
  }

  // ── Display-ready props (no functions cross the client boundary) ────────────
  const clientViews = clients
    .filter((c) => c.status === "quoted" || c.status === "active" || c.status === "paused")
    .map((c) => {
      const next = quoteSeq.get(c.id)?.[0]?.due_at ?? null;
      const interval = c.service_interval
        ? ({ weekly: lang === "es" ? "semanal" : "weekly", biweekly: lang === "es" ? "c/2 sem" : "biweekly", monthly: lang === "es" ? "mensual" : "monthly" } as Record<string, string>)[c.service_interval]
        : null;
      return {
        id: c.id, name: c.name, address: c.address, status: c.status,
        amountStr: c.amount != null ? money(c.amount) : "—",
        amountRaw: c.amount, billingPeriod: c.billing_period,
        periodStr: periodLabel(c.billing_period, lang),
        service: c.service_description, notes: c.notes,
        phone: c.phone ?? null, email: c.email ?? null,
        // "Client since" = when they entered the book, not the last edit.
        sentStr: fmtShort(c.created_at, lang), sinceStr: fmtShort(c.created_at, lang),
        nextStr: next ? fmtShort(next, lang) : null,
        // black book: recurring service schedule
        scheduleStr: interval ? [interval, c.service_day ? c.service_day.charAt(0).toUpperCase() + c.service_day.slice(1) : ""].filter(Boolean).join(" · ") : null,
        nextServiceStr: c.next_service_on ? fmtShort(c.next_service_on, lang) : null,
        serviceDay: c.service_day ?? null,
        pausedUntilStr: c.paused_until ? fmtShort(c.paused_until, lang) : null,
      };
    });

  // Reminders due today/overdue live in the Today hero — Upcoming shows only the future.
  const isFuture = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }) > todayStr;
  const upcoming = [
    ...Array.from(quoteSeq.entries())
      .filter(([, seq]) => isFuture(seq[0].due_at))
      .map(([cid, seq]) => {
        const c = clients.find((x) => x.id === cid);
        return {
          id: `q-${cid}`, type: "quote" as const, sort: new Date(seq[0].due_at).getTime(), clientId: cid,
          title: d.followUpWith(c?.name ?? "client"),
          sub: c ? `${c.amount != null ? money(c.amount) + periodLabel(c.billing_period, lang) + " " : ""}${d.quoteWord}` : d.openQuote,
          dateStr: fmtShort(seq[0].due_at, lang), dateExact: fmtExact(seq[0].due_at, lang),
          moreDates: seq.slice(1).map((r) => fmtShort(r.due_at, lang)),
        };
      }),
    ...manual
      .filter((r) => isFuture(r.due_at))
      .map((r) => ({
        id: `m-${r.id}`, type: "manual" as const, sort: new Date(r.due_at).getTime(), clientId: r.client_id,
        title: r.text, sub: r.client_id ? nameOf(r.client_id) : "", dateStr: fmtShort(r.due_at, lang), dateExact: fmtExact(r.due_at, lang),
        moreDates: [] as string[],
      })),
  ].sort((a, b) => a.sort - b.sort);

  const activity = messages.map((m) => ({
    id: m.id, kind: m.parsed_intent ?? "help", text: activityText(m, lang),
    rel: relativeTime(m.created_at, lang), exact: fmtExact(m.created_at, lang),
  }));

  const photos = await listPhotos(bid).catch((e) => {
    console.error("[dashboard] photos failed:", e);
    return [] as Awaited<ReturnType<typeof listPhotos>>;
  });

  // Money owed — the SAME ledger the "who owes me?" text reads, so they never disagree.
  const balances = await openBalances(bid);
  const outstandingList = balances.map((b) => {
    const c = b.client_id ? clients.find((x) => x.id === b.client_id) : null;
    return {
      clientId: c ? c.id : null, // only linkable if the client still exists
      name: c ? c.name : (lang === "es" ? "Sin asignar" : "Unassigned"),
      amountStr: money(Math.round(b.balance)),
      dueStr: fmtShort(b.oldest_due, lang),
    };
  });

  const jobViews = jobs.map((j) => ({ id: j.id, clientId: j.client_id, description: j.description, dateStr: fmtShort(j.performed_on, lang), who: j.client_id ? nameOf(j.client_id) : null }));
  const payViews = payments.map((p) => ({ id: p.id, clientId: p.client_id, amountStr: money(p.amount), dateStr: fmtShort(p.paid_on ?? p.created_at, lang), who: p.client_id ? nameOf(p.client_id) : null, status: p.status ?? "paid" }));
  const reminderViews = reminders.map((r) => ({ id: r.id, clientId: r.client_id, text: r.text, dateStr: fmtShort(r.due_at, lang), kind: r.kind }));

  // Localized weekday names keyed by lowercase English name (Jan 7 2024 = Sunday).
  const weekdays: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(2024, 0, 7 + i));
    const key = dt.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    weekdays[key] = dt.toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { weekday: "long" });
  }

  // Plain-string label bag for the client component (no function values).
  const labels = {
    signOut: d.signOut, pipeline: d.pipeline, upcomingReminders: d.upcomingReminders, recentActivity: d.recentActivity,
    recentJobs: d.recentJobs, recentPayments: d.recentPayments, searchPlaceholder: d.searchPlaceholder, all: d.all,
    noOpenQuotes: d.noOpenQuotes, noActiveClients: d.noActiveClients, noMatches: d.noMatches, next: d.next, sent: d.sent,
    clientSince: d.clientSince, openQuote: d.openQuote, nothingScheduled: d.nothingScheduled, seeAll: d.seeAll, seeLess: d.seeLess,
    noActivity: d.noActivity, noJobs: d.noJobs, noPayments: d.noPayments, status: d.status, details: d.details, close: d.close,
    contact: d.contact, address: d.address, amount: d.amount, service: d.service, notes: d.notes, jobs: d.jobs, payments: d.payments,
    reminders: d.reminders, none: d.none, markAccepted: d.markAccepted, markDeclined: d.markDeclined, addNote: d.addNote,
    addReminder: d.addReminder, logPayment: d.logPayment, notePlaceholder: d.notePlaceholder, reminderTextPlaceholder: d.reminderTextPlaceholder,
    amountPlaceholder: d.amountPlaceholder, save: d.save, snooze: d.snooze, done: d.done, cancel: d.cancel, language: d.language,
    monthlyRecurring: d.monthlyRecurring, openQuotes: d.openQuotes, remindersThisWeek: d.remindersThisWeek, activeClients: d.activeClients,
    outstanding: d.outstanding, nextService: d.nextService, schedule: d.schedule, scheduledThisWeek: d.scheduledThisWeek,
    paid: d.paid, unpaid: d.unpaid, overdue: d.overdue,
    importClients: d.importClients, firstRunTitle: d.firstRunTitle, firstRunBody: d.firstRunBody,
    today: d.today, allClearToday: d.allClearToday, serviceDue: d.serviceDue,
    unscheduled: d.unscheduled, weekdays,
    colName: d.colName, colPeriod: d.colPeriod,
    setCity: d.setCity, cityPlaceholder: d.cityPlaceholder, cityNotFound: d.cityNotFound,
    calendarView: d.calendarView, dayView: d.dayView, backToToday: d.backToToday,
    nothingThatDay: d.nothingThatDay, prevDay: d.prevDay, nextDay: d.nextDay,
    scheduledJob: d.scheduledJob, reminderWord: d.reminderWord,
    exportCsv: d.exportCsv, phoneLabel: d.phoneLabel, emailLabel: d.emailLabel,
    pausedUntil: d.pausedUntil, pausedGroup: d.pausedGroup, confirmDecline: d.confirmDecline,
    photos: d.photos,
    dragHint: d.dragHint, dropActive: d.dropActive, dropQuoted: d.dropQuoted,
    moneyOwed: d.moneyOwed, owedSince: d.owedSince,
    edit: d.edit, markPaid: d.markPaid, deleteEntry: d.deleteEntry,
    confirmVoid: d.confirmVoid, editClient: d.editClientLabel, colEmail: d.emailLabel,
    importedBanner: importedCount > 0 ? d.importedBanner.replace("{n}", String(importedCount)) : "",
  };

  return (
    <DashboardClient
      businessName={business.name}
      subtitle={config.twilio.fromNumber() ? d.remindersTextYou(fmtPhone(config.twilio.fromNumber()!)) : ""}
      lang={lang}
      labels={labels}
      kpis={{
        mrr: money(Math.round(mrr)),
        openQuotes: quoted.length,
        potential: potential > 0 ? d.potential(money(Math.round(potential))) : null,
        remindersThisWeek,
        activeClients: active.length,
        outstanding: outstanding > 0 ? money(Math.round(outstanding)) : null,
        scheduledThisWeek,
      }}
      schedule={schedule}
      admin={admin}
      photos={photos}
      outstanding={outstandingList}
      clients={clientViews}
      upcoming={upcoming}
      activity={activity}
      jobs={jobViews}
      payments={payViews}
      reminders={reminderViews}
    />
  );
}
