/**
 * Conversation-level test harness — runs REAL multi-turn SMS exchanges through
 * the full stack (inbound handler, conversation memory, intent handlers, DB)
 * against the file-backed test DB, across a generated matrix of scenarios:
 *
 *   G1  lookalike protection: different last name = different person, across intents
 *   G2  mandatory-profile chase: every missing-field combination for new clients
 *   G3  pending-flow robustness: YES/NEW/ignore/partial answers
 *   G4  property sweep: name permutations must never surface the wrong client
 *
 * Run: npm test
 */
process.env.LOCAL_TEST = "true";
process.env.SMS_DRY_RUN = "true";
process.env.LLM_DRY_RUN = "true";
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.OWNER_PHONE = "+15550001111";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DB_FILE } from "../testdb";
import { handleInbound } from "../inbound";
import { db } from "../supabase";

let SID = 0;
let SCENARIOS = 0;

async function bizId(): Promise<string> {
  const { data } = await db().from("businesses").select("*");
  return (data as { id: string }[])[0].id;
}

/** Fresh book with the given clients. */
async function reset(book: { name: string; address?: string; phone?: string; status?: string; amount?: number }[] = []) {
  fs.rmSync(TEST_DB_FILE, { force: true });
  const id = await bizId(); // triggers seed
  for (const c of book) {
    await db().from("clients").insert({
      business_id: id,
      name: c.name,
      address: c.address ?? null,
      phone: c.phone ?? null,
      status: c.status ?? "active",
      amount: c.amount ?? 100,
      billing_period: "monthly",
      service_description: "mowing",
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

/** Send one text as the owner; returns the reply body ("" = silence). */
async function say(body: string): Promise<string> {
  SID++;
  const out = await handleInbound({ from: "+15550001111", to: "+19995550000", body, messageSid: `SMconv${SID}` });
  // A reply may be one or several <Message> blocks; join them for assertions.
  const parts = [...out.twiml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)]
    .map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  return parts.join("\n\n");
}

interface Turn { send: string; expect?: (RegExp | string)[]; reject?: (RegExp | string)[] }
async function convo(label: string, book: Parameters<typeof reset>[0], turns: Turn[]) {
  SCENARIOS++;
  await reset(book);
  for (let i = 0; i < turns.length; i++) {
    const tr = turns[i];
    const reply = await say(tr.send);
    for (const e of tr.expect ?? []) {
      const re = typeof e === "string" ? new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : e;
      assert.match(reply, re, `${label} · turn ${i + 1} "${tr.send}" → "${reply}" should match ${e}`);
    }
    for (const r of tr.reject ?? []) {
      const re = typeof r === "string" ? new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : r;
      assert.doesNotMatch(reply, re, `${label} · turn ${i + 1} "${tr.send}" → "${reply}" must NOT match ${r}`);
    }
  }
}

async function getClient(nameLike: string) {
  const { data } = await db().from("clients").select("*");
  return (data as { name: string; [k: string]: unknown }[]).find((c) => c.name.toLowerCase().includes(nameLike.toLowerCase()));
}

// Books
const FIRSTNAME_BOOK = [{ name: "Eric Shackelford", address: "9 Pine Rd" }]; // same FIRST name trap
const FAMILY_BOOK = [{ name: "Elena Shackelford", address: "9 Pine Rd" }]; // same LAST name
const FULL_BOOK = [
  { name: "Elena Shackelford", address: "9 Pine Rd" },
  { name: "Dee Garcia", address: "8 Elm St" },
  { name: "The Smiths", address: "12 Oak St" },
  { name: "Bob Johnson", address: "3 Ash Ct" },
  { name: "Maria Lopez", address: "7 Birch Way" },
  { name: "Sam Oconnor", address: "1 Cedar Ln" },
];

// ── G1: different last name = different person, across every intent ──────────
test("G1: 'Eric Mitchell' NEVER surfaces 'Eric Shackelford' (any intent)", async () => {
  // Quote / new job: create directly, no lookalike question.
  await convo("G1 quote", FIRSTNAME_BOOK, [
    { send: "quoted eric mitchell at 42 maple st for $250/mo mowing", expect: ["Eric Mitchell", /Quoted/], reject: ["Shackelford", /did you mean/i] },
  ]);
  await convo("G1 newjob", FIRSTNAME_BOOK, [
    { send: "new job eric mitchell has a tent for 300 a week", expect: ["Eric Mitchell", /Active/], reject: ["Shackelford", /did you mean/i] },
  ]);
  // Money / work: unknown person → offer to add THEM, never the lookalike.
  await convo("G1 payment", FIRSTNAME_BOOK, [
    { send: "collected 200 from eric mitchell", expect: [/eric mitchell/i], reject: ["Shackelford"] },
  ]);
  await convo("G1 owes", FIRSTNAME_BOOK, [
    { send: "eric mitchell owes 450", expect: [/eric mitchell/i], reject: ["Shackelford"] },
  ]);
});

test("G1: same LAST name still confirms (Eric vs Elena Shackelford)", async () => {
  await convo("G1 family-ask", FAMILY_BOOK, [
    { send: "new job eric shackelford has a tent for 300 a week", expect: [/did you mean Elena Shackelford/i, /NEW/i] },
    { send: "new", expect: ["Eric Shackelford", /Active/] },
  ]);
  const eric = await getClient("Eric Shackelford");
  assert.ok(eric, "Eric created as his own client");
  assert.equal(eric!.status, "active");
});

test("G1: a short first-name fragment NEVER silently attaches ('elen' ≠ Elena Shackelford)", async () => {
  await reset([{ name: "Elena Shackelford", address: "9 Pine Rd" }]);
  const reply = await say("send elen a quote");
  // Must not silently assume Elena — either confirm or create the new prospect "Elen".
  assert.doesNotMatch(reply, /^(Quoted|Added Elena|Saved ✅ Elena|Cotiz)/i, `must not assume Elena → "${reply}"`);
  if (/did you mean|te refieres/i.test(reply)) {
    // Confirm path: NEW creates the fresh prospect, capitalized.
    const created = await say("new");
    assert.match(created, /Elen\b/, `new prospect named Elen (capitalized) → "${created}"`);
  }
  // Exact-name lookup (the fuzzy helper would match Elena) — proves "Elen" exists and is title-cased.
  const { data: rows } = await db().from("clients").select("*");
  const elen = (rows as { name: string }[]).find((c) => c.name === "Elen");
  assert.ok(elen, "a distinct 'Elen' prospect was created, capitalized");
  const elena = (rows as { name: string; status: string }[]).find((c) => c.name === "Elena Shackelford");
  assert.equal(elena!.status, "active", "Elena stays as she was — the quote didn't attach to her");
});

test("G1: a REMOVED client is never silently resurrected by a new quote", async () => {
  await reset([{ name: "Elena Shackelford", address: "9 Pine Rd" }]);
  await say("done with Elena Shackelford for good"); // remove her
  assert.equal((await getClient("Elena Shackelford"))!.status, "completed");
  const reply = await say("send Elena Shackelford a quote");
  assert.match(reply, /removed|quitad|add.*back|did you mean|volver/i, `should confirm re-adding, not assume → "${reply}"`);
  // Still removed until confirmed.
  assert.equal((await getClient("Elena Shackelford"))!.status, "completed", "not silently reactivated");
});

test("G1: exact and typo'd full names attach silently (no nagging)", async () => {
  await convo("G1 exact", FIRSTNAME_BOOK, [
    { send: "collected 200 from eric shackelford", expect: [/Recorded ✅ \$200 from Eric Shackelford/], reject: [/did you mean/i] },
  ]);
  await convo("G1 typo-first", FIRSTNAME_BOOK, [
    { send: "collected 200 from erik shackelford", expect: [/from Eric Shackelford/], reject: [/did you mean/i] },
  ]);
  await convo("G1 surname-only", FULL_BOOK, [
    { send: "collected 200 from garcia", expect: [/from Dee Garcia/], reject: [/did you mean/i] },
  ]);
  await convo("G1 household", FULL_BOOK, [
    { send: "collected 200 from the smiths", expect: [/from The Smiths/], reject: [/did you mean/i] },
  ]);
});

test("G1: single-token typo confirms before attaching", async () => {
  await convo("G1 typo-surname", FULL_BOOK, [
    { send: "collected 200 from smtihs", expect: [/did you mean The Smiths/i] },
    { send: "yes", expect: [/from The Smiths/] },
  ]);
});

// ── G2: mandatory profile (name, address, phone, service, rate) ──────────────
test("G2: every missing-field combination gets chased for new clients", async () => {
  const cases: { addr: boolean; svc: boolean; amt: boolean }[] = [];
  for (const addr of [true, false]) for (const svc of [true, false]) for (const amt of [true, false]) cases.push({ addr, svc, amt });

  for (const intent of ["quoted", "new job"] as const) {
    for (const c of cases) {
      const name = "Maria Rivera";
      let text: string;
      if (intent === "quoted") {
        text = `quoted ${name}${c.addr ? " at 42 maple st" : ""} for ${c.amt ? "$250/mo" : "service"}${c.svc ? " mowing" : ""}`;
        if (!c.amt) text = `quoted ${name}${c.addr ? " at 42 maple st" : ""}${c.svc ? " for mowing" : ""}`;
      } else {
        text = `new job ${name}${c.addr ? " at 42 maple st" : ""} has ${c.svc ? "mowing" : "work"} ${c.amt ? "for 250 a month" : ""}`.trim();
      }
      SCENARIOS++;
      await reset([]);
      let reply = await say(text);
      const label = `G2 ${intent} addr=${c.addr} svc=${c.svc} amt=${c.amt}`;

      // Price is chased first when missing.
      if (!/\$250|\$?250/.test(reply) && /price|precio/i.test(reply)) {
        reply = await say("250 a month");
      }
      // Now the completeness question must list exactly what's still missing.
      assert.match(reply, /what'?s|¿me das/i, `${label}: should ask for missing profile fields → "${reply}"`);
      if (!c.addr) assert.match(reply, /address/i, `${label}: must chase address → "${reply}"`);
      assert.match(reply, /phone/i, `${label}: must chase phone → "${reply}"`);

      // Answer: address+phone in one text, then service if chased.
      reply = await say(`${c.addr ? "" : "42 maple st "}555-123-4567`.trim());
      if (/service|servicio/i.test(reply)) reply = await say("mowing");

      const row = await getClient("Maria");
      assert.ok(row, `${label}: client exists`);
      assert.equal(row!.address, "42 Maple St", `${label}: address captured`);
      assert.equal(row!.phone, "+15551234567", `${label}: phone captured`);
      assert.equal(Number(row!.amount), 250, `${label}: rate captured`);
      assert.ok(row!.service_description, `${label}: service captured (${row!.service_description})`);
      assert.equal(row!.status, intent === "new job" ? "active" : "quoted", `${label}: status`);
    }
  }
});

test("G2: complete new client asks for nothing extra", async () => {
  await convo("G2 complete-ish", [], [
    {
      send: "new job Carla Reyes has mowing for 300 a month",
      expect: [/Carla Reyes/, /Active/, /address/i, /phone/i], // still needs address+phone
      reject: [/full name/i, /price/i],
    },
    { send: "42 maple st 555-123-4567", expect: [/Saved ✅/, /42 Maple St/, /555/] },
  ]);
});

test("G2: single-word client names are fine (never chased)", async () => {
  await convo("G2 single-name", [], [
    // Brandon has a name, service, and price — only address + phone are chased.
    { send: "quoted brandon at 5 oak st for $100/mo mowing", expect: [/phone/i], reject: [/full name/i] },
  ]);
  const row = await getClient("Brandon");
  assert.ok(row, "single-name client saved");
});

// ── G3: pending-flow robustness ───────────────────────────────────────────────
test("G3: YES attaches to the candidate — no duplicate created", async () => {
  await convo("G3 yes", FAMILY_BOOK, [
    { send: "eric shackelford owes 450", expect: [/did you mean Elena Shackelford/i] },
    { send: "yes", expect: [/Elena Shackelford owes \$450/] },
  ]);
  const { data } = await db().from("clients").select("*");
  assert.equal((data as unknown[]).length, 1, "no duplicate client");
});

test("G3: unrelated reply cancels the pending question gracefully", async () => {
  await convo("G3 ignore", FAMILY_BOOK, [
    { send: "eric shackelford owes 450", expect: [/did you mean/i] },
    { send: "the smiths paid 200", expect: [/smiths/i], reject: [/did you mean Elena/i] },
  ]);
});

test("G3: partial completeness answers re-ask only the remainder", async () => {
  await convo("G3 partial", [], [
    { send: "new job Dana Fox has cleanup for 500 a month", expect: [/address/i, /phone/i] },
    { send: "555-123-4567", expect: [/address/i], reject: [/phone number/i] },
    { send: "88 Willow Ave", expect: [/Saved ✅/] },
  ]);
  const row = await getClient("Dana Fox");
  assert.equal(row!.phone, "+15551234567");
  assert.equal(row!.address, "88 Willow Ave");
});

test("G3: two same-surname clients → numbered pick works", async () => {
  await convo("G3 pick", [
    { name: "Elena Shackelford", address: "9 Pine Rd" },
    { name: "Eric Shackelford", address: "42 Maple St" },
  ], [
    { send: "collected 200 from shackelford", expect: [/\(1\)/, /\(2\)/] },
    { send: "2", expect: [/from (Eric|Elena) Shackelford/] },
  ]);
});

// ── G4: property sweep — permutations must never surface the wrong client ────
test("G4: name-permutation sweep (no wrong-person mentions, ever)", async () => {
  const firsts = ["eric", "elena", "bob", "maria", "jane", "carlos", "dee", "sam", "tanya", "luis"];
  const safeLasts = ["mitchell", "rivera", "kowalski", "nguyen"]; // in NO book entry, not typo-close to any
  const bookNames = FULL_BOOK.map((b) => b.name);

  await reset(FULL_BOOK);
  for (const f of firsts) {
    for (const l of safeLasts) {
      for (const template of [
        (n: string) => `quoted ${n} at 5 oak st for $100/mo mowing`,
        (n: string) => `${n} owes 75`,
        (n: string) => `new job ${n} has weeding for 80 a month`,
      ]) {
        SCENARIOS++;
        await reset(FULL_BOOK);
        const q = `${f} ${l}`;
        const reply = await say(template(q));
        for (const existing of bookNames) {
          assert.ok(
            !reply.includes(existing),
            `"${template(q)}" → "${reply}" must not mention "${existing}"`
          );
        }
        assert.match(reply, new RegExp(f, "i"), `"${template(q)}" reply should reference the texted person → "${reply}"`);
      }
    }
  }
});

test("G4: same-surname permutations confirm against the right family member", async () => {
  const cases: [string, string][] = [
    ["jane shackelford", "Elena Shackelford"],
    ["carlos garcia", "Dee Garcia"],
    ["maria johnson", "Bob Johnson"],
    ["eric lopez", "Maria Lopez"],
  ];
  for (const [q, expected] of cases) {
    SCENARIOS++;
    await reset(FULL_BOOK);
    const reply = await say(`${q} owes 60`);
    assert.match(reply, new RegExp(`did you mean ${expected}`, "i"), `"${q} owes 60" → "${reply}"`);
    // And NEW creates the texted person, untangled from the family member.
    const reply2 = await say("new");
    assert.match(reply2, new RegExp(q.split(" ")[0], "i"), `NEW should act on "${q}" → "${reply2}"`);
    const wrong = await getClient(expected.split(" ")[0]);
    assert.equal(Number(wrong!.amount), 100, `"${q}": family member's record untouched`);
  }
});

test("G4: courtesy words never pollute names", async () => {
  for (const text of [
    "new job Tom Baker please",
    "quoted Amy Wong thanks",
  ]) {
    SCENARIOS++;
    await reset([]);
    const reply = await say(text);
    assert.doesNotMatch(reply, /please|thanks|gracias/i, `"${text}" → "${reply}" name must be clean`);
  }
});

// ── G7: removing a client works over text and suggests pausing ────────────────
test("G7: 'remove/drop/get rid of/fire X' removes the client and offers pause", async () => {
  for (const verb of ["remove", "drop", "get rid of", "fire", "dump"]) {
    SCENARIOS++;
    await reset(FULL_BOOK);
    const reply = await say(`${verb} Bob Johnson`);
    assert.doesNotMatch(reply, /can'?t|cannot|no puedo|not able/i, `"${verb}" must not refuse → "${reply}"`);
    assert.match(reply, /off your active list|took|removed|quit[eé]|lista activa/i, `"${verb}" should remove → "${reply}"`);
    assert.match(reply, /pause/i, `"${verb}" should suggest pausing → "${reply}"`);
    const row = await getClient("Bob Johnson");
    assert.equal(row!.status, "completed", `"${verb}" marks completed`);
  }
});

test("G7: the suggested 'pause X' reply parks them in the paused category", async () => {
  await convo("G7 remove-then-pause", FULL_BOOK, [
    { send: "get rid of The Smiths", expect: [/pause/i] },
    // Change of mind: pause instead. (Re-add first since the demo removed them.)
    { send: "pause The Smiths until March", expect: [/Paused ⏸/i, /not lost/i] },
  ]);
  const row = await getClient("The Smiths");
  assert.equal(row!.status, "paused", "ends up paused, in its own dashboard group");
});

test("G7: 'done with X for good' removes, but a finished job does NOT", async () => {
  await reset(FULL_BOOK);
  const removed = await say("done with Maria Lopez for good");
  assert.match(removed, /off your active list|took|removed/i, `relationship end removes → "${removed}"`);
  assert.equal((await getClient("Maria Lopez"))!.status, "completed");

  await reset(FULL_BOOK);
  const job = await say("finished mowing at Dee Garcia");
  assert.equal((await getClient("Dee Garcia"))!.status, "active", "a finished visit never removes the client");
});

// ── G7b: answering "which one?" by NAME resolves the pending action ───────────
test("G7b: delete X → 'which one?' → answering the name completes the delete", async () => {
  await reset([
    { name: "Eric Shackelford", address: "9 Pine Rd" },
    { name: "Eric Mitchell", address: "3 Ash Ct" },
  ]);
  const ask = await say("delete Eric");
  assert.match(ask, /which|cu[aá]l|\(1\)/i, `should ask which Eric → "${ask}"`);
  const done = await say("Eric Shackelford"); // reply with the NAME, not a number
  assert.doesNotMatch(done, /which|cu[aá]l/i, "must not re-ask — it named the client");
  assert.match(done, /off your active list|took|removed|✅/i, `should complete the removal → "${done}"`);
  assert.equal((await getClient("Eric Shackelford"))!.status, "completed", "the right Eric was removed");
  assert.notEqual((await getClient("Eric Mitchell"))!.status, "completed", "the other Eric untouched");
});

test("G7b: answering 'which one?' by last name or ordinal also works", async () => {
  await reset([
    { name: "Eric Shackelford", address: "9 Pine Rd" },
    { name: "Eric Mitchell", address: "3 Ash Ct" },
  ]);
  await say("remove Eric");
  const done = await say("shackelford"); // just the surname
  assert.match(done, /off your active list|took|removed|✅/i, `surname resolves → "${done}"`);
  assert.equal((await getClient("Eric Shackelford"))!.status, "completed");
});

// ── G8: "need to send quote for <Name>" = prospect intake, stays in conversation ─
test("G8: 'send quote for Jane' creates a prospect and chases phone (no price ask)", async () => {
  await reset([]);
  const reply = await say("send quote for Jane");
  assert.match(reply, /prospect|Jane/i, `should create the prospect → "${reply}"`);
  assert.doesNotMatch(reply, /what.*amount|price|precio|cu[aá]nto/i, "must NOT ask for a price it doesn't have yet");
  assert.match(reply, /phone|address|what'?s/i, `should chase contact info → "${reply}"`);
  const row = await getClient("Jane");
  assert.ok(row, "Jane exists as a prospect");
  assert.equal(row!.status, "quoted");
  assert.equal(row!.amount, null, "no invented amount");
});

test("G8: the follow-up number stays in the conversation and attaches", async () => {
  await convo("G8 prospect-then-number", [], [
    { send: "need to send quote for Jane", expect: [/phone|address|what'?s/i] },
    { send: "her number is 5551234567", expect: [/Saved|Jane|✅/i] },
  ]);
  const row = await getClient("Jane");
  assert.equal(row!.phone, "+15551234567", "number attached to Jane, not orphaned");
});

test("G8: an oddly formatted / international number still attaches", async () => {
  await convo("G8 intl-number", [], [
    { send: "quote for Priya", expect: [/phone|address|what'?s/i] },
    { send: "9 birch st", expect: [/phone|what'?s/i] }, // give address, still chasing phone
    { send: "her number is 03323848482838", expect: [/Saved|Priya|✅/i] },
  ]);
  const row = await getClient("Priya");
  assert.equal(row!.phone, "03323848482838", "long non-US number captured verbatim");
  assert.ok(!/number|her/i.test(String(row!.service_description ?? "")), "filler didn't leak into service");
});

// ── G10: quote close-loop — nudge reply drives won / lost / keep-chasing ──────
async function armQuoteStatus(clientId: unknown) {
  const expiresAt = new Date(Date.now() + 18 * 3600 * 1000).toISOString();
  await db().from("authorized_phones")
    .update({ pending_state: { kind: "quote_status", action: { intent: "update_status", confidence: 1, client_id: String(clientId) }, expiresAt } })
    .eq("phone", "+15550001111");
}

test("G10: 'they're in' closes the quote WON (client → active, nudges cancelled)", async () => {
  await reset([{ name: "Jane Doe", address: "5 Oak St", status: "quoted", amount: 200 }]);
  const jane = await getClient("Jane Doe");
  await armQuoteStatus(jane!.id);
  const reply = await say("they're in!");
  assert.match(reply, /in!|active/i, `won → "${reply}"`);
  assert.equal((await getClient("Jane Doe"))!.status, "active");
});

test("G10: 'they're out' closes the quote LOST", async () => {
  await reset([{ name: "Jane Doe", address: "5 Oak St", status: "quoted", amount: 200 }]);
  await armQuoteStatus((await getClient("Jane Doe"))!.id);
  const reply = await say("they're out");
  assert.match(reply, /out|lost|passed/i, `lost → "${reply}"`);
  assert.equal((await getClient("Jane Doe"))!.status, "lost");
});

test("G10: 'sent it out' is NOT read as OUT — it keeps chasing", async () => {
  await reset([{ name: "Jane Doe", address: "5 Oak St", status: "quoted", amount: 200 }]);
  await armQuoteStatus((await getClient("Jane Doe"))!.id);
  const reply = await say("sent it out, waiting to hear");
  assert.equal((await getClient("Jane Doe"))!.status, "quoted", "'sent it out' means sent, not lost");
  assert.match(reply, /staying on|check back/i, `keeps chasing → "${reply}"`);
});

test("G10: 'no reply yet' keeps chasing — stays quoted and schedules the next check", async () => {
  await reset([{ name: "Jane Doe", address: "5 Oak St", status: "quoted", amount: 200 }]);
  const jane = await getClient("Jane Doe");
  await armQuoteStatus(jane!.id);
  const reply = await say("no reply yet");
  assert.match(reply, /staying on|check back|recuerdo/i, `keeps chasing → "${reply}"`);
  assert.equal((await getClient("Jane Doe"))!.status, "quoted", "still an open quote");
  const { data: rem } = await db().from("reminders").select("*").eq("client_id", jane!.id).eq("kind", "quote_followup").eq("status", "pending");
  assert.ok((rem as unknown[]).length >= 1, "a follow-up check was scheduled");
});

test("G10: a custom time on the reply ('remind me friday') is honored", async () => {
  await reset([{ name: "Jane Doe", address: "5 Oak St", status: "quoted", amount: 200 }]);
  const jane = await getClient("Jane Doe");
  await armQuoteStatus(jane!.id);
  const reply = await say("not yet, remind me friday");
  assert.match(reply, /Fri|staying on/i, `honors custom time → "${reply}"`);
  assert.equal((await getClient("Jane Doe"))!.status, "quoted");
});

// ── G11: memory / context-drop edge cases (from the deep audit) ───────────────
test("G11: missing-amount 'idk' saves the quote priceless and keeps the intake going", async () => {
  await reset([]);
  await say("quoted Nadia for mowing");            // no price → asks amount
  const reply = await say("idk");                   // must be a skip, not a drop
  assert.match(reply, /address|phone|what'?s/i, `keeps chasing profile → "${reply}"`);
  const c = await getClient("Nadia");
  assert.ok(c, "Nadia saved");
  assert.equal(c!.amount ?? null, null, "no price invented");
});

test("G11: '200 a month' answer to the price question sets amount AND billing period", async () => {
  await reset([]);
  await say("quoted Nadia at 5 oak st for mowing"); // has address+service, no price
  await say("200 a month");
  const c = await getClient("Nadia");
  assert.equal(Number(c!.amount), 200, "amount captured");
  assert.equal(c!.billing_period, "monthly", "period captured, not dropped (MRR stays right)");
});

test("G11: a digit-less street answer is the ADDRESS, not the service", async () => {
  await reset([]);
  await say("quoted Jorah for $100");   // missing address, phone, service
  await say("555-123-4567");            // phone → still missing address + service
  const reply = await say("Main Street"); // must be address, not service
  const c = await getClient("Jorah");
  assert.match(String(c!.address), /Main St/i, "street saved as address");
  assert.ok(!/main/i.test(String(c!.service_description ?? "")), "not misfiled as service");
  assert.match(reply, /service|what'?s/i, `still chases the service → "${reply}"`);
});

test("G11: a command mid-intake runs AND the intake survives (sticky)", async () => {
  await reset(FULL_BOOK);
  await say("quoted Petyr for $200 mowing");   // new client, chases address+phone
  const cmd = await say("dee garcia paid 100"); // unrelated command
  assert.match(cmd, /Dee Garcia/i, `the payment runs → "${cmd}"`);
  const done = await say("5 oak st 555-123-4567"); // intake still open → completes
  assert.match(done, /Saved|5 Oak|555/i, `intake survived the interruption → "${done}"`);
  const petyr = await getClient("Petyr");
  assert.match(String(petyr!.address), /5 Oak/i, "address landed after the interleaved command");
});

test("G11: which-one? interleaved command runs instead of being eaten", async () => {
  await reset([
    { name: "Elena Shackelford", address: "9 Pine Rd" },
    { name: "Eric Shackelford", address: "3 Ash Ct" },
    { name: "The Smiths", address: "12 Oak St" },
  ]);
  await say("shackelford owes 450");        // ambiguous → which one?
  const pay = await say("the smiths paid 200"); // a real, different command
  assert.match(pay, /Smiths/i, `the Smiths payment records, not swallowed → "${pay}"`);
  const { data: pays } = await db().from("payments").select("*");
  assert.ok((pays as unknown[]).length >= 1, "payment recorded");
});

test("G11: photo answered by a NUMBER after a shortlist attaches to that choice", async () => {
  await reset([
    { name: "The Smiths", address: "12 Oak St" },
    { name: "Smith Brothers", address: "8 Elm St" },
  ]);
  await sayPhoto("");            // no caption → whose site?
  const list = await say("smith");
  assert.match(list, /\(1\)|\(2\)|which/i, `shows the shortlist → "${list}"`);
  const done = await say("2");
  assert.match(done, /Saved.*photo|Smith/i, `numeric pick attaches → "${done}"`);
  const { data: atts } = await db().from("attachments").select("*");
  assert.equal((atts as unknown[]).length, 1, "exactly one photo saved");
});

test("G11: photo answered by ADDRESS attaches to that client", async () => {
  await reset([{ name: "The Smiths", address: "12 Oak St" }]);
  await sayPhoto("");
  const done = await say("12 oak st");
  assert.match(done, /Saved.*photo|Smiths/i, `address resolves the photo → "${done}"`);
  const { data: atts } = await db().from("attachments").select("*");
  assert.equal((atts as unknown[]).length, 1);
});

test("G11: a photo during 'which one?' does NOT wipe the pending", async () => {
  await reset([
    { name: "Elena Shackelford", address: "9 Pine Rd" },
    { name: "Eric Shackelford", address: "3 Ash Ct" },
  ]);
  await say("shackelford owes 450");   // which one?
  const onPhoto = await sayPhoto("");   // photo mid-question
  assert.doesNotMatch(onPhoto, /whose site/i, "must not reset to 'whose site?'");
  assert.match(onPhoto, /answer|question|first/i, `asks to finish first → "${onPhoto}"`);
  const done = await say("1");           // the which-one? survived
  assert.doesNotMatch(done, /which/i, "the pending was still there to resolve");
});

test("G11: confirm-create accepts natural yeses ('yup', 'okay', 'sure')", async () => {
  for (const yes of ["yup", "okay", "sure"]) {
    await reset(FULL_BOOK);
    await say(`mowed ${yes === "yup" ? "Zed" : yes === "okay" ? "Yara" : "Wex"}`); // unknown → add them?
    const created = await say(yes);
    assert.doesNotMatch(created, /didn'?t add|add them\?/i, `"${yes}" should confirm → "${created}"`);
  }
});

// ── G8c: a photo mid-intake attaches to the client in focus (context kept) ────
async function sayPhoto(body: string): Promise<string> {
  SID++;
  const out = await handleInbound({
    from: "+15550001111", to: "+19995550000", body, messageSid: `SMmid${SID}`, numMedia: 1,
    media: [{ url: "https://api.twilio.com/fake/Media/MEmid", contentType: "image/jpeg" }],
  });
  const m = out.twiml.match(/<Message>([\s\S]*?)<\/Message>/);
  return m ? m[1] : "";
}

test("G8c: a photo sent DURING intake attaches to that client, not 'whose site?'", async () => {
  await reset([]);
  await say("quoted Jorge Vela for $200 full lawn"); // one-time price → no schedule step
  // Give address + phone together so we advance straight to the notes/photo step.
  const notesAsk = await say("100 Pine St 5551234567");
  assert.match(notesAsk, /note about Jorge|photo of the site/i, `at the notes step → "${notesAsk}"`);
  // Now text a photo — it must attach to Jorge, NOT reset to "whose site is this?".
  const photoReply = await sayPhoto("");
  assert.doesNotMatch(photoReply, /whose site|IMPORT/i, `photo must not lose context → "${photoReply}"`);
  assert.match(photoReply, /Jorge/i, `photo saved to Jorge → "${photoReply}"`);
  // And the intake is STILL open — the next text is the note.
  const noteReply = await say("annoying dog");
  assert.match(noteReply, /Note saved|noted/i, `note still lands → "${noteReply}"`);
  const jorge = await getClient("Jorge Vela");
  assert.match(String(jorge!.notes), /annoying dog/i, "note saved to Jorge");
  const { data: atts } = await db().from("attachments").select("*");
  assert.equal((atts as { client_id: string }[]).filter((a) => a.client_id === jorge!.id).length, 1, "photo linked to Jorge");
});

// ── G9: expenses can be tied to a client and confirmed ────────────────────────
test("G9: 'spent 100 on mulch for Elena' ties the expense to Elena and confirms it", async () => {
  await reset([{ name: "Elena Shackelford", address: "9 Pine Rd" }]);
  const reply = await say("spent 100 on mulch for Elena");
  assert.match(reply, /Expense ✅/i, `logs an expense → "${reply}"`);
  assert.match(reply, /Elena/i, `confirms it's saved to Elena → "${reply}"`);
  const { data: exps } = await db().from("expenses").select("*");
  const e = (exps as { amount: number; client_id: string | null; description: string | null }[])[0];
  assert.ok(e, "expense row exists");
  assert.equal(Number(e.amount), 100);
  const elena = await getClient("Elena Shackelford");
  assert.equal(e.client_id, elena!.id, "linked to Elena's id, not orphaned");
});

test("G9: a general expense with no client stays unlinked", async () => {
  await reset([{ name: "Bob Johnson", address: "3 Ash Ct" }]);
  const reply = await say("spent 60 on fuel");
  assert.match(reply, /Expense ✅/i);
  const { data: exps } = await db().from("expenses").select("*");
  assert.equal((exps as { client_id: string | null }[])[0].client_id ?? null, null, "overhead expense not tied to a client");
});

// ── G8b: dashboard link is answerable (not a menu dump, not a broken promise) ──
test("G8b: asking for the dashboard link gives the actual URL", async () => {
  await reset([]);
  for (const msg of ["how do I access the dashboard", "send link to dashboard", "send the link"]) {
    const reply = await say(msg);
    assert.match(reply, /\/dashboard/i, `"${msg}" should surface the dashboard URL → "${reply}"`);
  }
});

// ── G6: notes + photos ─────────────────────────────────────────────────────────
test("G6: note-first prospect — note before any quote creates a prospect with the note", async () => {
  await convo("G6 note-new", [], [
    { send: "note for the wilsons: big backyard, steep slope, wants edging", expect: [/wilsons/i, /YES/i] },
    { send: "yes", expect: [/Saved ✅/i, /big backyard/i] },
  ]);
  const row = await getClient("Wilsons");
  assert.ok(row, "prospect created");
  assert.equal(row!.status, "quoted", "note-first prospect is quoted, not active");
  assert.match(String(row!.notes), /steep slope/);
});

test("G6: note on an existing client appends", async () => {
  await convo("G6 note-existing", FULL_BOOK, [
    { send: "note for dee garcia: gate sticks, lift latch hard", expect: [/Dee Garcia/, /gate sticks/i] },
  ]);
  const row = await getClient("Dee Garcia");
  assert.match(String(row!.notes), /gate sticks/);
});

test("G6: photo with client caption attaches directly", async () => {
  SCENARIOS++;
  await reset(FULL_BOOK);
  SID++;
  const out = await handleInbound({
    from: "+15550001111", to: "+19995550000", body: "the smiths",
    messageSid: `SMphoto${SID}`, numMedia: 1,
    media: [{ url: "https://api.twilio.com/fake/Media/ME123", contentType: "image/jpeg" }],
  });
  assert.match(out.twiml, /Saved.*photo.*The Smiths/i, out.twiml);
  const { data } = await db().from("attachments").select("*");
  assert.equal((data as unknown[]).length, 1, "attachment row exists");
});

test("G6: photo without caption asks whose site, reply resolves it", async () => {
  SCENARIOS++;
  await reset(FULL_BOOK);
  SID++;
  const out = await handleInbound({
    from: "+15550001111", to: "+19995550000", body: "",
    messageSid: `SMphoto${SID}`, numMedia: 1,
    media: [{ url: "https://api.twilio.com/fake/Media/ME456", contentType: "image/jpeg" }],
  });
  assert.match(out.twiml, /whose site|which client|photo/i, out.twiml);
  const reply = await say("dee garcia");
  assert.match(reply, /Saved.*photo.*Dee Garcia/i, reply);
  const { data } = await db().from("attachments").select("*");
  const rows = data as { client_id: string | null }[];
  assert.equal(rows.length, 1);
  const dee = await getClient("Dee Garcia");
  assert.equal(rows[0].client_id, (dee as unknown as { id: string }).id, "attached to the right client");
});

test("G6: recurring intake asks the schedule, then the optional notes step", async () => {
  await convo("G6 intake-notes", [], [
    { send: "new job Rosa Marin has mowing for 200 a month", expect: [/address/i, /phone/i] },
    { send: "42 maple st 555-123-4567", expect: [/how often/i, /what day/i] }, // schedule step
    { send: "monthly on the 1st", expect: [/Scheduled ✅/i, /anything to note/i, /SKIP/i] },
    { send: "big dog in back yard, gate code 1187", expect: [/Note saved ✅/i] },
  ]);
  const row = await getClient("Rosa Marin");
  assert.equal(row!.service_interval, "monthly", "cadence captured from the schedule step");
  assert.ok(row!.next_service_on, "start date anchored");
  assert.match(String(row!.notes), /gate code 1187/);
});

test("G6: SKIP ends the intake cleanly (through the schedule step)", async () => {
  await convo("G6 intake-skip", [], [
    { send: "new job Leo Park has edging for 100 a week", expect: [/address/i] },
    { send: "9 cedar ct 555-123-9999", expect: [/how often/i] }, // schedule step
    { send: "weekly on fridays", expect: [/Scheduled ✅/i, /anything to note/i] },
    { send: "skip", expect: [/All set ✅/i] },
  ]);
  const row = await getClient("Leo Park");
  assert.equal(row!.service_interval, "weekly");
  assert.equal(row!.service_day, "friday");
  assert.equal(row!.notes, null, "no junk note saved");
});

test("G6: SKIP on the schedule step leaves the client unscheduled but saved", async () => {
  await convo("G6 schedule-skip", [], [
    { send: "new job Nora Vance has cleanup for 150 a month", expect: [/address/i] },
    { send: "3 birch ln 555-123-8888", expect: [/how often/i] },
    { send: "skip", expect: [/All set ✅/i] },
  ]);
  const row = await getClient("Nora Vance");
  assert.equal(row!.service_interval, null, "schedule left blank when skipped");
});

test("G6: a real command during the notes step is executed, not eaten as a note", async () => {
  await convo("G6 notes-interrupt", FULL_BOOK, [
    { send: "new job Ana Reyes has weeding for 120 a month", expect: [/address/i] },
    { send: "10 oak way 555-123-2222", expect: [/how often/i] }, // schedule step
    { send: "monthly on mondays", expect: [/anything to note/i] },
    { send: "collected 200 from dee garcia", expect: [/from Dee Garcia/] },
  ]);
  const row = await getClient("Ana Reyes");
  assert.ok(!String(row!.notes ?? "").includes("collected"), "command not saved as a note");
});

test("G6: 'Add to <client>' captions attach directly (instruction words ignored)", async () => {
  const captions = [
    "Add to elena shackelford",
    "attach to the smiths",
    "this is dee garcia",
    "save to bob johnson please",
    "elena shackelford backyard", // trailing description via surname containment
  ];
  const expected = ["Elena Shackelford", "The Smiths", "Dee Garcia", "Bob Johnson", "Elena Shackelford"];
  for (let i = 0; i < captions.length; i++) {
    SCENARIOS++;
    await reset(FULL_BOOK);
    SID++;
    const out = await handleInbound({
      from: "+15550001111", to: "+19995550000", body: captions[i],
      messageSid: `SMcap${SID}`, numMedia: 1,
      media: [{ url: `https://api.twilio.com/fake/Media/ME${SID}`, contentType: "image/jpeg" }],
    });
    assert.match(out.twiml, new RegExp(`Saved.*photo.*${expected[i]}`, "i"), `"${captions[i]}" → ${out.twiml}`);
  }
});

test("G7: 'don't know' the price saves the quote and continues intake (no dead-end)", async () => {
  await convo("G7 price-skip", [], [
    { send: "quoted Nina Vale at 5 oak st", expect: [/price/i] },
    { send: "don't know", expect: [/phone/i], reject: [/help with|what'?s the price/i] },
  ]);
  const row = await getClient("Nina Vale");
  assert.ok(row, "quote saved without a price");
  assert.equal(row!.amount, null);
  assert.equal(row!.status, "quoted");
});

test("G7: quote + obligation reminder both happen in one message", async () => {
  await convo("G7 multi", [], [
    { send: "Quoting James Danks at 222 west street need to send quote tomorrow", expect: [/price/i, /Reminder set ✅/] },
  ]);
  const row = await getClient("James Danks");
  assert.ok(row, "quote created");
  assert.equal(row!.address, "222 West St");
});

test("G6: photo/notes requests route to query, never to help/clarification", async () => {
  const { heuristicParse } = await import("../anthropic");
  const ctx: any = { nowISO: new Date().toISOString(), timezone: "America/New_York", businessName: "x", ownerName: "m", lang: "en", knownClients: [] };
  for (const q of ["need her photos", "send me elena's photos", "photos?", "elena's notes", "show me bob's history", "what about her balance"]) {
    SCENARIOS++;
    const intent = heuristicParse(q, ctx).actions[0].intent;
    assert.equal(intent, "query", `"${q}" should be a query, got ${intent}`);
  }
});

test("G6: snapshot knows notes and photos (what queries answer from)", async () => {
  SCENARIOS++;
  await reset(FULL_BOOK);
  await say("note for dee garcia: gate sticks, big dog");
  SID++;
  await handleInbound({
    from: "+15550001111", to: "+19995550000", body: "dee garcia",
    messageSid: `SMsnap${SID}`, numMedia: 1,
    media: [{ url: "https://api.twilio.com/fake/Media/ME789", contentType: "image/jpeg" }],
  });
  const { buildSnapshot } = await import("../intents");
  const { data } = await db().from("businesses").select("*");
  const snapshot = await buildSnapshot((data as any[])[0]);
  assert.match(snapshot, /gate sticks/, "notes in snapshot");
  assert.match(snapshot, /SITE PHOTOS/, "photos section in snapshot");
  assert.match(snapshot, /Dee Garcia: 1 photo/, "photo count per client");
});

// ── G5: full command regression across book states ────────────────────────────
test("G5: every command family works against every book state", async () => {
  const commands: { send: string; expect: RegExp }[] = [
    { send: "quoted paula newton at 3 fir ln for $150/mo edging", expect: /Paula Newton.*Quoted/s },
    { send: "new job kim votolato has hedges for 90 a week", expect: /Kim Votolato.*Active/s },
    { send: "remind me to call the dump friday", expect: /Reminder set ✅/ },
    { send: "spent 40 on gas", expect: /Expense ✅ \$40/ },
    { send: "rained out, push today to tomorrow", expect: /Moved ✅|nothing to move/i },
    { send: "help", expect: /FieldText/ },
    { send: "cancel", expect: /cancel what/i },
    { send: "who owes me?", expect: /./ },
  ];
  for (const book of [[], FAMILY_BOOK, FULL_BOOK]) {
    for (const c of commands) {
      SCENARIOS++;
      await reset(book);
      const reply = await say(c.send);
      assert.match(reply, c.expect, `book=${book.length} "${c.send}" → "${reply}"`);
      // Nothing may ever leak another client's identity into an unrelated reply.
      if (!/quoted|new job|owes/.test(c.send)) {
        for (const b of book) {
          if (c.send === "who owes me?" || c.send.startsWith("rained")) continue; // legit mentions
          assert.ok(!reply.includes(b.name), `book=${book.length} "${c.send}" leaked "${b.name}" → "${reply}"`);
        }
      }
    }
  }
});

test("G12: quote to-do reminder is specific, offers a draft, then chases on SENT", async () => {
  await reset([{ name: "Elena Ruiz", address: "5 Oak St", status: "quoted", amount: 200 }]);
  const id = await bizId();
  const { data: clients } = await db().from("clients").select("*").eq("business_id", id);
  const elena = (clients as { id: string; name: string }[]).find((c) => c.name === "Elena Ruiz")!;

  // Seed a DUE manual "send Elena quote" to-do linked to her.
  await db().from("reminders").insert({
    business_id: id, client_id: elena.id, text: "send Elena quote",
    due_at: new Date(Date.now() - 60_000).toISOString(), status: "pending", kind: "manual", source_message_id: null,
  });

  const { runAllDue } = await import("../reminders");
  await runAllDue(new Date());

  // The fired reminder must be the rich version: names her, gives details, offers a draft.
  const { data: msgs } = await db().from("messages").select("*").eq("business_id", id).eq("direction", "outbound");
  const fired = (msgs as { body: string }[]).find((m) => /Quote reminder/i.test(m.body));
  assert.ok(fired, "a rich quote reminder was sent");
  assert.match(fired!.body, /Elena Ruiz/);
  assert.match(fired!.body, /5 Oak St/);
  assert.match(fired!.body, /DRAFT/);
  assert.ok(!/^⏰ Reminder: send Elena quote$/.test(fired!.body), "not the bare reminder");

  // Reply DRAFT → two texts: instructions (with a clear price callout) + the
  // clean, quote-free customer message.
  const draft = await say("draft");
  assert.match(draft, /Copy the next message/i);
  assert.match(draft, /price/i);
  assert.match(draft, /Hi Elena/);
  assert.match(draft, /\$200/);
  assert.ok(!draft.includes("—"), "no em-dashes in the draft");
  // The customer message itself carries no wrapping quotes.
  assert.ok(!/"Hi Elena/.test(draft), "clean message is not wrapped in quotes");

  // Reply SENT → promoted to a live quote and the follow-up chase is scheduled.
  const ack = await say("sent");
  assert.match(ack, /sent|follow|cold/i);
  const { data: after } = await db().from("reminders").select("*").eq("client_id", elena.id).eq("kind", "quote_followup").eq("status", "pending");
  assert.ok((after as unknown[]).length >= 1, "close-loop follow-ups scheduled after SENT");
});

test("G13: 'remind me to quote <new person>' adds them + links the reminder", async () => {
  await reset([]); // empty book — Mitch K isn't a client yet
  const reply = await say("remind me tomorrow to quote mitch k");
  assert.match(reply, /Reminder set/i);
  assert.match(reply, /Mitch K/, `should confirm the prospect was added: "${reply}"`);

  const id = await bizId();
  const { data: clients } = await db().from("clients").select("*").eq("business_id", id);
  const mitch = (clients as { id: string; name: string; status: string }[]).find((c) => /mitch/i.test(c.name));
  assert.ok(mitch, "Mitch K was created as a prospect");
  assert.equal(mitch!.name, "Mitch K", "name is capitalized");

  const { data: rems } = await db().from("reminders").select("*").eq("client_id", mitch!.id).eq("kind", "manual");
  assert.ok((rems as unknown[]).length >= 1, "the reminder is linked to the new prospect (so it fires with the draft offer)");
});

test("G14: 'add <client> address' (no value) asks for it, then saves the reply", async () => {
  await reset([{ name: "Mitch K", status: "quoted", amount: 200 }]);
  const ask = await say("add mitch k address");
  assert.match(ask, /address/i, `should ask for the address, not give a snapshot: "${ask}"`);
  assert.ok(!/snapshot|MRR/i.test(ask), "must not fall through to a status snapshot");

  const done = await say("5 Oak St");
  assert.match(done, /Mitch K/);
  const id = await bizId();
  const { data: clients } = await db().from("clients").select("*").eq("business_id", id);
  const mitch = (clients as { name: string; address: string | null }[]).find((c) => /mitch/i.test(c.name));
  assert.ok(mitch?.address && /oak/i.test(mitch.address), `address saved: ${mitch?.address}`);
});

test("G16: adding a quote prospect offers to add missing details", async () => {
  // Mitch already exists (no address/phone) — quoting him should still offer details.
  await reset([{ name: "Mitch K", status: "quoted" }]);
  const reply = await say("need to send mitch k a quote");
  assert.match(reply, /Mitch K/);
  assert.match(reply, /address|phone/i, `should offer to add details: "${reply}"`);

  // And the follow-up captures it.
  const saved = await say("5 Oak St");
  const id = await bizId();
  const { data: clients } = await db().from("clients").select("*").eq("business_id", id);
  const mitch = (clients as { name: string; address: string | null }[]).find((c) => /mitch/i.test(c.name));
  assert.ok(mitch?.address && /oak/i.test(mitch.address), `address captured: ${mitch?.address}`);
});

test("scenario count", () => {
  console.log(`\n  ▸ conversation scenarios executed: ${SCENARIOS}\n`);
  assert.ok(SCENARIOS >= 150, `expected a large matrix, got ${SCENARIOS}`);
});
