/**
 * Normalization pipeline — turns messy parsed fields into CLEAN canonical values
 * before anything is saved. One language-agnostic pipeline (EN + ES + Spanglish).
 *
 *   amount    -> numeric decimal           ("$1.2k", "five hundred", "500/mo" -> 500)
 *   period    -> enum                       ("a month", "al mes", "2x/mo" -> monthly/biweekly)
 *   name      -> Title Case, trimmed        ("angela jones" -> "Angela Jones")
 *   address   -> standard abbreviations     ("333 jones avenue" -> "333 Jones Ave")
 *   service   -> cleaned short phrase
 *   status    -> enum                        ("said yes"/"dijo que sí" -> active)
 *   dates     -> ISO / YYYY-MM-DD in tz      ("friday"/"viernes" -> concrete date)
 *
 * The LLM is told to return canonical values, but we re-run everything here in
 * code and never trust the model blindly.
 */
import type { BillingPeriod, ClientStatus, ParsedAction } from "./types";

export interface NormalizeContext {
  nowISO: string;
  timezone: string;
}

// ── Names ─────────────────────────────────────────────────────────────────────
export function titleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s'’\-/])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}
export function normalizeName(s?: string | null): string | undefined {
  if (!s) return undefined;
  const n = titleCase(s);
  return n || undefined;
}

// ── Addresses ─────────────────────────────────────────────────────────────────
const STREET_ABBR: Record<string, string> = {
  street: "St", st: "St", avenue: "Ave", ave: "Ave", av: "Ave",
  road: "Rd", rd: "Rd", drive: "Dr", dr: "Dr", lane: "Ln", ln: "Ln",
  boulevard: "Blvd", blvd: "Blvd", court: "Ct", ct: "Ct", place: "Pl", pl: "Pl",
  circle: "Cir", cir: "Cir", terrace: "Ter", ter: "Ter", way: "Way",
  parkway: "Pkwy", pkwy: "Pkwy", highway: "Hwy", hwy: "Hwy", trail: "Trl", trl: "Trl",
  north: "N", south: "S", east: "E", west: "W",
  apartment: "Apt", apt: "Apt", suite: "Ste", ste: "Ste", unit: "Unit",
};
export function normalizeAddress(s?: string | null): string | undefined {
  if (!s) return undefined;
  const tokens = s.trim().replace(/\s+/g, " ").split(" ").map((tok) => {
    const lower = tok.toLowerCase().replace(/[.,]/g, "");
    if (STREET_ABBR[lower]) return STREET_ABBR[lower];
    if (/\d/.test(tok)) return tok.toLowerCase(); // house numbers, "12b"
    return titleCase(tok);
  });
  const out = tokens.join(" ").trim();
  return out || undefined;
}

// ── Amounts ───────────────────────────────────────────────────────────────────
const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
  // Spanish
  cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, treinta: 30,
  cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
  mil: 1000,
};
function wordsToNumber(s: string): number | undefined {
  const tokens = s.toLowerCase().replace(/[^a-zà-ÿ ]/g, " ").split(/\s+/);
  let total = 0, current = 0, saw = false;
  for (const t of tokens) {
    if (t === "and" || t === "y") continue;
    const v = NUM_WORDS[t];
    if (v === undefined) continue;
    saw = true;
    if (v === 1000) { current = (current || 1) * 1000; total += current; current = 0; }
    else if (v === 100) { current = (current || 1) * 100; }
    else { current += v; }
  }
  total += current;
  return saw && total > 0 ? total : undefined;
}
export function normalizeAmount(input?: number | string | null): number | undefined {
  if (input == null) return undefined;
  if (typeof input === "number") return Number.isFinite(input) ? round2(input) : undefined;
  let t = input.toLowerCase().trim();
  // "$1.2k" / "1.2k" -> 1200
  const k = t.match(/(\d+(?:[.,]\d+)?)\s*k\b/);
  if (k) return round2(parseFloat(k[1].replace(",", ".")) * 1000);
  // first $-prefixed or bare number
  const dollar = t.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  const bare = t.match(/\b([0-9][0-9,]*(?:\.[0-9]+)?)\b/);
  const m = dollar ?? bare;
  if (m) return round2(parseFloat(m[1].replace(/,/g, "")));
  return wordsToNumber(t);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Billing period ────────────────────────────────────────────────────────────
export function normalizePeriod(input?: string | null): BillingPeriod | undefined {
  if (!input) return undefined;
  const t = input.toLowerCase();
  if (/(every other week|every 2 weeks|bi[-\s]?weekly|bi[-\s]?wk|2x\s*\/?\s*mo|2x a month|twice a month|cada dos semanas|cada 2 semanas|quincenal|bisemanal)/.test(t)) return "biweekly";
  if (/(weekly|\/wk|\bwk\b|a week|per week|every week|por semana|semanal|a la semana|cada semana)/.test(t)) return "weekly";
  if (/(monthly|\/mo\b|\bmo\b|a month|per month|every month|al mes|por mes|mensual|cada mes|\bmonth\b|\bmes\b)/.test(t)) return "monthly";
  if (/(one[-\s]?time|one[-\s]?off|\bonce\b|single|una vez|un[ií]co|por [uú]nica vez)/.test(t)) return "one_time";
  return undefined;
}

// ── Service ───────────────────────────────────────────────────────────────────
export function normalizeService(s?: string | null): string | undefined {
  if (!s) return undefined;
  const cleaned = s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;·-]+/, "") // leading punctuation ("for $250 a month, mowing" -> "mowing")
    .replace(/^(for|de|para)\s+/i, "")
    .replace(/[.,;]+$/, "")
    .toLowerCase();
  return cleaned || undefined;
}

// ── Status ────────────────────────────────────────────────────────────────────
export function normalizeStatus(input?: string | null): ClientStatus | undefined {
  if (!input) return undefined;
  const t = input.toLowerCase();
  if (/(accepted|said yes|says yes|say yes|are in|is in|we're in|signed|booked|approved|on board|good to go|let'?s do it|dijo que s[ií]|dijeron que s[ií]|acept[oó]|aceptaron|empieza|empiezan|s[ií] quiere|de acuerdo)/.test(t)) return "active";
  if (/(declined|said no|lost|passed|backed out|went with someone|not interested|perdimos|perd[ií]|no quiso|rechaz|se fue|cancel)/.test(t)) return "lost";
  if (/(completed|complete|finished|wrapped|all done|\bdone\b|terminad|termin[oó]|acabad|complet)/.test(t)) return "completed";
  if (/(quoted|cotic|cotiz)/.test(t)) return "quoted";
  return undefined;
}

// ── Dates (relative -> concrete) ──────────────────────────────────────────────
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, "miércoles": 3, jueves: 4, viernes: 5, sabado: 6, "sábado": 6,
};
/** Resolve a relative date phrase to { ymd, iso } at 9am local (best-effort, UTC math). */
export function resolveDate(text: string, nowISO: string): { ymd: string; iso: string } | null {
  const now = new Date(nowISO);
  const lower = text.toLowerCase();
  const at9 = (d: Date) => {
    d.setHours(9, 0, 0, 0);
    return { ymd: d.toISOString().slice(0, 10), iso: d.toISOString() };
  };
  if (/\b(today|hoy)\b/.test(lower)) return at9(new Date(now));
  if (/\b(tomorrow|mañana|manana)\b/.test(lower)) { const d = new Date(now); d.setDate(d.getDate() + 1); return at9(d); }
  const inN = lower.match(/\b(?:in|en)\s+(\d+)\s+(?:days?|d[ií]as?)\b/);
  if (inN) { const d = new Date(now); d.setDate(d.getDate() + parseInt(inN[1], 10)); return at9(d); }
  if (/\b(next week|pr[oó]xima semana|la semana que viene)\b/.test(lower)) { const d = new Date(now); d.setDate(d.getDate() + 7); return at9(d); }
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      const d = new Date(now);
      const delta = (dow - d.getDay() + 7) % 7 || 7; // next occurrence (not today)
      d.setDate(d.getDate() + delta);
      return at9(d);
    }
  }
  // "the 19th" / "el 19"
  const dom = lower.match(/\b(?:the|el)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dom) {
    const day = parseInt(dom[1], 10);
    if (day >= 1 && day <= 31) {
      const d = new Date(now);
      d.setDate(day);
      if (d.getTime() <= now.getTime()) d.setMonth(d.getMonth() + 1);
      return at9(d);
    }
  }
  return null;
}
function isISO(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
}

// ── The pipeline: normalize one action ────────────────────────────────────────
export function normalizeAction(raw: Record<string, any>, ctx: NormalizeContext): ParsedAction {
  const a: ParsedAction = {
    intent: raw.intent ?? "help",
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
  };

  if (raw.client_name) a.client_name = normalizeName(String(raw.client_name));
  if (raw.address) a.address = normalizeAddress(String(raw.address));
  if (raw.amount != null) a.amount = normalizeAmount(raw.amount);
  if (raw.billing_period) a.billing_period = normalizePeriod(String(raw.billing_period));
  if (raw.service_description) a.service_description = normalizeService(String(raw.service_description));
  if (raw.status) a.status = normalizeStatus(String(raw.status));
  if (raw.job_description) a.job_description = String(raw.job_description).trim();
  if (raw.query_text) a.query_text = String(raw.query_text).trim();
  if (raw.reminder_text) a.reminder_text = String(raw.reminder_text).trim().replace(/\s+/g, " ");
  if (raw.correction_text) a.correction_text = String(raw.correction_text).trim();

  // Dates: accept ISO/ymd as-is, otherwise resolve the phrase.
  a.performed_on = normalizeDay(raw.performed_on, ctx);
  a.paid_on = normalizeDay(raw.paid_on, ctx);
  if (raw.due_at != null) {
    const s = String(raw.due_at);
    if (isISO(s)) a.due_at = new Date(s).toISOString();
    else { const r = resolveDate(s, ctx.nowISO); if (r) a.due_at = r.iso; }
  }
  return a;
}
/** Levenshtein edit distance — used for typo-tolerant client matching. */
export function levenshtein(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

function normalizeDay(v: any, ctx: NormalizeContext): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  if (isISO(s)) return s.slice(0, 10);
  const r = resolveDate(s, ctx.nowISO);
  return r ? r.ymd : undefined;
}
