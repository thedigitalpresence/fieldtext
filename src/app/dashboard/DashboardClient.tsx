"use client";

import { useMemo, useState } from "react";
import {
  FileText, UserCheck, Briefcase, DollarSign, Bell, MessageCircle, Languages,
  CalendarClock, Search, X, Check, Clock, Ban,
} from "lucide-react";
import type { ClientStatus, Lang } from "@/lib/types";
import {
  logout, setLanguage, markStatus, addNote, addReminderAction, logPayment, reminderAction,
} from "./actions";

const STATUS_COLOR: Record<ClientStatus, string> = {
  quoted: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  completed: "bg-blue-100 text-blue-800",
  lost: "bg-gray-200 text-gray-600",
};
const ACTIVITY_ICON: Record<string, typeof FileText> = {
  log_quote: FileText, update_status: UserCheck, log_job: Briefcase, log_payment: DollarSign,
  set_reminder: Bell, query: MessageCircle, set_language: Languages, correction: FileText, help: MessageCircle,
};

type ClientView = {
  id: string; name: string; address: string | null; status: ClientStatus;
  amountStr: string; periodStr: string; service: string | null; notes: string | null;
  sentStr: string; sinceStr: string; nextStr: string | null;
  scheduleStr: string | null; nextServiceStr: string | null;
};
type Upcoming = {
  id: string; type: "quote" | "manual"; clientId: string | null;
  title: string; sub: string; dateStr: string; dateExact: string; moreDates: string[];
};
type Activity = { id: string; kind: string; text: string; rel: string; exact: string };
type JobView = { id: string; clientId: string | null; description: string; dateStr: string; who: string | null };
type PayView = { id: string; clientId: string | null; amountStr: string; dateStr: string; who: string | null; status: string };
type RemView = { id: string; clientId: string | null; text: string; dateStr: string; kind: string };

interface Props {
  businessName: string;
  subtitle: string;
  lang: Lang;
  labels: Record<string, any>;
  kpis: { mrr: string; openQuotes: number; potential: string | null; remindersThisWeek: number; activeClients: number; outstanding: string | null; scheduledThisWeek: number };
  clients: ClientView[];
  upcoming: Upcoming[];
  activity: Activity[];
  jobs: JobView[];
  payments: PayView[];
  reminders: RemView[];
}

const TAP = "min-h-[44px]";

export default function DashboardClient(props: Props) {
  const L = props.labels;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ClientStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.clients.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.address ?? "").toLowerCase().includes(q);
    });
  }, [props.clients, query, filter]);

  const selected = props.clients.find((c) => c.id === selectedId) ?? null;
  const activityShown = showAllActivity ? props.activity : props.activity.slice(0, 6);

  return (
    <main className="mx-auto max-w-3xl space-y-7 px-4 py-6 sm:px-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight text-gray-900">{props.businessName}</h1>
          {props.subtitle && <p className="mt-0.5 text-sm text-gray-500">{props.subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-gray-300 text-xs font-medium">
            {(["en", "es"] as Lang[]).map((lng) => (
              <form key={lng} action={setLanguage}>
                <input type="hidden" name="lang" value={lng} />
                <button className={`px-2.5 py-2 ${props.lang === lng ? "bg-brand text-white" : "bg-white text-gray-600"}`}>
                  {lng.toUpperCase()}
                </button>
              </form>
            ))}
          </div>
          <form action={logout}>
            <button className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">{L.signOut}</button>
          </form>
        </div>
      </header>

      {/* KPIs — 2x2 on mobile, 4 across on desktop */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={props.kpis.mrr} label={L.monthlyRecurring} />
        <Stat value={`${props.kpis.activeClients}`} label={L.activeClients} sub={props.kpis.scheduledThisWeek > 0 ? `${props.kpis.scheduledThisWeek} ${L.scheduledThisWeek.toLowerCase()}` : undefined} />
        <Stat value={`${props.kpis.openQuotes}`} label={L.openQuotes} sub={props.kpis.potential ?? undefined} />
        {props.kpis.outstanding ? (
          <Stat value={props.kpis.outstanding} label={L.outstanding} sub={`${props.kpis.remindersThisWeek} ${L.remindersThisWeek.toLowerCase()}`} />
        ) : (
          <Stat value={`${props.kpis.remindersThisWeek}`} label={L.remindersThisWeek} />
        )}
      </section>

      {/* Search + filter */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={L.searchPlaceholder}
              className={`w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 ${TAP} text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand`}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {([["all", L.all], ["quoted", L.status.quoted], ["active", L.status.active]] as const).map(([key, lbl]) => (
            <button
              key={key}
              onClick={() => setFilter(key as any)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === key ? "bg-brand text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"}`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </section>

      {/* Pipeline */}
      <section>
        <h2 className="mb-3 text-base font-bold text-gray-900">{L.pipeline}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(["quoted", "active"] as ClientStatus[]).map((status) => {
            const group = filtered.filter((c) => c.status === status);
            return (
              <div key={status}>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_COLOR[status]}`}>{L.status[status]}</span>
                  <span className="text-gray-400">({group.length})</span>
                </div>
                <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-0.5">
                  {group.length === 0 && (
                    <p className="rounded-xl border border-dashed border-gray-200 px-3 py-4 text-sm text-gray-400">
                      {query || filter !== "all" ? L.noMatches : status === "quoted" ? L.noOpenQuotes : L.noActiveClients}
                    </p>
                  )}
                  {group.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className="w-full rounded-xl border border-gray-100 bg-white p-3 text-left shadow-sm transition hover:border-brand/40 hover:shadow"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-semibold text-gray-900">{c.name}</span>
                        <span className="shrink-0 text-sm font-semibold text-gray-900">
                          {c.amountStr}<span className="font-normal text-gray-400">{c.periodStr}</span>
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
                        <span className="text-xs text-gray-400">
                          {status === "quoted"
                            ? `${L.sent} ${c.sentStr}`
                            : c.scheduleStr
                            ? c.scheduleStr
                            : `${L.clientSince} ${c.sinceStr}`}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

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
                  {u.type === "quote" ? <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" /> : <Bell className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-gray-900">{u.title}</span>
                      <span className="shrink-0 text-sm text-gray-500" title={u.dateExact}>{u.dateStr}</span>
                    </div>
                    <div className="mt-0.5 text-sm text-gray-500">
                      {u.sub}
                      {u.moreDates.length > 0 && <span className="ml-1 text-gray-400">· {u.moreDates.join(" · ")}</span>}
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
          {props.activity.length > 6 && (
            <button onClick={() => setShowAllActivity((v) => !v)} className="text-sm font-medium text-brand-dark">
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
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                  <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                    <span className="break-words text-sm text-gray-700">{a.text}</span>
                    <span className="shrink-0 text-xs text-gray-400" title={a.exact}>{a.rel}</span>
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
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}

function ClientDetail({
  client, labels: L, jobs, payments, reminders, onClose,
}: {
  client: ClientView; labels: Record<string, any>; jobs: JobView[]; payments: PayView[]; reminders: RemView[]; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50">
      <button aria-label={L.close} onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto bg-gray-50 shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold text-gray-900">{client.name}</h3>
            <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[client.status]}`}>{L.status[client.status]}</span>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-5 p-4">
          {/* Facts */}
          <dl className="space-y-2 rounded-xl border border-gray-100 bg-white p-4 text-sm shadow-sm">
            <Fact label={L.address} value={client.address || "—"} />
            <Fact label={L.amount} value={client.amountStr === "—" ? "—" : `${client.amountStr}${client.periodStr}`} />
            <Fact label={L.service} value={client.service || "—"} />
            {client.scheduleStr && <Fact label={L.schedule} value={client.scheduleStr} />}
            {client.nextServiceStr && <Fact label={L.nextService} value={client.nextServiceStr} />}
          </dl>

          {/* Quick actions */}
          <div className="grid grid-cols-2 gap-2">
            <ActionBtn action={markStatus} fields={{ clientId: client.id, status: "active" }} label={L.markAccepted} primary />
            <ActionBtn action={markStatus} fields={{ clientId: client.id, status: "lost" }} label={L.markDeclined} />
          </div>

          {/* Add note / reminder / payment */}
          <MiniForm action={addNote} clientId={client.id} name="note" placeholder={L.notePlaceholder} button={L.addNote} />
          <MiniForm action={addReminderAction} clientId={client.id} name="text" placeholder={L.reminderTextPlaceholder} button={L.addReminder} />
          <MiniForm action={logPayment} clientId={client.id} name="amount" placeholder={L.amountPlaceholder} button={L.logPayment} numeric />

          {/* Notes */}
          {client.notes && (
            <Group title={L.notes}>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{client.notes}</p>
            </Group>
          )}

          {/* Reminders w/ actions */}
          <Group title={L.reminders}>
            {reminders.length === 0 ? <p className="text-sm text-gray-400">{L.none}</p> : reminders.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-2 border-b border-gray-50 py-2 last:border-0">
                <div className="min-w-0">
                  <p className="break-words text-sm text-gray-700">{r.text}</p>
                  <p className="text-xs text-gray-400">{r.dateStr}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <ReminderBtn id={r.id} action="snooze" title={L.snooze}><Clock className="h-4 w-4" /></ReminderBtn>
                  <ReminderBtn id={r.id} action="done" title={L.done}><Check className="h-4 w-4" /></ReminderBtn>
                  <ReminderBtn id={r.id} action="cancel" title={L.cancel}><Ban className="h-4 w-4" /></ReminderBtn>
                </div>
              </div>
            ))}
          </Group>

          {/* Jobs */}
          <Group title={L.jobs}>
            {jobs.length === 0 ? <p className="text-sm text-gray-400">{L.none}</p> : jobs.map((j) => <Row key={j.id} left={j.description} right={j.dateStr} />)}
          </Group>

          {/* Payments */}
          <Group title={L.payments}>
            {payments.length === 0 ? <p className="text-sm text-gray-400">{L.none}</p> : payments.map((p) => (
              <Row
                key={p.id}
                left={p.amountStr}
                right={p.dateStr}
                sub={p.status === "unpaid" ? L.unpaid : p.status === "overdue" ? L.overdue : undefined}
              />
            ))}
          </Group>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="text-2xl font-bold tracking-tight text-gray-900">{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-400">{sub}</div>}
    </div>
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
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h4>
      <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">{children}</div>
    </div>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}
function Row({ left, right, sub }: { left: string; right: string; sub?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-gray-50 pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="break-words text-sm text-gray-800">{left}</div>
        {sub && <div className="text-xs text-gray-400">{sub}</div>}
      </div>
      <div className="shrink-0 text-xs text-gray-500">{right}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400">{children}</p>;
}
function EmptyCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">{children}</div>;
}
function ActionBtn({ action, fields, label, primary }: { action: (fd: FormData) => void; fields: Record<string, string>; label: string; primary?: boolean }) {
  return (
    <form action={action}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`w-full rounded-lg px-3 ${TAP} text-sm font-medium ${primary ? "bg-brand text-white hover:bg-brand-dark" : "border border-gray-300 text-gray-700 hover:bg-gray-100"}`}>
        {label}
      </button>
    </form>
  );
}
function MiniForm({ action, clientId, name, placeholder, button, numeric }: { action: (fd: FormData) => void; clientId: string; name: string; placeholder: string; button: string; numeric?: boolean }) {
  return (
    <form action={action} className="flex gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <input
        name={name}
        inputMode={numeric ? "decimal" : "text"}
        placeholder={placeholder}
        className={`flex-1 rounded-lg border border-gray-200 px-3 ${TAP} text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand`}
      />
      <button className={`shrink-0 rounded-lg bg-brand px-3 ${TAP} text-sm font-medium text-white hover:bg-brand-dark`}>{button}</button>
    </form>
  );
}
function ReminderBtn({ id, action, title, children }: { id: string; action: string; title: string; children: React.ReactNode }) {
  return (
    <form action={reminderAction}>
      <input type="hidden" name="reminderId" value={id} />
      <input type="hidden" name="action" value={action} />
      <button title={title} className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-100">{children}</button>
    </form>
  );
}
