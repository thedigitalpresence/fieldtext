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

// ── Typo'd existing-client fuzzy match ────────────────────────────────────────
test("fuzzy match tolerates typos (smtih ~ smith)", () => {
  assert.ok(matchScore({ name: "smtih" }, { name: "Smith", address: "12 Oak St" }) > 0);
  assert.equal(matchScore({ name: "garcia" }, { name: "Smith", address: null }), 0);
});
