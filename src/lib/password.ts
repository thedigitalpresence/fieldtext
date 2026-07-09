/**
 * Password hashing with scrypt (Node's built-in — no third-party dependency, no
 * supply-chain surface). Stored form: "scrypt$<salt-hex>$<hash-hex>".
 *
 * Verify is backward-compatible: a value that isn't in scrypt format is treated
 * as legacy plaintext and compared directly (so nothing breaks if an old
 * plaintext password lingers), but everything we write is hashed.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function isHashed(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("scrypt$");
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  if (!isHashed(stored)) return safeEqual(plain, stored); // legacy plaintext
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const test = scryptSync(plain, salt, KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (test.length !== expected.length) return false;
  return timingSafeEqual(test, expected);
}
