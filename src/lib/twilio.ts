import Twilio from "twilio";
import { config } from "./config";
import { db } from "./supabase";
import type { MessageDirection } from "./types";

let _twilio: ReturnType<typeof Twilio> | null = null;
function client() {
  if (_twilio) return _twilio;
  // TODO: requires real TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in env.
  _twilio = Twilio(config.twilio.accountSid(), config.twilio.authToken());
  return _twilio;
}

export interface SendResult { sid: string | null; ok: boolean; error?: string }

let _dryRunCounter = 0;

/** Send an SMS from the one designated business number. Dry-runs in test mode. */
export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (config.smsDryRun()) {
    _dryRunCounter += 1;
    console.log(`\n📲 [SMS dry-run] → ${to}\n   "${body}"\n`);
    return { sid: `DRYRUN-${_dryRunCounter}`, ok: true };
  }
  try {
    const msg = await client().messages.create({ to, from: config.twilio.fromNumber(), body });
    return { sid: msg.sid, ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[twilio] send to ${to} failed:`, error);
    return { sid: null, ok: false, error };
  }
}

/** Append a row to the messages audit log. Returns the new row id (or null). */
export async function logMessage(args: {
  businessId: string;
  direction: MessageDirection;
  body: string;
  fromPhone?: string | null;
  intent?: string | null;
  entities?: Record<string, unknown> | null;
  externalId?: string | null;
}): Promise<string | null> {
  const { data, error } = await db()
    .from("messages")
    .insert({
      business_id: args.businessId,
      direction: args.direction,
      from_phone: args.fromPhone ?? null,
      body: args.body,
      parsed_intent: args.intent ?? null,
      parsed_entities: args.entities ?? null,
      external_id: args.externalId ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[twilio] failed to log message:", error.message);
    return null;
  }
  return (data as { id: string }).id;
}
