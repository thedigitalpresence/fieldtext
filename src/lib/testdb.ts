/**
 * Local test-mode database — a tiny file-backed store that mimics the slice of the
 * Supabase query builder this app uses (from/select/insert/update with
 * eq/gte/lte/in/order/limit/single/maybeSingle). Enabled only when LOCAL_TEST=true.
 *
 * Lets the whole app run locally with NO Docker, NO Postgres, NO Supabase account.
 * Persists to a gitignored JSON file so data survives dev reloads and cron runs.
 * For local testing ONLY — production uses the real Supabase client.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "./config";

type Row = Record<string, any>;
type Table =
  | "businesses"
  | "authorized_phones"
  | "clients"
  | "jobs"
  | "payments"
  | "reminders"
  | "messages"
  | "billing_events"
  | "charges"
  | "expenses"
  | "signups"
  | "invoices"
  | "attachments"
  | "auth_throttle"
  | "password_resets";
type Store = Record<Table, Row[]>;

const FILE = path.join(process.cwd(), ".fieldtext-test-db.json");

function seed(): Store {
  const now = new Date().toISOString();
  const businessId = crypto.randomUUID();
  return {
    businesses: [
      {
        id: businessId,
        slug: config.defaultBusinessSlug(),
        name: "Green Acres Landscaping (TEST)",
        owner_name: "Mike",
        timezone: "America/New_York",
        settings: {
          followup_days: 3,
          digest_enabled: false,
          digest_hour: 7,
          billing_enabled: false,
          quote_reminder_days: [2, 5, 7, 14],
          language: "en",
        },
        created_at: now,
      },
    ],
    authorized_phones: [
      {
        id: crypto.randomUUID(),
        business_id: businessId,
        phone: process.env.OWNER_PHONE || "+15555550100",
        label: "Owner cell",
        is_primary: true,
        opted_out: false,
        language: null,
        pending_state: null,
        created_at: now,
      },
    ],
    clients: [],
    jobs: [],
    payments: [],
    reminders: [],
    messages: [],
    billing_events: [],
    charges: [],
    expenses: [],
    signups: [],
    invoices: [],
    attachments: [],
    auth_throttle: [],
    password_resets: [],
  };
}

function load(): Store {
  try {
    if (fs.existsSync(FILE)) {
      const store = JSON.parse(fs.readFileSync(FILE, "utf8")) as Store;
      // Backfill tables added after the file was created (schema evolution).
      for (const t of ["charges", "expenses", "signups", "invoices", "attachments", "auth_throttle", "password_resets"] as Table[]) {
        if (!Array.isArray(store[t])) store[t] = [];
      }
      return store;
    }
  } catch (e) {
    console.error("[testdb] failed to read store, reseeding:", e);
  }
  const fresh = seed();
  save(fresh);
  return fresh;
}
function save(store: Store): void {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

type Result = { data: any; error: { message: string } | null };

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private _orders: { col: string; asc: boolean }[] = [];
  private _take?: number;
  private action: "select" | "insert" | "update" = "select";
  private payload: any = null;
  private returning = false;

  constructor(private table: Table) {}

  select(_cols?: string) {
    if (this.action !== "select") this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.action = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: Row) {
    this.action = "update";
    this.payload = patch;
    return this;
  }
  eq(col: string, val: any) { this.filters.push((r) => r[col] === val); return this; }
  gte(col: string, val: any) { this.filters.push((r) => r[col] >= val); return this; }
  lte(col: string, val: any) { this.filters.push((r) => r[col] <= val); return this; }
  in(col: string, vals: any[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    // Chained like real supabase: multiple .order() calls compose (primary first).
    this._orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this._take = n; return this; }

  private execList(): Result {
    const store = load();
    const rows = store[this.table];

    if (this.action === "insert") {
      const inserted = (this.payload as Row[]).map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        created_at: r.created_at ?? new Date().toISOString(),
        ...r,
      }));
      store[this.table] = rows.concat(inserted);
      save(store);
      return { data: this.returning ? inserted : null, error: null };
    }
    if (this.action === "update") {
      const updated: Row[] = [];
      for (const r of rows) {
        if (this.filters.every((f) => f(r))) {
          Object.assign(r, this.payload);
          updated.push(r);
        }
      }
      save(store);
      return { data: this.returning ? updated : null, error: null };
    }

    let out = rows.filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r }));
    if (this._orders.length) {
      out.sort((a, b) => {
        for (const { col, asc } of this._orders) {
          if (a[col] < b[col]) return asc ? -1 : 1;
          if (a[col] > b[col]) return asc ? 1 : -1;
        }
        return 0;
      });
    }
    if (this._take != null) out = out.slice(0, this._take);
    return { data: out, error: null };
  }

  private execOne(allowNull: boolean): Result {
    const arr = (this.execList().data as Row[]) ?? [];
    // Match real supabase .single(): >1 row is an error, not "first wins".
    if (arr.length > 1 && this.action === "select") return { data: null, error: { message: "Results contain more than one row" } };
    const first = arr.length > 0 ? arr[0] : null;
    if (!first && !allowNull) return { data: null, error: { message: "No rows found" } };
    return { data: first, error: null };
  }

  single(): Promise<Result> { return Promise.resolve(this.execOne(false)); }
  maybeSingle(): Promise<Result> { return Promise.resolve(this.execOne(true)); }
  then(resolve: (r: Result) => any, reject?: (e: any) => any) {
    return Promise.resolve(this.execList()).then(resolve, reject);
  }
}

let _client: { from: (t: Table) => Query } | null = null;
export function testDb() {
  if (!_client) _client = { from: (t: Table) => new Query(t) };
  return _client;
}
export const TEST_DB_FILE = FILE;
