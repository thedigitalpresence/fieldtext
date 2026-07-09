import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { handleInbound } from "@/lib/inbound";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XML_HEADERS = { "Content-Type": "text/xml" };

/**
 * POST /api/sms/inbound — Twilio inbound-message webhook.
 * Configure in Twilio: Phone Number → Messaging → "A message comes in" → Webhook →
 * https://<your-domain>/api/sms/inbound (HTTP POST).
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  // Verify the request really came from Twilio. The env bypass exists for local
  // testing ONLY — in production builds it is ignored (audit finding: this flag
  // was accidentally copied into prod env and silently disabled validation).
  const allowBypass = process.env.NODE_ENV !== "production" || process.env.LOCAL_TEST === "true";
  const bypassRequested = (process.env.TWILIO_VALIDATE_SIGNATURE ?? "true").toLowerCase() === "false";
  if (!(allowBypass && bypassRequested)) {
    const signature = req.headers.get("x-twilio-signature") || "";
    const url = `${config.appUrl()}/api/sms/inbound`;
    const valid = twilio.validateRequest(config.twilio.authToken(), signature, url, params);
    if (!valid) {
      // Most common cause: NEXT_PUBLIC_APP_URL doesn't exactly match the URL Twilio posts to.
      console.warn(`[api/sms/inbound] invalid Twilio signature (validated against ${url})`);
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  try {
    const numMedia = Number(params.NumMedia ?? 0) || 0;
    const media = Array.from({ length: Math.min(numMedia, 10) }, (_, i) => ({
      url: params[`MediaUrl${i}`],
      contentType: params[`MediaContentType${i}`],
    })).filter((m) => m.url);

    const outcome = await handleInbound({
      from: params.From,
      to: params.To,
      body: params.Body ?? "",
      messageSid: params.MessageSid,
      numMedia,
      media,
    });
    return new NextResponse(outcome.twiml, { status: 200, headers: XML_HEADERS });
  } catch (err) {
    console.error("[api/sms/inbound] error:", err);
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { status: 200, headers: XML_HEADERS }
    );
  }
}
