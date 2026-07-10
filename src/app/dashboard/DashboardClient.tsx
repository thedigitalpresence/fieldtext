"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  FileText, UserCheck, Briefcase, DollarSign, Bell, MessageCircle, Languages,
  CalendarClock, Search, X, Check, Clock, Ban, Upload, Sun, Leaf, TrendingUp, AlertCircle,
  Download, Loader2, ChevronRight, ChevronLeft, Phone, PauseCircle, Pencil, Users,
  CalendarDays, MapPin,
} from "lucide-react";
import type { ClientStatus, Lang } from "@/lib/types";
import {
  logout, setLanguage, markStatus, addNote, addReminderAction, logPayment, reminderAction,
  editClient, settleBalance, voidBalance, switchBusiness, setCity, deletePayment, deleteJob,
} from "./actions";

const STATUS_COLOR: Record<ClientStatus, string> = {
  quoted: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  completed: "bg-blue-100 text-blue-800",
  lost: "bg-gray-200 text-gray-600",
  paused: "bg-sky-100 text-sky-800",
};
const ACTIVITY_ICON: Record<string, typeof FileText> = {
  log_quote: FileText, update_status: UserCheck, log_job: Briefcase, log_payment: DollarSign,
  set_reminder: Bell, query: MessageCircle, set_language: Languages, correction: FileText, help: MessageCircle,
};

type ClientView = {
  id: string; name: string; address: string | null; status: ClientStatus;
  amountStr: string; amountRaw: number | null; billingPeriod: string | null;
  periodStr: string; service: string | null; notes: string | null;
  phone: string | null; email: string | null;
  sentStr: string; sinceStr: string; nextStr: string | null;
  scheduleStr: string | null; nextServiceStr: string | null; serviceDay: string | null;
  serviceInterval: string | null;
  pausedUntilStr: string | null;
};
type Upcoming = {
  id: string; type: "quote" | "manual"; clientId: string | null;
  title: string; sub: string; dateStr: string; dateExact: string; moreDates: string[];
};
type Activity = { id: string; kind: string; text: string; rel: string; exact: string };
type JobView = { id: string; clientId: string | null; description: string; dateStr: string; who: string | null };
type PayView = { id: string; clientId: string | null; amountStr: string; dateStr: string; who: string | null; status: string };
type RemView = { id: string; clientId: string | null; text: string; dateStr: string; kind: string };
type DayView = {
  date: string; isToday: boolean; weekdayStr: string; dateShort: string;
  weather: { emoji: string; label: string; hi: number; lo: number; precip: number | null } | null;
  services: { id: string; name: string; address: string | null; overdue: boolean }[];
  jobs: { id: string; description: string; who: string | null }[];
  reminders: { id: string; clientId: string | null; text: string; who: string | null; overdue: boolean }[];
};

interface Props {
  businessName: string;
  subtitle: string;
  lang: Lang;
  labels: Record<string, any>;
  kpis: { mrr: string; openQuotes: number; potential: string | null; remindersThisWeek: number; activeClients: number; outstanding: string | null; scheduledThisWeek: number };
  schedule: { city: string | null; cityErr: boolean; days: DayView[] };
  photos: { id: string; clientId: string | null; url: string; caption: string | null }[];
  outstanding: { clientId: string | null; name: string; amountStr: string; dueStr: string }[];
  admin: { currentId: string; businesses: { id: string; name: string }[] } | null;
  clients: ClientView[];
  upcoming: Upcoming[];
  activity: Activity[];
  jobs: JobView[];
  payments: PayView[];
  reminders: RemView[];
}

const TAP = "min-h-[44px]";
const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** Week rotated so TODAY leads — Thursday morning shows Thursday's route first. */
function rotatedDays(): string[] {
  const idx = (new Date().getDay() + 6) % 7; // JS sunday=0 → our monday-first index
  return [...DAY_ORDER.slice(idx), ...DAY_ORDER.slice(0, idx)];
}
// Two distinct column tints for the pipeline.
const COLUMN_TINT: Record<"quoted" | "active", { panel: string; chip: string }> = {
  quoted: { panel: "border-amber-200/70 bg-amber-50/60", chip: "bg-amber-100 text-amber-800" },
  active: { panel: "border-green-200/70 bg-green-50/60", chip: "bg-green-100 text-green-800" },
};
// Avatar hues hashed from the name so a 30-client roster scans at a glance.
// Brand green deliberately excluded — status chips keep that meaning.
const AVATAR_HUES = [
  "bg-sky-100 text-sky-800", "bg-violet-100 text-violet-800", "bg-rose-100 text-rose-800",
  "bg-amber-100 text-amber-800", "bg-teal-100 text-teal-800", "bg-indigo-100 text-indigo-800",
  "bg-orange-100 text-orange-800", "bg-fuchsia-100 text-fuchsia-800",
];

export default function DashboardClient(props: Props) {
  const L = props.labels;
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ClientStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);
  // Drag-to-move (desktop): optimistic status overrides + which column is hovered.
  const [, startMove] = useTransition();
  const [moved, setMoved] = useState<Record<string, ClientStatus>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<"quoted" | "active" | null>(null);

  // Apply optimistic moves so a dragged card jumps columns instantly.
  const clients = useMemo(
    () => props.clients.map((c) => (moved[c.id] && moved[c.id] !== c.status ? { ...c, status: moved[c.id] } : c)),
    [props.clients, moved]
  );

  function moveTo(id: string, status: "quoted" | "active") {
    const c = clients.find((x) => x.id === id);
    if (!c || c.status === status) return;
    setMoved((m) => ({ ...m, [id]: status }));
    const fd = new FormData();
    fd.set("clientId", id);
    fd.set("status", status);
    startMove(async () => {
      await markStatus(fd);
      router.refresh();
    });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.address ?? "").toLowerCase().includes(q);
    });
  }, [clients, query, filter]);

  const selected = clients.find((c) => c.id === selectedId) ?? null;
  const activityShown = showAllActivity ? props.activity : props.activity.slice(0, 3);

  // Active clients grouped by service day, TODAY first, "no day set" then Paused last.
  const activeByDay = (list: ClientView[]) => {
    const groups = new Map<string, ClientView[]>();
    for (const c of list) {
      const key = c.status === "paused" ? "__paused" : c.serviceDay && DAY_ORDER.includes(c.serviceDay) ? c.serviceDay : "__none";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
    }
    const week = rotatedDays();
    const order = [
      ...week.filter((d) => groups.has(d)),
      ...(groups.has("__none") ? ["__none"] : []),
      ...(groups.has("__paused") ? ["__paused"] : []),
    ];
    return order.map((day) => ({
      day,
      label: day === "__none" ? L.unscheduled : day === "__paused" ? L.pausedGroup : (L.weekdays?.[day] ?? day),
      clients: groups.get(day)!,
    }));
  };

  const clientCard = (c: ClientView, status: ClientStatus) => (
    <button
      key={c.id}
      draggable
      onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); }}
      onDragEnd={() => { setDragId(null); setDropCol(null); }}
      onClick={() => setSelectedId(c.id)}
      className={`flex w-full cursor-grab items-start gap-3 rounded-2xl border border-gray-100 bg-white p-3 text-left shadow-sm transition hover:border-brand/40 hover:shadow active:cursor-grabbing ${dragId === c.id ? "opacity-40" : ""}`}
    >
      <Avatar name={c.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold text-gray-900">{c.name}</span>
          <span className="shrink-0 text-sm font-semibold text-gray-900">
            {c.amountStr}<span className="font-normal text-gray-500">{c.periodStr}</span>
          </span>
        </div>
        {(c.address || c.service) && (
          <p className="mt-0.5 truncate text-sm text-gray-500">{[c.address, c.service].filter(Boolean).join(" · ")}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {status === "quoted" && c.nextStr && (
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand-dark">{L.next} {c.nextStr}</span>
          )}
          {status === "active" && c.nextServiceStr && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand-dark">
              <CalendarClock className="h-3 w-3" />{L.next} {c.nextServiceStr}
            </span>
          )}
          {c.status === "paused" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
              <PauseCircle className="h-3 w-3" />{c.pausedUntilStr ? `${L.pausedUntil} ${c.pausedUntilStr}` : L.status.paused}
            </span>
          )}
          <span className="text-xs text-gray-500">
            {status === "quoted"
              ? `${L.sent} ${c.sentStr}`
              : c.scheduleStr
              ? c.scheduleStr
              : `${L.clientSince} ${c.sinceStr}`}
          </span>
        </div>
      </div>
    </button>
  );

  return (
    <main lang={props.lang} className="mx-auto max-w-3xl space-y-7 px-4 py-6 sm:px-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-sm">
            <Leaf className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight text-gray-900">{props.businessName}</h1>
            {props.subtitle && <p className="mt-0.5 text-sm text-gray-500">{props.subtitle}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.admin && (
            <Link href="/dashboard/admin" title="Operators" aria-label="Operators" className={`flex ${TAP} min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-2.5 text-gray-600 hover:bg-gray-100`}>
              <Users className="h-4 w-4" />
            </Link>
          )}
          <div className="flex overflow-hidden rounded-lg border border-gray-300 text-xs font-medium">
            {(["en", "es"] as Lang[]).map((lng) => (
              <form key={lng} action={setLanguage}>
                <input type="hidden" name="lang" value={lng} />
                <button
                  disabled={props.lang === lng}
                  aria-pressed={props.lang === lng}
                  className={`${TAP} min-w-[44px] px-2.5 ${props.lang === lng ? "bg-brand text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
                >
                  {lng.toUpperCase()}
                </button>
              </form>
            ))}
          </div>
          <form action={logout}>
            <SubmitIconButton title={L.signOut}>
              <span className="hidden text-sm sm:inline">{L.signOut}</span>
              <X className="h-4 w-4 sm:hidden" aria-hidden />
            </SubmitIconButton>
          </form>
        </div>
      </header>

      {/* Admin: which operator's book am I viewing? */}
      {props.admin && props.admin.businesses.length > 1 && (
        <form action={switchBusiness} className="flex items-center gap-2 rounded-xl border border-brand/20 bg-brand/5 px-3 py-2">
          <Users className="h-4 w-4 shrink-0 text-brand-dark" />
          <span className="text-xs font-medium text-brand-dark">Viewing:</span>
          <select
            name="businessId"
            defaultValue={props.admin.currentId}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="min-w-0 flex-1 rounded-lg border border-brand/20 bg-white px-2 py-1.5 text-sm font-medium text-gray-800 focus:border-brand focus:outline-none"
          >
            {props.admin.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </form>
      )}

      {/* Post-import success banner */}
      {L.importedBanner && (
        <div className="flex items-center gap-2 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          <Check className="h-4 w-4 shrink-0" />{L.importedBanner}
        </div>
      )}

      {/* First-run onboarding — the call to action leads on an empty book */}
      {props.clients.length === 0 && (
        <Link href="/dashboard/import" className="block rounded-2xl border border-brand/30 bg-brand/5 p-4 shadow-sm transition hover:border-brand/50">
          <div className="flex items-center gap-3">
            <Upload className="h-6 w-6 shrink-0 text-brand-dark" />
            <div className="min-w-0">
              <p className="font-semibold text-brand-dark">{L.firstRunTitle}</p>
              <p className="text-sm text-gray-600">{L.firstRunBody}</p>
            </div>
            <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-brand-dark/50" />
          </div>
        </Link>
      )}

      {/* Schedule hero — today by default, browse any day, or flip to the calendar */}
      <ScheduleHero
        schedule={props.schedule}
        labels={L}
        onSelectClient={(id) => setSelectedId(id)}
      />

      {/* KPIs — 2x2 on mobile, 4 across on desktop (hidden until the book has clients) */}
      {props.clients.length > 0 && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat value={props.kpis.mrr} label={L.monthlyRecurring} Icon={TrendingUp} accent />
          <Stat value={`${props.kpis.activeClients}`} label={L.activeClients} Icon={UserCheck} sub={props.kpis.scheduledThisWeek > 0 ? `${props.kpis.scheduledThisWeek} ${L.scheduledThisWeek.toLowerCase()}` : undefined} />
          <Stat value={`${props.kpis.openQuotes}`} label={L.openQuotes} Icon={FileText} sub={props.kpis.potential ?? undefined} />
          {props.kpis.outstanding ? (
            <Stat value={props.kpis.outstanding} label={L.outstanding} Icon={AlertCircle} danger sub={`${props.kpis.remindersThisWeek} ${L.remindersThisWeek.toLowerCase()}`} />
          ) : (
            <Stat value={`${props.kpis.remindersThisWeek}`} label={L.remindersThisWeek} Icon={Bell} />
          )}
        </section>
      )}

      {/* Search + filter + import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={L.searchPlaceholder}
              aria-label={L.searchPlaceholder}
              className={`w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 ${TAP} text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand`}
            />
          </div>
          <Link
            href="/dashboard/import"
            title={L.importClients}
            aria-label={L.importClients}
            className={`flex ${TAP} min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-brand px-3 text-sm font-medium text-white hover:bg-brand-dark`}
          >
            <Upload className="h-4 w-4" /><span className="hidden sm:inline">{L.importClients}</span>
          </Link>
          <a
            href="/api/export"
            title={L.exportCsv}
            aria-label={L.exportCsv}
            className={`flex ${TAP} min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white px-3 text-gray-600 hover:border-brand/40`}
          >
            <Download className="h-4 w-4" />
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          {([["all", L.all], ["quoted", L.status.quoted], ["active", L.status.active]] as const).map(([key, lbl]) => (
            <button
              key={key}
              onClick={() => setFilter(key as "all" | ClientStatus)}
              aria-pressed={filter === key}
              className={`${TAP} rounded-full px-4 text-sm font-medium ${filter === key ? "bg-brand text-white" : "bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"}`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </section>

      {/* Pipeline — Quoted (left) → Active (right), the funnel. Drag a card between them. */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold text-gray-900">{L.pipeline}</h2>
          <span className="hidden text-xs text-gray-400 sm:inline">{L.dragHint}</span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(["quoted", "active"] as ("quoted" | "active")[]).map((status) => {
            const group = status === "active"
              ? filtered.filter((c) => c.status === "active" || c.status === "paused")
              : filtered.filter((c) => c.status === status);
            const tint = COLUMN_TINT[status];
            const isDropTarget = dragId != null && dropCol === status;
            return (
              <div
                key={status}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropCol(status); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropCol((d) => (d === status ? null : d)); }}
                onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || dragId; if (id) moveTo(id, status); setDragId(null); setDropCol(null); }}
                className={`rounded-2xl border p-3 transition ${tint.panel} ${isDropTarget ? "ring-2 ring-brand ring-offset-1" : ""}`}
              >
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${tint.chip}`}>{L.status[status]}</span>
                  <span className="text-gray-500">({group.length})</span>
                  {isDropTarget && <span className="ml-auto text-xs font-medium text-brand-dark">{status === "active" ? L.dropActive : L.dropQuoted}</span>}
                </div>
                <div className="space-y-2 pr-0.5 sm:max-h-[28rem] sm:overflow-y-auto sm:overscroll-contain">
                  {group.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-gray-300/70 bg-white/40 px-3 py-4 text-sm text-gray-500">
                      {query || filter !== "all" ? L.noMatches : status === "quoted" ? L.noOpenQuotes : L.noActiveClients}
                    </p>
                  ) : status === "active" ? (
                    activeByDay(group).map(({ day, label, clients }) => (
                      <div key={day} className="space-y-2">
                        <div className="sticky top-0 z-10 -mx-0.5 flex items-center gap-2 bg-green-50/90 px-1 py-1 backdrop-blur">
                          <span className="text-xs font-bold uppercase tracking-wide text-green-800">{label}</span>
                          <span className="h-px flex-1 bg-green-200/70" />
                          <span className="text-xs text-green-700/70">{clients.length}</span>
                        </div>
                        {clients.map((c) => clientCard(c, c.status))}
                      </div>
                    ))
                  ) : (
                    group.map((c) => clientCard(c, "quoted"))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Money owed — reads the same ledger as the "who owes me?" text */}
      {props.outstanding.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-gray-900">
            <DollarSign className="h-4 w-4 text-red-500" />{L.moneyOwed}
          </h2>
          <div className="divide-y divide-gray-50 rounded-2xl border border-red-100 bg-white shadow-sm">
            {props.outstanding.map((o, i) => (
              <div key={`${o.clientId ?? "x"}-${i}`} className="flex items-center justify-between gap-2 px-4 py-3">
                <button
                  onClick={() => o.clientId && setSelectedId(o.clientId)}
                  disabled={!o.clientId}
                  className="min-w-0 flex-1 text-left enabled:hover:opacity-70"
                >
                  <span className="block truncate font-semibold text-gray-900">{o.name}</span>
                  <span className="block text-xs text-gray-500">{L.owedSince} {o.dueStr}</span>
                </button>
                <span className="shrink-0 font-bold tabular-nums text-red-600">{o.amountStr}</span>
                <form action={settleBalance}>
                  <input type="hidden" name="clientId" value={o.clientId ?? "unassigned"} />
                  <ReminderSubmit title={L.markPaid}><Check className="h-4 w-4 text-brand" /></ReminderSubmit>
                </form>
                <form action={voidBalance} onSubmit={(e) => { if (!window.confirm(L.confirmVoid)) e.preventDefault(); }}>
                  <input type="hidden" name="clientId" value={o.clientId ?? "unassigned"} />
                  <ReminderSubmit title={L.deleteEntry}><X className="h-4 w-4 text-gray-400" /></ReminderSubmit>
                </form>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Upcoming reminders */}
      <section>
        <h2 className="mb-3 text-base font-bold text-gray-900">{L.upcomingReminders}</h2>
        {props.upcoming.length === 0 ? (
          <EmptyCard>{L.nothingScheduled}</EmptyCard>
        ) : (
          <ul className="space-y-2">
            {props.upcoming.map((u) => (
              <li key={u.id}>
                <button
                  onClick={() => u.clientId && setSelectedId(u.clientId)}
                  disabled={!u.clientId}
                  className="flex w-full items-start gap-3 rounded-xl border border-gray-100 bg-white p-3 text-left shadow-sm enabled:hover:border-brand/40"
                >
                  {u.type === "quote" ? <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" /> : <Bell className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-gray-900">{u.title}</span>
                      <span className="shrink-0 text-sm text-gray-500" title={u.dateExact}>{u.dateStr}</span>
                    </div>
                    <div className="mt-0.5 text-sm text-gray-500">
                      {u.sub}
                      {u.moreDates.length > 0 && <span className="ml-1 text-gray-500">· {u.moreDates.join(" · ")}</span>}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent activity */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">{L.recentActivity}</h2>
          {props.activity.length > 3 && (
            <button onClick={() => setShowAllActivity((v) => !v)} className={`${TAP} px-2 text-sm font-medium text-brand-dark`}>
              {showAllActivity ? L.seeLess : L.seeAll}
            </button>
          )}
        </div>
        {props.activity.length === 0 ? (
          <EmptyCard>{L.noActivity}</EmptyCard>
        ) : (
          <div className="divide-y divide-gray-50 rounded-xl border border-gray-100 bg-white p-1 shadow-sm">
            {activityShown.map((a) => {
              const Icon = ACTIVITY_ICON[a.kind] ?? MessageCircle;
              return (
                <div key={a.id} className="flex items-start gap-3 px-3 py-2.5">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                  <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                    <span className="break-words text-sm text-gray-700">{a.text}</span>
                    <span className="shrink-0 text-xs text-gray-500" title={a.exact}>{a.rel}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* History */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel title={L.recentJobs}>
          {props.jobs.length === 0 ? <Empty>{L.noJobs}</Empty> : props.jobs.slice(0, 12).map((j) => <Row key={j.id} left={j.description} right={j.dateStr} sub={j.who} />)}
        </Panel>
        <Panel title={L.recentPayments}>
          {props.payments.length === 0 ? <Empty>{L.noPayments}</Empty> : props.payments.slice(0, 12).map((p) => <Row key={p.id} left={p.amountStr} right={p.dateStr} sub={p.who} />)}
        </Panel>
      </section>

      {/* Client detail slide-over */}
      {selected && (
        <ClientDetail
          client={selected}
          labels={L}
          jobs={props.jobs.filter((j) => j.clientId === selected.id)}
          payments={props.payments.filter((p) => p.clientId === selected.id)}
          reminders={props.reminders.filter((r) => r.clientId === selected.id)}
          photos={props.photos.filter((p) => p.clientId === selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}

/**
 * The schedule hero: one day at a time (arrows to browse, weather when a city
 * is set) or a six-week calendar grid. Today always shows overdue work first.
 */
function ScheduleHero({
  schedule, labels: L, onSelectClient,
}: {
  schedule: { city: string | null; cityErr: boolean; days: DayView[] };
  labels: Record<string, any>;
  onSelectClient: (id: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [view, setView] = useState<"day" | "cal">("day");
  const [editingCity, setEditingCity] = useState(schedule.cityErr);
  const days = schedule.days;
  const day = days[Math.min(idx, days.length - 1)];
  const count = day.services.length + day.jobs.length + day.reminders.length;

  // Calendar layout: pad the 42-day window to full Monday-first weeks.
  const lead = (new Date(days[0].date + "T00:00:00").getDay() + 6) % 7;
  const cells: (DayView | null)[] = [...Array(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weekdayShort = (key: string) => String(L.weekdays?.[key] ?? key).slice(0, 3);

  return (
    <section className="overflow-hidden rounded-2xl shadow-sm ring-1 ring-brand/20">
      {/* Gradient header: day nav + weather + view toggle */}
      <div className="bg-gradient-to-r from-brand to-brand-dark px-3 py-3 text-white sm:px-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setView("day"); setIdx((i) => Math.max(0, i - 1)); }}
            disabled={idx === 0 && view === "day"}
            aria-label={L.prevDay}
            className={`${TAP} min-w-[40px] rounded-lg p-1.5 hover:bg-white/15 disabled:opacity-30`}
          >
            <ChevronLeft className="mx-auto h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-sm font-bold uppercase tracking-wide leading-tight">
              {day.isToday ? L.today : day.weekdayStr}
            </p>
            <p className="text-xs capitalize text-white/90">{day.isToday ? `${day.weekdayStr}, ${day.dateShort}` : day.dateShort}</p>
          </div>
          <button
            onClick={() => { setView("day"); setIdx((i) => Math.min(days.length - 1, i + 1)); }}
            disabled={idx >= days.length - 1 && view === "day"}
            aria-label={L.nextDay}
            className={`${TAP} min-w-[40px] rounded-lg p-1.5 hover:bg-white/15 disabled:opacity-30`}
          >
            <ChevronRight className="mx-auto h-5 w-5" />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-xs">
          {day.weather ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 font-medium">
              <span aria-hidden>{day.weather.emoji}</span>
              <span>{day.weather.label}</span>
              <span className="tabular-nums">{day.weather.hi}°/{day.weather.lo}°</span>
              {day.weather.precip != null && day.weather.precip >= 30 && (
                <span className="tabular-nums text-white/90">💧{day.weather.precip}%</span>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1"><Sun className="h-3.5 w-3.5" /></span>
          )}
          <button
            onClick={() => setEditingCity((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 font-medium hover:bg-white/25"
          >
            <MapPin className="h-3.5 w-3.5" />{schedule.city ?? L.setCity}
          </button>
          {!day.isToday && (
            <button onClick={() => { setIdx(0); setView("day"); }} className="rounded-full bg-white/15 px-2.5 py-1 font-semibold hover:bg-white/25">
              {L.backToToday}
            </button>
          )}
          <button
            onClick={() => setView((v) => (v === "day" ? "cal" : "day"))}
            aria-pressed={view === "cal"}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium ${view === "cal" ? "bg-white text-brand-dark" : "bg-white/15 hover:bg-white/25"}`}
          >
            <CalendarDays className="h-3.5 w-3.5" />{L.calendarView}
          </button>
          {view === "day" && count > 0 && (
            <span className="rounded-full bg-white/20 px-2.5 py-1 font-bold tabular-nums">{count}</span>
          )}
        </div>
      </div>

      {/* City form */}
      {editingCity && (
        <form action={setCity} onSubmit={() => setEditingCity(false)} className="flex items-center gap-2 border-b border-gray-100 bg-white px-4 py-3">
          <MapPin className="h-4 w-4 shrink-0 text-gray-500" />
          <input
            name="city"
            defaultValue={schedule.city ?? ""}
            placeholder={L.cityPlaceholder}
            autoFocus
            className={`${TAP} min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand`}
          />
          <MiniSubmit label={L.save} />
        </form>
      )}
      {schedule.cityErr && (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">{L.cityNotFound}</p>
      )}

      {view === "cal" ? (
        <div className="bg-white p-3">
          <div className="grid grid-cols-7 gap-1 text-center">
            {DAY_ORDER.map((d) => (
              <span key={d} className="pb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">{weekdayShort(d)}</span>
            ))}
            {cells.map((c, i) =>
              c ? (
                <button
                  key={c.date}
                  onClick={() => { setIdx(days.indexOf(c)); setView("day"); }}
                  className={`flex min-h-[54px] flex-col items-center gap-0.5 rounded-lg border p-1 text-xs transition hover:border-brand/50 ${
                    c.isToday ? "border-brand bg-brand/10 font-bold" : "border-gray-100 bg-white"
                  }`}
                >
                  <span className={`leading-tight ${c.isToday ? "text-brand-dark" : "text-gray-700"}`}>
                    {Number(c.date.slice(8, 10)) === 1 || days.indexOf(c) === 0 ? c.dateShort : Number(c.date.slice(8, 10))}
                  </span>
                  {c.weather && <span className="text-[11px] leading-none" title={c.weather.label} aria-hidden>{c.weather.emoji}</span>}
                  {(c.services.length + c.jobs.length) > 0 && (
                    <span className="rounded-full bg-brand/15 px-1.5 text-[10px] font-semibold leading-4 text-brand-dark tabular-nums">
                      {c.services.length + c.jobs.length}
                    </span>
                  )}
                  {c.reminders.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />}
                </button>
              ) : (
                <span key={`pad-${i}`} />
              )
            )}
          </div>
        </div>
      ) : count === 0 ? (
        <div className="flex items-center gap-2 bg-white px-4 py-4 text-sm text-gray-500">
          <Check className="h-4 w-4 text-brand" />{day.isToday ? L.allClearToday : L.nothingThatDay}
        </div>
      ) : (
        <ul className="divide-y divide-gray-50 bg-white">
          {day.services.map((s) => (
            <li key={`s-${s.id}`}>
              <button onClick={() => onSelectClient(s.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-brand/5">
                <Avatar name={s.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-gray-900">{s.name}</span>
                  <span className="block truncate text-xs text-gray-500">{s.address || L.serviceDue}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${s.overdue ? "bg-red-100 text-red-700" : "bg-brand/10 text-brand-dark"}`}>
                  {s.overdue ? L.overdue : L.serviceDue}
                </span>
              </button>
            </li>
          ))}
          {day.jobs.map((j) => (
            <li key={`j-${j.id}`} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-100"><Briefcase className="h-4 w-4 text-sky-600" /></span>
              <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold text-gray-900">{j.description}</span>
                <span className="block truncate text-xs text-gray-500">{j.who ?? L.scheduledJob}</span>
              </span>
            </li>
          ))}
          {day.reminders.map((r) => (
            <li key={`r-${r.id}`}>
              <button onClick={() => r.clientId && onSelectClient(r.clientId)} disabled={!r.clientId} className="flex w-full items-center gap-3 px-4 py-3 text-left enabled:hover:bg-brand/5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100"><Bell className="h-4 w-4 text-amber-600" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold text-gray-900">{r.text}</span>
                  {r.who && <span className="block truncate text-xs text-gray-500">{r.who}</span>}
                </span>
                {r.overdue && <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">{L.overdue}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClientDetail({
  client, labels: L, jobs, payments, reminders, photos, onClose,
}: {
  client: ClientView; labels: Record<string, any>; jobs: JobView[]; payments: PayView[]; reminders: RemView[];
  photos: { id: string; url: string; caption: string | null }[]; onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [client.id]); // reset when switching clients
  // Drawer manners: Escape closes, the page behind stops scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={client.name}>
      <button aria-label={L.close} onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto overscroll-contain bg-gray-50 shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={client.name} />
            <div className="min-w-0">
              <h3 className="truncate text-lg font-bold text-gray-900">{client.name}</h3>
              <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[client.status]}`}>{L.status[client.status]}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={() => setEditing((v) => !v)} aria-label={L.editClient} title={L.editClient} className={`${TAP} min-w-[44px] rounded-lg p-2 ${editing ? "bg-brand/10 text-brand-dark" : "text-gray-500 hover:bg-gray-100"}`}><Pencil className="mx-auto h-4 w-4" /></button>
            <button autoFocus onClick={onClose} aria-label={L.close} className={`${TAP} min-w-[44px] rounded-lg p-2 text-gray-500 hover:bg-gray-100`}><X className="mx-auto h-5 w-5" /></button>
          </div>
        </div>

        <div className="space-y-5 p-4">
          {/* Facts / Edit form */}
          {editing ? (
            <form action={editClient} onSubmit={() => setEditing(false)} className="space-y-2 rounded-xl border border-brand/30 bg-white p-4 shadow-sm">
              <input type="hidden" name="clientId" value={client.id} />
              <EditField name="name" label={L.colName} defaultValue={client.name} />
              <EditField name="address" label={L.address} defaultValue={client.address ?? ""} />
              <EditField name="phone" label={L.phoneLabel} defaultValue={client.phone ?? ""} type="tel" />
              <div className="grid grid-cols-2 items-end gap-2">
                <EditField name="amount" label={L.amount} defaultValue={client.amountRaw != null ? String(client.amountRaw) : ""} numeric />
                <label className="block text-xs">
                  <span className="mb-1 block font-medium text-gray-500">{L.colPeriod}</span>
                  <select name="billing_period" defaultValue={client.billingPeriod ?? ""} className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
                    {["", "monthly", "weekly", "biweekly", "one_time"].map((p) => <option key={p} value={p}>{p || "—"}</option>)}
                  </select>
                </label>
              </div>
              <EditField name="service" label={L.service} defaultValue={client.service ?? ""} />
              <div className="grid grid-cols-2 items-end gap-2">
                <label className="block text-xs">
                  <span className="mb-1 block font-medium text-gray-500">{L.howOften}</span>
                  <select name="service_interval" defaultValue={client.serviceInterval ?? ""} className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
                    <option value="">{L.intervalNone}</option>
                    <option value="weekly">{L.intervalWeekly}</option>
                    <option value="biweekly">{L.intervalBiweekly}</option>
                    <option value="monthly">{L.intervalMonthly}</option>
                  </select>
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block font-medium text-gray-500">{L.dayLabel}</span>
                  <select name="service_day" defaultValue={client.serviceDay ?? ""} className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none">
                    <option value="">—</option>
                    {DAY_ORDER.map((d) => <option key={d} value={d}>{L.weekdays?.[d] ?? d}</option>)}
                  </select>
                </label>
              </div>
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-gray-500">{L.notes}</span>
                <textarea
                  name="notes"
                  defaultValue={client.notes ?? ""}
                  rows={3}
                  className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </label>
              <div className="flex gap-2 pt-1">
                <ActionSubmit label={L.save} primary />
                <button type="button" onClick={() => setEditing(false)} className={`${TAP} rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-100`}>{L.cancel}</button>
              </div>
            </form>
          ) : (
            <dl className="space-y-2 rounded-xl border border-gray-100 bg-white p-4 text-sm shadow-sm">
              <Fact label={L.address} value={client.address || "—"} />
              {client.phone && (
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-gray-500">{L.phoneLabel}</dt>
                  <dd className="text-right font-medium">
                    <a href={`tel:${client.phone}`} className="inline-flex items-center gap-1 text-brand-dark underline"><Phone className="h-3.5 w-3.5" />{client.phone}</a>
                  </dd>
                </div>
              )}
              {client.email && <Fact label={L.emailLabel} value={client.email} />}
              <Fact label={L.amount} value={client.amountStr === "—" ? "—" : `${client.amountStr}${client.periodStr}`} />
              <Fact label={L.service} value={client.service || "—"} />
              {client.scheduleStr && <Fact label={L.schedule} value={client.scheduleStr} />}
              {client.nextServiceStr && <Fact label={L.nextService} value={client.nextServiceStr} />}
              {client.pausedUntilStr && <Fact label={L.pausedUntil} value={client.pausedUntilStr} />}
            </dl>
          )}

          {/* Quick actions */}
          <div className="grid grid-cols-2 gap-2">
            <ActionBtn action={markStatus} fields={{ clientId: client.id, status: "active" }} label={L.markAccepted} primary />
            <ActionBtn action={markStatus} fields={{ clientId: client.id, status: "lost" }} label={L.markDeclined} confirmText={L.confirmDecline} />
          </div>

          {/* Add note / reminder / payment */}
          <MiniForm action={addNote} clientId={client.id} name="note" placeholder={L.notePlaceholder} button={L.addNote} />
          <ReminderForm clientId={client.id} labels={L} />
          <MiniForm action={logPayment} clientId={client.id} name="amount" placeholder={L.amountPlaceholder} button={L.logPayment} numeric />

          {/* Notes */}
          {client.notes && (
            <Group title={L.notes}>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{client.notes}</p>
            </Group>
          )}

          {/* Site photos (texted in as MMS) */}
          {photos.length > 0 && (
            <Group title={L.photos}>
              <div className="grid grid-cols-3 gap-2">
                {photos.map((p) => (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-gray-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={p.caption ?? client.name} loading="lazy" className="aspect-square w-full object-cover" />
                  </a>
                ))}
              </div>
            </Group>
          )}

          {/* Reminders w/ actions */}
          <Group title={L.reminders}>
            {reminders.length === 0 ? <p className="text-sm text-gray-500">{L.none}</p> : reminders.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-2 border-b border-gray-50 py-2 last:border-0">
                <div className="min-w-0">
                  <p className="break-words text-sm text-gray-700">{r.text}</p>
                  <p className="text-xs text-gray-500">{r.dateStr}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <ReminderBtn id={r.id} action="snooze" title={L.snooze}><Clock className="h-4 w-4" /></ReminderBtn>
                  <ReminderBtn id={r.id} action="done" title={L.done}><Check className="h-4 w-4" /></ReminderBtn>
                  <ReminderBtn id={r.id} action="cancel" title={L.cancel}><Ban className="h-4 w-4" /></ReminderBtn>
                </div>
              </div>
            ))}
          </Group>

          {/* Jobs — deletable so a fat-fingered entry isn't forever */}
          <Group title={L.jobs}>
            {jobs.length === 0 ? <p className="text-sm text-gray-500">{L.none}</p> : jobs.map((j) => (
              <DeletableRow key={j.id} left={j.description} right={j.dateStr}
                action={deleteJob} idName="jobId" id={j.id} deleteTitle={L.deleteEntry} confirmText={L.confirmDeleteEntry} />
            ))}
          </Group>

          {/* Payments — deleting one gives the amount back to "Money owed" */}
          <Group title={L.payments}>
            {payments.length === 0 ? <p className="text-sm text-gray-500">{L.none}</p> : payments.map((p) => (
              <DeletableRow key={p.id} left={p.amountStr} right={p.dateStr}
                sub={p.status === "unpaid" ? L.unpaid : p.status === "overdue" ? L.overdue : undefined}
                action={deletePayment} idName="paymentId" id={p.id} deleteTitle={L.deleteEntry} confirmText={L.confirmDeleteEntry} />
            ))}
          </Group>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, sub, accent, danger, Icon }: { value: string; label: string; sub?: string; accent?: boolean; danger?: boolean; Icon?: typeof FileText }) {
  const tone = accent
    ? { card: "border-brand bg-brand", val: "text-white", lab: "text-white/90", sub: "text-white/90", icon: "text-white/70" }
    : danger
    ? { card: "border-red-200 bg-white", val: "text-red-700", lab: "text-gray-500", sub: "text-gray-500", icon: "text-red-500" }
    : { card: "border-gray-100 bg-white", val: "text-gray-900", lab: "text-gray-500", sub: "text-gray-500", icon: "text-brand" };
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${tone.card}`}>
      <div className="flex items-start justify-between gap-2">
        <div className={`text-2xl font-bold tracking-tight ${tone.val}`}>{value}</div>
        {Icon && <Icon className={`h-4 w-4 shrink-0 ${tone.icon}`} />}
      </div>
      <div className={`mt-0.5 text-xs font-medium uppercase tracking-wide ${tone.lab}`}>{label}</div>
      {sub && <div className={`mt-0.5 text-xs ${tone.sub}`}>{sub}</div>}
    </div>
  );
}
function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  return (
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${hue}`}>
      {initials}
    </span>
  );
}
/** Submit button that shows a spinner + disables while its form's server action runs. */
function Pending({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return pending ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : <>{children}</>;
}
function SubmitIconButton({ title, children }: { title: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      title={title}
      aria-label={title}
      className={`flex ${TAP} min-w-[44px] items-center justify-center gap-1.5 rounded-lg border border-gray-300 px-3 text-gray-600 hover:bg-gray-100 disabled:opacity-60`}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
    </button>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-base font-bold text-gray-900">{title}</h2>
      <div className="space-y-2 rounded-xl border border-gray-100 bg-white p-3 shadow-sm">{children}</div>
    </div>
  );
}
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">{children}</div>
    </div>
  );
}
function EditField({ name, label, defaultValue, type, numeric }: { name: string; label: string; defaultValue: string; type?: string; numeric?: boolean }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-gray-500">{label}</span>
      <input
        name={name}
        type={type ?? "text"}
        inputMode={numeric ? "decimal" : undefined}
        defaultValue={defaultValue}
        className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
      />
    </label>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}
function Row({ left, right, sub }: { left: string; right: string; sub?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-gray-50 pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="break-words text-sm text-gray-800">{left}</div>
        {sub && <div className="text-xs text-gray-500">{sub}</div>}
      </div>
      <div className="shrink-0 text-xs text-gray-500">{right}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}
function EmptyCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">{children}</div>;
}
function ActionBtn({ action, fields, label, primary, confirmText }: { action: (fd: FormData) => void; fields: Record<string, string>; label: string; primary?: boolean; confirmText?: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => { if (confirmText && !window.confirm(confirmText)) e.preventDefault(); }}
    >
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <ActionSubmit label={label} primary={primary} />
    </form>
  );
}
function ActionSubmit({ label, primary }: { label: string; primary?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} className={`w-full rounded-lg px-3 ${TAP} text-sm font-medium disabled:opacity-60 ${primary ? "bg-brand text-white hover:bg-brand-dark" : "border border-gray-300 text-gray-700 hover:bg-gray-100"}`}>
      <Pending>{label}</Pending>
    </button>
  );
}
function MiniForm({ action, clientId, name, placeholder, button, numeric }: { action: (fd: FormData) => void | Promise<void>; clientId: string; name: string; placeholder: string; button: string; numeric?: boolean }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} action={async (fd) => { await action(fd); ref.current?.reset(); }} className="flex gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <input
        name={name}
        aria-label={placeholder}
        inputMode={numeric ? "decimal" : "text"}
        placeholder={placeholder}
        className={`flex-1 rounded-lg border border-gray-200 px-3 ${TAP} text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand`}
      />
      <MiniSubmit label={button} />
    </form>
  );
}

/** Add-reminder with an optional date + time (native pickers). Blank date = the old "+3 days, 9 AM". */
function ReminderForm({ clientId, labels: L }: { clientId: string; labels: Record<string, any> }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} action={async (fd) => { await addReminderAction(fd); ref.current?.reset(); }} className="space-y-2">
      <div className="flex gap-2">
        <input type="hidden" name="clientId" value={clientId} />
        <input
          name="text"
          aria-label={L.reminderTextPlaceholder}
          placeholder={L.reminderTextPlaceholder}
          className={`flex-1 rounded-lg border border-gray-200 px-3 ${TAP} text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand`}
        />
        <MiniSubmit label={L.addReminder} />
      </div>
      <div className="flex items-center gap-2 pl-1">
        <span className="text-xs font-medium text-gray-500">{L.whenLabel}</span>
        <input type="date" name="date" aria-label={L.whenLabel}
          className={`${TAP} min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-sm text-gray-700 focus:border-brand focus:outline-none`} />
        <input type="time" name="time" defaultValue="09:00"
          className={`${TAP} rounded-lg border border-gray-200 px-2 text-sm text-gray-700 focus:border-brand focus:outline-none`} />
      </div>
    </form>
  );
}

/** History row with a confirm-guarded delete button. */
function DeletableRow({ left, right, sub, action, idName, id, deleteTitle, confirmText }: {
  left: string; right: string; sub?: string | null;
  action: (fd: FormData) => void | Promise<void>; idName: string; id: string; deleteTitle: string; confirmText: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-gray-50 pb-2 last:border-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm text-gray-800">{left}</div>
        {sub && <div className="text-xs text-gray-500">{sub}</div>}
      </div>
      <div className="shrink-0 text-xs text-gray-500">{right}</div>
      <form action={action} onSubmit={(e) => { if (!window.confirm(confirmText)) e.preventDefault(); }}>
        <input type="hidden" name={idName} value={id} />
        <ReminderSubmit title={deleteTitle}><X className="h-4 w-4 text-gray-400" /></ReminderSubmit>
      </form>
    </div>
  );
}
function MiniSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} className={`shrink-0 rounded-lg bg-brand px-3 ${TAP} min-w-[44px] text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60`}>
      <Pending>{label}</Pending>
    </button>
  );
}
function ReminderBtn({ id, action, title, children }: { id: string; action: string; title: string; children: React.ReactNode }) {
  return (
    <form action={reminderAction}>
      <input type="hidden" name="reminderId" value={id} />
      <input type="hidden" name="action" value={action} />
      <ReminderSubmit title={title}>{children}</ReminderSubmit>
    </form>
  );
}
function ReminderSubmit({ title, children }: { title: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} title={title} aria-label={title} className={`${TAP} flex min-w-[44px] items-center justify-center rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-60`}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
    </button>
  );
}
