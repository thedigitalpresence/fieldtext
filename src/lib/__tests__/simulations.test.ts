/**
 * Realistic operator-texting simulations. Two layers:
 *   S1 — intent classification sweep: dozens of real phrasings → expected intent
 *   S2 — full multi-turn flows through the live inbound stack
 *
 * Built from observed beta-test phrasings (casual, typo-ridden, multi-fact).
 * Run: npm test
 */
process.env.LOCAL_TEST = "true";
process.env.SMS_DRY_RUN = "true";
process.env.LLM_DRY_RUN = "true";
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
// Same sender as the other suites — env is process-global, so all test files
// must agree on the authorized phone or the seed's number won't match.
const SENDER = "+15550001111";
process.env.OWNER_PHONE = SENDER;

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { heuristicParse } from "../anthropic";
import { TEST_DB_FILE } from "../testdb";
import { handleInbound } from "../inbound";
import { db } from "../supabase";

const CTX: any = { nowISO: "2026-06-18T16:00:00.000Z", timezone: "America/New_York", businessName: "Green Acres", ownerName: "Mike", lang: "en", knownClients: [] };
const first = (s: string) => heuristicParse(s, CTX).actions[0];
const intentsOf = (s: string) => heuristicParse(s, CTX).actions.map((a) => a.intent);

// ── S1: intent classification — [text, expected primary intent] ───────────────
const CASES: [string, string][] = [
  // payments — many phrasings
  ["bob paid 300", "log_payment"],
  ["bob gave me 200 cash", "log_payment"],
  ["got 300 from the smiths", "log_payment"],
  ["collected 450 from garcia", "log_payment"],
  ["the millers venmoed me 175", "log_payment"],
  ["received 500 from mrs green", "log_payment"],
  ["smiths still owe 450", "log_payment"],
  ["garcia hasnt paid the 200", "log_payment"],
  ["bob owes me 100 for the cleanup", "log_payment"],

  // jobs
  ["mowed the smiths today", "log_job"],
  ["cut the garcias lawn", "log_job"],
  ["did the johnson place", "log_job"],
  ["finished mowing at the millers", "log_job"],
  ["trimmed hedges at 5 oak", "log_job"],
  ["aerated the taylor yard yesterday", "log_job"],
  ["blew out the beds at the greens", "log_job"],

  // quotes
  ["quoted the browns 300 a month", "log_quote"],
  ["quoting mrs green at 12 elm for 180/mo", "log_quote"],
  ["gave the wilsons a price of 250 a month", "log_quote"],
  ["bid the taylor retaining wall at 4000", "log_quote"],
  ["estimate for dave 200 monthly mowing", "log_quote"],
  ["new client jim smith 250/mo full service", "log_quote"],
  ["new job the parkers weekly mowing 90 a week", "log_quote"],

  // status
  ["the browns said yes", "update_status"],
  ["millers signed", "update_status"],
  ["lost the taylor bid", "update_status"],
  ["the johnsons went with someone else", "update_status"],
  ["garcia accepted", "update_status"],

  // reminders
  ["remind me to call the dump wednesday", "set_reminder"],
  ["remind me friday to grab mulch", "set_reminder"],
  ["dont forget to invoice the smiths monday", "set_reminder"],
  ["need to order fertilizer tomorrow", "set_reminder"],
  ["ping me about the greens estimate thursday", "set_reminder"],

  // queries
  ["who owes me", "query"],
  ["how much did i make this month", "query"],
  ["hows my week looking", "query"],
  ["whats my monthly total", "query"],
  ["when do i see the smiths next", "query"],
  ["who do i still need to bill", "query"],
  ["what's on for monday", "query"],

  // expenses
  ["spent 80 on mulch", "log_expense"],
  ["gassed up the truck 65", "log_expense"],
  ["bought a new blade 45", "log_expense"],

  // schedule / lifecycle
  ["put the smiths on every other thursday", "update_status"],
  ["pause the garcias til spring", "pause_client"],
  ["skip the millers this week", "skip_visit"],
  ["move garcia to friday", "reschedule_visit"],
  ["rained out push today to tomorrow", "bulk_reschedule"],
  ["the smiths are now 350", "price_change"],

  // invoices / info
  ["invoice bob", "request_invoice"],
  ["receipt for the greens", "request_invoice"],
  ["daves number is 555 123 4567", "update_client_info"],
  ["note for the wilsons big backyard steep slope", "update_client_info"],
];

test("S1: intent classification sweep", () => {
  const misses: string[] = [];
  for (const [text, expected] of CASES) {
    const got = first(text).intent;
    if (got !== expected) misses.push(`"${text}" → ${got} (want ${expected})`);
  }
  assert.equal(misses.length, 0, `\n  ${misses.join("\n  ")}\n`);
});

// ── multi-action sweep ────────────────────────────────────────────────────────
test("S1b: multi-fact messages produce multiple actions", () => {
  const multi: [string, number][] = [
    ["quoted the browns 300/mo and remind me to follow up thursday", 2],
    ["mowed the smiths and they paid 150", 2],
    ["new client dave 200/mo and remind me to send the contract friday", 2],
    ["quoted jane 250/mo need to send it tomorrow", 2],
  ];
  const misses: string[] = [];
  for (const [text, n] of multi) {
    const got = intentsOf(text);
    if (got.length < n) misses.push(`"${text}" → ${got.join("+")} (want ${n} actions)`);
  }
  assert.equal(misses.length, 0, `\n  ${misses.join("\n  ")}\n`);
});

// ── S2: full flows through the inbound stack ──────────────────────────────────
let SID = 0;
async function reset(book: { name: string; address?: string; status?: string; amount?: number }[] = []) {
  fs.rmSync(TEST_DB_FILE, { force: true });
  const { data } = await db().from("businesses").select("*");
  const bid = (data as { id: string }[])[0].id;
  // Force the authorized phone to our sender regardless of import order.
  await db().from("authorized_phones").update({ phone: SENDER, opted_out: false }).eq("business_id", bid);
  for (const c of book) {
    await db().from("clients").insert({
      business_id: bid, name: c.name, address: c.address ?? null, status: c.status ?? "active",
      amount: c.amount ?? 100, billing_period: "monthly", service_description: "mowing",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }
  return bid;
}
async function say(body: string): Promise<string> {
  SID++;
  const out = await handleInbound({ from: SENDER, to: "+19995550000", body, messageSid: `SMsim${SID}` });
  const m = out.twiml.match(/<Message>([\s\S]*?)<\/Message>/);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}
async function getClient(nameLike: string) {
  const { data } = await db().from("clients").select("*");
  return (data as any[]).find((c) => c.name.toLowerCase().includes(nameLike.toLowerCase()));
}

test("S2: money in many forms all record a payment for the right client", async () => {
  const forms = ["Bob Vance gave me 200 cash", "got 200 from bob vance", "bob vance venmoed 200"];
  for (const f of forms) {
    await reset([{ name: "Bob Vance", address: "5 Oak St" }]);
    const reply = await say(f);
    assert.match(reply, /Recorded ✅|Bob Vance/i, `"${f}" → ${reply}`);
    const { data } = await db().from("payments").select("*");
    assert.equal((data as unknown[]).length, 1, `"${f}" should record exactly one payment`);
  }
});

test("S2: 'don't know' at any missing-info prompt never dead-ends", async () => {
  await reset([]);
  let r = await say("quoted the wilsons at 8 pine rd");
  assert.match(r, /price/i, r);
  r = await say("not sure yet");
  assert.doesNotMatch(r, /help with|didn'?t catch/i, `price skip → ${r}`);
  const wil = await getClient("Wilsons");
  assert.ok(wil, "quote saved despite no price");
});

test("S2: a correction after logging updates, not duplicates", async () => {
  await reset([]);
  await say("quoted dana at 5 oak st for 250/mo mowing");
  await say("42 maple st 555 123 4567"); // finish intake
  const r = await say("actually make dana 300");
  assert.match(r, /300|Dana/i, r);
  const { data } = await db().from("clients").select("*");
  assert.equal((data as unknown[]).length, 1, "no duplicate Dana");
});

test("S2: unknown person for a payment offers to add them, never guesses", async () => {
  await reset([{ name: "Elena Shackelford", address: "9 Pine Rd" }]);
  const r = await say("got 200 from eric mitchell");
  assert.doesNotMatch(r, /Elena/i, `must not guess Elena → ${r}`);
  assert.match(r, /eric mitchell/i, r);
});

test("S2: 'lost the X bid' removes them cleanly", async () => {
  await reset([{ name: "The Taylors", address: "1 Elm St", status: "quoted", amount: 400 }]);
  const r = await say("lost the taylor bid");
  assert.match(r, /Taylors|lost/i, r);
  const tay = await getClient("Taylors");
  assert.equal(tay!.status, "lost");
});

test("S2: reminder-only text asks for the time, then sets it", async () => {
  await reset([]);
  const ask = await say("remind me to grab mulch friday");
  assert.match(ask, /what time/i, ask);
  const r = await say("2pm");
  assert.match(r, /Reminder set ✅/i, r);
  assert.match(r, /2:00/, r);
});
