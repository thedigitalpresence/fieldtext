/**
 * Self-service onboarding: double opt-in (web consent + mobile-originated text)
 * creates an isolated, correctly-localized book. Guards the consent + isolation.
 */
process.env.LOCAL_TEST = "true";
process.env.SMS_DRY_RUN = "true";
process.env.LLM_DRY_RUN = "true";
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.DASHBOARD_PASSWORD = "master";
process.env.OWNER_PHONE = "+15550009999";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DB_FILE } from "../testdb";
import { handleInbound } from "../inbound";
import { db } from "../supabase";

async function fresh() {
  fs.rmSync(TEST_DB_FILE, { force: true });
  await db().from("businesses").select("*"); // trigger seed
}
async function pendingSignup(phone: string, lang: string, name = "Miguel Torres", biz = "Torres Lawn Care", password = "secret123", activationCode?: string) {
  const { hashPassword } = await import("../password");
  await db().from("signups").insert({
    name, business_name: biz, phone, language: lang, status: "pending", dashboard_password: hashPassword(password),
    activation_code: activationCode ? hashPassword(activationCode) : null,
    consent_text: "I agree to receive SMS…", consented_at: new Date().toISOString(), ip: "1.2.3.4",
  });
}
async function say(from: string, body: string) {
  const out = await handleInbound({ from, to: "+19714625343", body, messageSid: `SMob${Math.abs(hash(from + body))}` });
  return out;
}
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

test("unknown number with NO signup is ignored", async () => {
  await fresh();
  const out = await say("+19990001111", "hola");
  assert.equal(out.authorized, false);
});

test("consented signup self-activates on first text (double opt-in), Spanish", async () => {
  await fresh();
  await pendingSignup("+15553330001", "es");
  const out = await say("+15553330001", "coticé a García en 9 pine por 150/mes");
  assert.equal(out.authorized, true);
  const reply = out.twiml.match(/<Message>([\s\S]*?)<\/Message>/)?.[1] ?? "";
  assert.match(reply, /Bienvenido/i, "Spanish welcome");

  const { data: biz } = await db().from("businesses").select("*").eq("slug", "torres-lawn-care").single();
  assert.equal((biz as any).settings.language, "es", "book is Spanish");
  const { data: signup } = await db().from("signups").select("*").eq("phone", "+15553330001").single();
  assert.equal((signup as any).status, "activated");
  assert.ok((signup as any).activated_at, "activation timestamped (consent audit trail)");
  assert.equal((signup as any).business_id, (biz as any).id, "signup linked to its business");
  // The chosen password carried onto the business (hashed), so phone + password sign-in works.
  const { verifyPassword, isHashed } = await import("../password");
  assert.ok(isHashed((biz as any).dashboard_password), "password stored hashed, not plaintext");
  assert.ok(verifyPassword("secret123", (biz as any).dashboard_password), "the chosen password verifies");
});

test("two self-registered operators stay fully isolated", async () => {
  await fresh();
  await pendingSignup("+15553330002", "en", "Ann Fields", "Fields Yards");
  await pendingSignup("+15553330003", "es", "Beto Ruiz", "Ruiz Jardines");
  await say("+15553330002", "quoted the smiths at 5 oak st for 200/mo mowing");
  await say("+15553330003", "coticé a los perez en 8 elm por 175/mes");

  const { data: bizA } = await db().from("businesses").select("*").eq("slug", "fields-yards").single();
  const { data: bizB } = await db().from("businesses").select("*").eq("slug", "ruiz-jardines").single();
  const { data: clients } = await db().from("clients").select("*");
  const a = (clients as any[]).filter((c) => c.business_id === (bizA as any).id).map((c) => c.name);
  const b = (clients as any[]).filter((c) => c.business_id === (bizB as any).id).map((c) => c.name);
  assert.deepEqual(a, ["The Smiths"]);
  assert.equal(b.length, 1);
  assert.ok(!a.some((n) => b.includes(n)), "no crossover between operators");
});

test("a signup with an activation code needs the CODE, not just any text (anti-squatting)", async () => {
  await fresh();
  await pendingSignup("+15553330005", "en", "Real Owner", "Real Co", "secret123", "482913");
  // The victim texting anything else must NOT hand the attacker their account.
  let out = await say("+15553330005", "hey what is this number?");
  assert.equal(out.authorized, false, "ordinary text does not activate");
  let { data: biz } = await db().from("businesses").select("*").eq("slug", "real-co").maybeSingle();
  assert.equal(biz, null, "no business created without the code");
  // A wrong 6-digit guess doesn't activate either.
  out = await say("+15553330005", "111111");
  assert.equal(out.authorized, false, "wrong code does not activate");
  // Texting the code from the success screen activates.
  out = await say("+15553330005", "482913");
  assert.equal(out.authorized, true, "the real code activates");
  const { data: signup } = await db().from("signups").select("*").eq("phone", "+15553330005").single();
  assert.equal((signup as any).status, "activated");
});

test("75 inbound texts in a day trips the per-phone cap and goes quiet", async () => {
  await fresh();
  await pendingSignup("+15553330006", "en", "Busy Bee", "Bee Co");
  await say("+15553330006", "quoted bob at 1 main for 100/mo"); // activates
  const { data: biz } = await db().from("businesses").select("*").eq("slug", "bee-co").single();
  // Backfill today's traffic right up to the cap.
  const now = new Date().toISOString();
  for (let i = 0; i < 75; i++) {
    await db().from("messages").insert({
      business_id: (biz as any).id, direction: "inbound", from_phone: "+15553330006",
      body: `msg ${i}`, created_at: now,
    });
  }
  const out = await say("+15553330006", "who are my clients?");
  assert.ok(!/<Message>/.test(out.twiml), "over the cap: no reply at all (never fuels a loop)");
});

test("a signup can't hijack an already-registered phone", async () => {
  await fresh();
  await pendingSignup("+15553330004", "en");
  await say("+15553330004", "quoted bob at 1 main for 100/mo"); // activates
  const before = ((await db().from("businesses").select("*")).data as any[]).length;
  // A second pending signup for the SAME phone should not create a new business on next text.
  await pendingSignup("+15553330004", "en", "Impostor", "Fake Co");
  await say("+15553330004", "quoted jane at 2 main for 100/mo");
  const after = ((await db().from("businesses").select("*")).data as any[]).length;
  assert.equal(after, before, "no duplicate business for an existing operator");
});
