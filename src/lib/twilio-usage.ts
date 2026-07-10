import { config } from "./config";

// Live Twilio spend for the founder dashboard. Hits the stable 2010-04-01 REST
// endpoints with basic auth (same approach as attachments.ts), so it doesn't
// depend on SDK method shapes. All best-effort: any failure returns ok:false and
// the dashboard just shows a friendly "couldn't reach Twilio" note.

export interface UsageLine { category: string; label: string; price: number; count: number }
export interface TwilioUsage {
  ok: boolean;
  currency: string;
  balance: number | null; // remaining prepaid balance
  monthSpend: number | null; // total spend, this calendar month
  todaySpend: number | null; // total spend, today
  lines: UsageLine[]; // this-month breakdown by category
  fetchedAt: string;
  error?: string;
}

// Shared auth for the 2010-04-01 REST API. null if creds aren't configured.
function twilioAuth(): { base: string; headers: Record<string, string> } | null {
  try {
    const sid = config.twilio.accountSid();
    const token = Buffer.from(`${sid}:${config.twilio.authToken()}`).toString("base64");
    return { base: `https://api.twilio.com/2010-04-01/Accounts/${sid}`, headers: { Authorization: `Basic ${token}` } };
  } catch {
    return null;
  }
}

// Umbrella categories Twilio also returns that would double-count if summed with
// their children — excluded from the itemized breakdown.
const UMBRELLA = new Set([
  "totalprice", "sms", "mms", "messages", "calls", "phonenumbers", "pfax",
  "recordings", "transcriptions", "calleridlookups",
]);

function titleize(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Tiny in-memory cache so repeated dashboard loads don't hammer Twilio (or slow
// the page). Per serverless instance; a few minutes is plenty fresh for spend.
let _cache: { at: number; data: TwilioUsage } | null = null;
const TTL_MS = 3 * 60 * 1000;

export async function getTwilioUsage(): Promise<TwilioUsage> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.data;

  const fetchedAt = new Date().toISOString();
  let sid: string, auth: string;
  try {
    sid = config.twilio.accountSid();
    auth = Buffer.from(`${sid}:${config.twilio.authToken()}`).toString("base64");
  } catch {
    return { ok: false, currency: "USD", balance: null, monthSpend: null, todaySpend: null, lines: [], fetchedAt, error: "Twilio credentials not configured." };
  }

  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Twilio ${path} → ${res.status}`);
    return res.json();
  };

  try {
    const [balanceJson, monthTotal, todayTotal, monthAll] = await Promise.all([
      get(`/Balance.json`),
      get(`/Usage/Records/ThisMonth.json?Category=totalprice`),
      get(`/Usage/Records/Today.json?Category=totalprice`),
      get(`/Usage/Records/ThisMonth.json?PageSize=200`),
    ]);

    const firstPrice = (j: any): number | null => {
      const rec = j?.usage_records?.[0];
      return rec ? Number(rec.price) : null;
    };

    const lines: UsageLine[] = ((monthAll?.usage_records ?? []) as any[])
      .filter((r) => !UMBRELLA.has(String(r.category)) && Number(r.price) > 0)
      .map((r) => ({
        category: String(r.category),
        label: r.description ? String(r.description) : titleize(String(r.category)),
        price: Number(r.price),
        count: Number(r.count) || 0,
      }))
      .sort((a, b) => b.price - a.price);

    const data: TwilioUsage = {
      ok: true,
      currency: String(balanceJson?.currency ?? "USD"),
      balance: balanceJson?.balance != null ? Number(balanceJson.balance) : null,
      monthSpend: firstPrice(monthTotal),
      todaySpend: firstPrice(todayTotal),
      lines,
      fetchedAt,
    };
    _cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[twilio-usage] fetch failed:", error);
    return { ok: false, currency: "USD", balance: null, monthSpend: null, todaySpend: null, lines: [], fetchedAt, error };
  }
}

// ─── Text delivery health ────────────────────────────────────────────────────
// Real deliverability from the Messages API: are our outbound texts getting
// through? (The composite "Health Score" in the console has no reliable public
// API; this is the signal that actually matters.)

export interface TwilioDelivery {
  ok: boolean;
  windowDays: number;
  outbound: number; // outbound messages in the window
  delivered: number; // carrier confirmed delivered
  failed: number; // failed + undelivered (the real problem signal)
  deliveryRate: number | null; // (outbound - failed) / outbound, as a percent
  topError: { code: string; count: number } | null;
  truncated: boolean; // hit the page cap (more messages than we counted)
  error?: string;
}

const FAILED = new Set(["failed", "undelivered"]);

let _delivCache: { at: number; data: TwilioDelivery } | null = null;
const DELIV_TTL_MS = 3 * 60 * 1000;
const WINDOW_DAYS = 7;

export async function getTwilioDelivery(): Promise<TwilioDelivery> {
  if (_delivCache && Date.now() - _delivCache.at < DELIV_TTL_MS) return _delivCache.data;

  const empty = (patch: Partial<TwilioDelivery>): TwilioDelivery => ({
    ok: false, windowDays: WINDOW_DAYS, outbound: 0, delivered: 0, failed: 0,
    deliveryRate: null, topError: null, truncated: false, ...patch,
  });

  const auth = twilioAuth();
  if (!auth) return empty({ error: "Twilio credentials not configured." });

  try {
    // Newest 1000 messages (plenty at beta volume); filter to the window in code
    // to sidestep the REST date-operator encoding quirk.
    const res = await fetch(`${auth.base}/Messages.json?PageSize=1000`, { headers: auth.headers, cache: "no-store" });
    if (!res.ok) throw new Error(`Twilio Messages → ${res.status}`);
    const json: any = await res.json();
    const all: any[] = json?.messages ?? [];
    const cutoff = Date.now() - WINDOW_DAYS * 86400_000;

    let outbound = 0, delivered = 0, failed = 0;
    const errors: Record<string, number> = {};
    for (const m of all) {
      const sent = m.date_sent ?? m.date_created;
      if (sent && new Date(sent).getTime() < cutoff) continue;
      if (!String(m.direction ?? "").startsWith("outbound")) continue;
      outbound += 1;
      const status = String(m.status ?? "");
      if (status === "delivered") delivered += 1;
      if (FAILED.has(status)) {
        failed += 1;
        const code = m.error_code != null ? String(m.error_code) : "unknown";
        errors[code] = (errors[code] ?? 0) + 1;
      }
    }

    const topEntry = Object.entries(errors).sort((a, b) => b[1] - a[1])[0];
    const data: TwilioDelivery = {
      ok: true,
      windowDays: WINDOW_DAYS,
      outbound,
      delivered,
      failed,
      deliveryRate: outbound > 0 ? ((outbound - failed) / outbound) * 100 : null,
      topError: topEntry ? { code: topEntry[0], count: topEntry[1] } : null,
      truncated: all.length >= 1000,
    };
    _delivCache = { at: Date.now(), data };
    return data;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[twilio-delivery] fetch failed:", error);
    return empty({ error });
  }
}
