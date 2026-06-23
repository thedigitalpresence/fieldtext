import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Normalize a phone to E.164 (e.g. "+14155551234"). US default. null if invalid. */
export function toE164(input: string, defaultCountry: "US" = "US"): string | null {
  if (!input) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
