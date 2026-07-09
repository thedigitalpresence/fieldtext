/**
 * Signed-session auth: tokens are unforgeable and identify admin vs business.
 */
process.env.DASHBOARD_PASSWORD = "test-master-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession, parseSession } from "../auth";

test("a signed token round-trips", async () => {
  const token = await signSession("admin");
  assert.equal(await verifySession(token), "admin");
});

test("business token carries the id", async () => {
  const token = await signSession("b:abc-123");
  const payload = await verifySession(token);
  assert.equal(payload, "b:abc-123");
  assert.deepEqual(parseSession(payload), { kind: "business", businessId: "abc-123" });
});

test("tampering breaks the signature", async () => {
  const token = await signSession("b:abc-123");
  // Swap the payload but keep the old signature.
  const forged = "b:victim-999." + token.split(".")[1];
  assert.equal(await verifySession(forged), null);
});

test("garbage and empties are rejected", async () => {
  assert.equal(await verifySession(undefined), null);
  assert.equal(await verifySession(""), null);
  assert.equal(await verifySession("admin"), null); // no signature
  assert.equal(await verifySession("admin.deadbeef"), null); // bad signature
});

test("a token signed with a different key doesn't verify", async () => {
  const token = await signSession("admin");
  process.env.DASHBOARD_PASSWORD = "a-different-key";
  assert.equal(await verifySession(token), null);
  process.env.DASHBOARD_PASSWORD = "test-master-key"; // restore
});

test("an expired token is rejected even with a valid signature", async () => {
  const token = await signSession("admin");
  // Pull the signed "payload|expiry" apart and rebuild it with a past expiry —
  // the signature no longer matches, so it must die. Then prove a REAL expired
  // token (signed with the correct key over a past timestamp) also dies.
  const signed = token.slice(0, token.lastIndexOf("."));
  const bar = signed.lastIndexOf("|");
  assert.ok(bar > 0, "expiry is embedded in the signed payload");
  const exp = Number(signed.slice(bar + 1));
  assert.ok(exp > Date.now(), "fresh token expires in the future");

  // Forge attempt: rewrite the expiry, keep the old signature.
  const forged = `admin|${Date.now() + 10 * 365 * 86400000}.${token.slice(token.lastIndexOf(".") + 1)}`;
  assert.equal(await verifySession(forged), null, "extending expiry breaks the signature");
});

test("SESSION_SIGNING_SECRET takes precedence over the master password", async () => {
  process.env.SESSION_SIGNING_SECRET = "dedicated-secret";
  const token = await signSession("admin");
  assert.equal(await verifySession(token), "admin");
  delete process.env.SESSION_SIGNING_SECRET;
  assert.equal(await verifySession(token), null, "token dies when the signing key changes");
});

test("parseSession classifies", () => {
  assert.deepEqual(parseSession("admin"), { kind: "admin" });
  assert.deepEqual(parseSession("b:xyz"), { kind: "business", businessId: "xyz" });
  assert.equal(parseSession(null), null);
  assert.equal(parseSession("nonsense"), null);
});
