/**
 * Signed dashboard sessions. The cookie holds a payload + HMAC signature — NOT
 * the password (fixes the audit's plaintext-password-in-cookie finding). Uses
 * Web Crypto so the same code verifies in edge middleware AND node server code.
 *
 * Payloads:
 *   "admin"        — the founder (logged in with the env DASHBOARD_PASSWORD master key)
 *   "b:<uuid>"     — a specific business (logged in with that business's own password)
 */
import { config } from "./config";

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(config.dashboardPassword()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(sig);
}

export async function signSession(payload: string): Promise<string> {
  return `${payload}.${await hmac(payload)}`;
}

/** Returns the payload if the signature is valid, else null. */
export async function verifySession(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(payload);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? payload : null;
}

export type Session = { kind: "admin" } | { kind: "business"; businessId: string };

export function parseSession(payload: string | null): Session | null {
  if (payload === "admin") return { kind: "admin" };
  if (payload?.startsWith("b:")) return { kind: "business", businessId: payload.slice(2) };
  return null;
}
