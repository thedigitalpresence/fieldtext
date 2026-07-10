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
