/**
 * Parser + normalization tests — the core of the product, tested hard.
 * Run: npm test   (uses tsx + node:test)
 *
 * These exercise the offline heuristic + the normalization pipeline (the
 * deterministic path). The production LLM path produces the SAME normalized
 * shape; normalization is shared and language-agnostic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicParse, ParseContext } from "../anthropic";
import {
  normalizeAmount, normalizePeriod, normalizeStatus, normalizeName, normalizeAddress, resolveDate,
} from "../normalize";
import { matchScore } from "../clients";

const NOW = "2026-06-18T16:00:00.000Z"; // a Thursday
function ctx(): ParseContext {
  return { nowISO: NOW, timezone: "America/New_York", businessName: "Green Acres", ownerName: "Mike", lang: "en", knownClients: [] };
}
const one = (text: string) => heuristicParse(text, ctx()).actions;

// ── Amounts ───────────────────────────────────────────────────────────────────
test("amount: many forms all normalize to 500.00", () => {
  for (const f of ["$500", "500", "500 a month", "$500/mo", "500/mo"]) {
    assert.equal(normalizeAmount(f), 500, `"${f}"`);
  }
  assert.equal(normalizeAmount("five hundred"), 500);
  assert.equal(normalizeAmount("$1.2k"), 1200);
  assert.equal(normalizeAmount("1.2k"), 1200);
});
test("amount: Spanish word numbers", () => {
  assert.equal(normalizeAmount("quinientos"), 500);
  assert.equal(normalizeAmount("mil doscientos"), 1200);
});

// ── Billing period ────────────────────────────────────────────────────────────
test("period: English + Spanish phrasings -> enums", () => {
  for (const f of ["a month", "per month", "monthly", "al mes", "por mes", "mensual"]) assert.equal(normalizePeriod(f), "monthly", f);
  for (const f of ["a week", "weekly", "every week", "por semana", "semanal"]) assert.equal(normalizePeriod(f), "weekly", f);
  for (const f of ["every other week", "biweekly", "bi-weekly", "cada dos semanas", "quincenal", "2x/mo"]) assert.equal(normalizePeriod(f), "biweekly", f);
  for (const f of ["one time", "one-off", "once", "una vez"]) assert.equal(normalizePeriod(f), "one_time", f);
});

// ── Names + addresses ─────────────────────────────────────────────────────────
test("name: Title Case, keeps household label", () => {
  assert.equal(normalizeName("angela jones"), "Angela Jones");
  assert.equal(normalizeName("the smiths"), "The Smiths");
  assert.equal(normalizeName("  O'BRIEN "), "O'Brien");
});
test("address: standard abbreviations", () => {
  assert.equal(normalizeAddress("333 jones avenue"), "333 Jones Ave");
  assert.equal(normalizeAddress("12 oak st"), "12 Oak St");
  assert.equal(normalizeAddress("5 n main street"), "5 N Main St");
});

// ── Status verbs (EN + ES) ────────────────────────────────────────────────────
test("status: plain-language verbs -> enums", () => {
  assert.equal(normalizeStatus("angela said yes"), "active");
  assert.equal(normalizeStatus("the smiths are in"), "active");
  assert.equal(normalizeStatus("dijo que sí"), "active");
  assert.equal(normalizeStatus("lost the jones job"), "lost");
  assert.equal(normalizeStatus("perdimos a los garcia"), "lost");
});

// ── Relative dates (EN + ES) ──────────────────────────────────────────────────
test("dates: weekday resolves to the right day", () => {
  assert.equal(new Date(resolveDate("friday", NOW)!.iso).getDay(), 5);
  assert.equal(new Date(resolveDate("viernes", NOW)!.iso).getDay(), 5);
  assert.equal(new Date(resolveDate("monday", NOW)!.iso).getDay(), 1);
});
test("dates: in 3 days / en 3 días", () => {
  assert.ok(resolveDate("in 3 days", NOW));
  assert.ok(resolveDate("en 3 días", NOW));
});

// ── Full parse: English quote (no punctuation) ────────────────────────────────
test("EN quote, no punctuation -> normalized fields", () => {
  const a = one("quoted angela jones 333 jones ave 500 a month full coverage");
  assert.equal(a.length, 1);
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].client_name, "Angela Jones");
  assert.equal(a[0].address, "333 Jones Ave");
  assert.equal(a[0].amount, 500);
  assert.equal(a[0].billing_period, "monthly");
  assert.equal(a[0].service_description, "full coverage");
});

test("EN quote with at/for and $/mo", () => {
  const a = one("quoted angela jones at 333 jones ave for $500/mo full coverage");
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].client_name, "Angela Jones");
  assert.equal(a[0].address, "333 Jones Ave");
  assert.equal(a[0].amount, 500);
  assert.equal(a[0].billing_period, "monthly");
});

// ── Multi-action in one message ───────────────────────────────────────────────
test("multi-action: quote AND reminder", () => {
  const a = one("quoted the smiths 300 a month for mowing and remind me to call them friday");
  assert.equal(a.length, 2);
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].client_name, "The Smiths");
  assert.equal(a[0].amount, 300);
  assert.equal(a[0].service_description, "mowing");
  assert.equal(a[1].intent, "set_reminder");
  assert.equal(new Date(a[1].due_at!).getDay(), 5); // friday
});

// ── Relative-date reminder ────────────────────────────────────────────────────
test("EN reminder with relative date", () => {
  const a = one("remind me to invoice angela friday");
  assert.equal(a[0].intent, "set_reminder");
  assert.match(a[0].reminder_text ?? "", /invoice angela/i);
  assert.equal(new Date(a[0].due_at!).getDay(), 5);
});

// ── Status change in plain language ───────────────────────────────────────────
test("EN status change", () => {
  const a = one("angela said yes");
  assert.equal(a[0].intent, "update_status");
  assert.equal(a[0].status, "active");
  assert.equal(a[0].client_name, "Angela");
});

// ── Spanish quote ─────────────────────────────────────────────────────────────
test("ES quote", () => {
  const a = one("coticé a angela en 333 jones ave por $500 al mes cobertura completa");
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].client_name, "Angela");
  assert.equal(a[0].address, "333 Jones Ave");
  assert.equal(a[0].amount, 500);
  assert.equal(a[0].billing_period, "monthly");
  assert.equal(a[0].service_description, "cobertura completa");
});

// ── Spanglish quote ───────────────────────────────────────────────────────────
test("Spanglish quote", () => {
  const a = one("quoted los garcia 250 al mes for cleanup");
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].client_name, "Los Garcia");
  assert.equal(a[0].amount, 250);
  assert.equal(a[0].billing_period, "monthly");
  assert.equal(a[0].service_description, "cleanup");
});

// ── Spanish reminder + status ─────────────────────────────────────────────────
test("ES reminder", () => {
  const a = one("recuérdame facturar a los smith el viernes");
  assert.equal(a[0].intent, "set_reminder");
  assert.match(a[0].reminder_text ?? "", /facturar/i);
  assert.equal(new Date(a[0].due_at!).getDay(), 5);
});
test("ES status (dijo que sí)", () => {
  const a = one("angela dijo que sí empieza el lunes");
  assert.equal(a[0].intent, "update_status");
  assert.equal(a[0].status, "active");
});

// ── Query ─────────────────────────────────────────────────────────────────────
test("query stays a query", () => {
  const a = one("who do I still need to follow up with?");
  assert.equal(a[0].intent, "query");
});

// ── Black book: recurring schedule + payment status ───────────────────────────
test("recurring schedule on a quote", () => {
  const a = one("quoted bob at 12 oak st for $300/mo full coverage every other tuesday");
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].service_interval, "biweekly");
  assert.equal(a[0].service_day, "tuesday");
});

test("schedule-only update", () => {
  const a = one("the garcias every monday");
  assert.equal(a[0].intent, "update_status");
  assert.equal(a[0].service_interval, "weekly");
  assert.equal(a[0].service_day, "monday");
});

test("payment paid vs owes", () => {
  const paid = one("collected $450 from bob");
  assert.equal(paid[0].intent, "log_payment");
  assert.equal(paid[0].amount, 450);
  assert.equal(paid[0].payment_status, "paid");

  const owes = one("bob owes $450");
  assert.equal(owes[0].intent, "log_payment");
  assert.equal(owes[0].amount, 450);
  assert.equal(owes[0].payment_status, "unpaid");
});

test("ES owes (debe)", () => {
  const a = one("los garcia deben $275");
  assert.equal(a[0].intent, "log_payment");
  assert.equal(a[0].payment_status, "unpaid");
});

// ── Import: bulk text + CSV ───────────────────────────────────────────────────
import { parseTextHeuristic, parseCsv } from "../import";

test("bulk text import -> drafts", () => {
  const ds = parseTextHeuristic("smiths 12 oak 300/mo mowing\njane doe 5 elm 200 mowing\ngarcia 8 pine 275 full coverage");
  assert.equal(ds.length, 3);
  assert.equal(ds[0].name, "Smiths");
  assert.equal(ds[0].address, "12 Oak");
  assert.equal(ds[0].amount, 300);
  assert.equal(ds[0].billing_period, "monthly");
  assert.equal(ds[0].service_description, "mowing");
  assert.equal(ds[1].name, "Jane Doe");
  assert.equal(ds[1].amount, 200);
  assert.equal(ds[2].name, "Garcia");
  assert.equal(ds[2].amount, 275);
  assert.equal(ds[2].service_description, "full coverage");
  assert.equal(ds[0].status, "active"); // imports default to active
});

test("CSV import with headers", () => {
  const ds = parseCsv("name,address,amount,service\nThe Smiths,12 Oak St,300,mowing\nJane Doe,5 Elm St,200,weekly mow");
  assert.equal(ds.length, 2);
  assert.equal(ds[0].name, "The Smiths");
  assert.equal(ds[0].address, "12 Oak St");
  assert.equal(ds[0].amount, 300);
});

// ── Roadmap intents (heuristic path) ──────────────────────────────────────────
import { nextCycleDate } from "../charges";
import { normalizeExpenseCategory, normalizePaymentMethod } from "../normalize";

test("rainout -> bulk_reschedule", () => {
  const a = one("rained out, push today to friday");
  assert.equal(a[0].intent, "bulk_reschedule");
  assert.ok(a[0].target_date); // resolved to a YMD
  assert.equal(new Date(a[0].target_date + "T12:00:00Z").getUTCDay(), 5);
});

test("pause / resume", () => {
  const p = one("pause the smiths until friday");
  assert.equal(p[0].intent, "pause_client");
  assert.equal(p[0].client_name, "Smiths");
  assert.ok(p[0].pause_until);
  const r = one("resume the smiths");
  assert.equal(r[0].intent, "resume_client");
});

test("skip and move a visit", () => {
  const s = one("skip the garcias this week");
  assert.equal(s[0].intent, "skip_visit");
  assert.equal(s[0].client_name, "Garcias");
  const m = one("move garcia to friday");
  assert.equal(m[0].intent, "reschedule_visit");
  assert.equal(new Date(m[0].target_date + "T12:00:00Z").getUTCDay(), 5);
});

test("expense with category", () => {
  const a = one("spent 84 on mulch at home depot");
  assert.equal(a[0].intent, "log_expense");
  assert.equal(a[0].amount, 84);
  assert.equal(a[0].expense_category, "materials");
});

test("client info: phone + referral", () => {
  const ph = one("angela's number is 555-014-2233");
  assert.equal(ph[0].intent, "update_client_info");
  assert.equal(ph[0].client_name, "Angela");
  assert.ok(ph[0].phone?.includes("555"));
  const ref = one("angela referred by bob");
  assert.equal(ref[0].intent, "update_client_info");
  assert.equal(ref[0].referred_by, "Bob");
});

test("invoice / receipt request", () => {
  const inv = one("invoice bob");
  assert.equal(inv[0].intent, "request_invoice");
  assert.equal(inv[0].invoice_kind, "invoice");
  assert.equal(inv[0].client_name, "Bob");
  const rec = one("receipt for the smiths");
  assert.equal(rec[0].invoice_kind, "receipt");
});

test("price change does not become a quote", () => {
  const a = one("the smiths are now 350");
  assert.equal(a[0].intent, "price_change");
  assert.equal(a[0].client_name, "Smiths");
  assert.equal(a[0].amount, 350);
});

test("one-time quote with $ but no period keeps the amount", () => {
  const a = one("quoted jane at 5 oak st for $350 cleanup");
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].client_name, "Jane");
  assert.equal(a[0].amount, 350);
  assert.equal(a[0].billing_period, "one_time");
});

test("payment method captured", () => {
  const a = one("bob venmoed 300");
  assert.equal(a[0].intent, "log_payment");
  assert.equal(a[0].payment_method, "venmo");
});

test("'cancel the smiths' no longer maps to lost", () => {
  const a = one("cancel the smiths");
  assert.notEqual(a[0].intent, "update_status");
});

test("billing cycle date math", () => {
  assert.equal(nextCycleDate("2026-07-01", "weekly"), "2026-07-08");
  assert.equal(nextCycleDate("2026-07-01", "biweekly"), "2026-07-15");
  assert.equal(nextCycleDate("2026-07-15", "monthly"), "2026-08-15");
  assert.equal(nextCycleDate("2026-01-31", "monthly"), "2026-02-28"); // clamped
});

test("category + method normalizers", () => {
  assert.equal(normalizeExpenseCategory("gas for the truck"), "fuel");
  assert.equal(normalizeExpenseCategory("new trimmer blade"), "equipment");
  assert.equal(normalizePaymentMethod("paid cash"), "cash");
  assert.equal(normalizePaymentMethod("zelled me"), "zelle");
});

// ── Typo'd existing-client fuzzy match ────────────────────────────────────────
test("fuzzy match tolerates typos (smtih ~ smith)", () => {
  assert.ok(matchScore({ name: "smtih" }, { name: "Smith", address: "12 Oak St" }) > 0);
  assert.equal(matchScore({ name: "garcia" }, { name: "Smith", address: null }), 0);
});

// ── Weak lookalikes must confirm, not attach ──────────────────────────────────
import { STRONG_MATCH } from "../clients";

test("same last name only = WEAK match (Eric vs Elena Shackelford)", () => {
  const s = matchScore({ name: "eric shackelford" }, { name: "Elena Shackelford", address: null });
  assert.ok(s > 0, "should be a candidate");
  assert.ok(s < STRONG_MATCH, "but below the silent-attach threshold");
});
test("substring/exact names stay STRONG (no nagging on normal texts)", () => {
  assert.ok(matchScore({ name: "smiths" }, { name: "The Smiths", address: null }) >= STRONG_MATCH);
  assert.ok(matchScore({ name: "angela jones" }, { name: "Angela Jones", address: null }) >= STRONG_MATCH);
});

test("'new job <name> $1000 a week' = a new ACTIVE client, not a work log or pending quote", () => {
  const a = one("New job Eric Shackelford has a tent for 1000 a week");
  assert.equal(a[0].intent, "log_quote");
  assert.equal(a[0].status, "active"); // won work — no follow-up nudges
  assert.equal(a[0].client_name, "Eric Shackelford");
  assert.equal(a[0].amount, 1000);
  assert.equal(a[0].billing_period, "weekly");
});
