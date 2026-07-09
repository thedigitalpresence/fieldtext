import { db, getBusiness, getPrimaryPhone } from "@/lib/supabase";
import { dict } from "@/i18n";
import { businessLang, money, periodLabel } from "@/lib/templates";
import { monthlyEquivalent } from "@/lib/intents";
import { totalOutstanding } from "@/lib/charges";
import { listPhotos } from "@/lib/attachments";
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

export default async function DashboardPage({ searchParams }: { searchParams?: { imported?: string } }) {
  const business = await getBusiness();
  const importedCount = Number(searchParams?.imported ?? 0) || 0;
  const bid = business.id;
  const lang = businessLang(business);
  const d = dict(lang);

  const [{ data: clientRows }, { data: jobRows }, { data: payRows }, { data: remRows }, { data: msgRows }, primary] =
    await Promise.all([
      db().from("clients").select("*").eq("business_id", bid).order("updated_at", { ascending: false }),
      db().from("jobs").select("*").eq("business_id", bid).order("performed_on", { ascending: false }).limit(30),
      db().from("payments").select("*").eq("business_id", bid).order("created_at", { ascending: false }).limit(30),
      db().from("reminders").select("*").eq("business_id", bid).eq("status", "pending").order("due_at", { ascending: true }),
      db().from("messages").select("*").eq("business_id", bid).eq("direction", "inbound").order("created_at", { ascending: false }).limit(30),
      getPrimaryPhone(bid),
    ]);

  const clients = (clientRows ?? []) as Client[];
  const jobs = (jobRows ?? []) as Job[];
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

  // ── Today focus strip: services + reminders due today (or overdue) ──────────
  const tz = business.timezone || "America/New_York";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const todayServices = active
    .filter((c) => c.next_service_on && c.next_service_on <= todayStr)
    .map((c) => ({ id: c.id, name: c.name, address: c.address, overdue: (c.next_service_on as string) < todayStr }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue));
  const todayReminders = reminders
    .filter((r) => new Date(r.due_at).toLocaleDateString("en-CA", { timeZone: tz }) <= todayStr)
    .map((r) => ({
      id: r.id, clientId: r.client_id, text: r.text,
      who: r.client_id ? nameOf(r.client_id) : null,
      overdue: new Date(r.due_at).toLocaleDateString("en-CA", { timeZone: tz }) < todayStr,
    }));
  const todayStrip = {
    dateStr: new Date(todayStr + "T00:00:00").toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { weekday: "long", month: "short", day: "numeric" }),
    services: todayServices,
    reminders: todayReminders,
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
    exportCsv: d.exportCsv, phoneLabel: d.phoneLabel, emailLabel: d.emailLabel,
    pausedUntil: d.pausedUntil, pausedGroup: d.pausedGroup, confirmDecline: d.confirmDecline,
    photos: d.photos,
    importedBanner: importedCount > 0 ? d.importedBanner.replace("{n}", String(importedCount)) : "",
  };

  return (
    <DashboardClient
      businessName={business.name}
      subtitle={primary ? d.remindersTextYou(fmtPhone(primary.phone)) : ""}
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
      today={todayStrip}
      photos={photos}
      clients={clientViews}
      upcoming={upcoming}
      activity={activity}
      jobs={jobViews}
      payments={payViews}
      reminders={reminderViews}
    />
  );
}
