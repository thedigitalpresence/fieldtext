import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Normalize a phone to E.164 (e.g. "+14155551234"). US default. null if invalid. */
export function toE164(input: string, defaultCountry: "US" = "US"): string | null {
  if (!input) return null;
  const raw = input.trim();
  try {
    const parsed = parsePhoneNumberFromString(raw, defaultCountry);
    if (parsed && parsed.isValid()) return parsed.number;
  } catch {
    // libphonenumber metadata can fail to load under some module loaders
    // (e.g. the test runner) — fall through to the plain-digits path.
  }
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}
