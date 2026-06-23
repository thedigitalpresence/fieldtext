/**
 * Centralized config + env access — one place for a non-developer to look.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  supabase: {
    url: () => required("SUPABASE_URL"),
    serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  },
  twilio: {
    accountSid: () => required("TWILIO_ACCOUNT_SID"),
    authToken: () => required("TWILIO_AUTH_TOKEN"),
    fromNumber: () => optional("TWILIO_FROM_NUMBER"),
  },
  anthropic: {
    apiKey: () => required("ANTHROPIC_API_KEY"),
    model: () => optional("ANTHROPIC_MODEL", "claude-opus-4-8"),
  },
  cronSecret: () => required("CRON_SECRET"),
  dashboardPassword: () => required("DASHBOARD_PASSWORD"),
  defaultBusinessSlug: () => optional("DEFAULT_BUSINESS_SLUG", "green-acres"),
  appUrl: () => optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),

  /** Local test mode: file-backed mock DB instead of Supabase. */
  testMode: () => optional("LOCAL_TEST", "false").toLowerCase() === "true",
  /** SMS is logged instead of sent (no Twilio) when in test mode / no creds. */
  smsDryRun: () =>
    optional("SMS_DRY_RUN").toLowerCase() === "true" ||
    optional("LOCAL_TEST", "false").toLowerCase() === "true" ||
    !process.env.TWILIO_ACCOUNT_SID,
  /** Parse with a built-in heuristic instead of calling Claude (no API key needed). */
  llmDryRun: () =>
    optional("LLM_DRY_RUN").toLowerCase() === "true" ||
    optional("LOCAL_TEST", "false").toLowerCase() === "true" ||
    !process.env.ANTHROPIC_API_KEY,

  /** Global kill-switch for usage/cost logging (per-business toggle lives in settings). */
  billingEnabledGlobally: () => optional("BILLING_ENABLED", "true").toLowerCase() !== "false",
  /** USD per Twilio SMS segment (US default; override per your Twilio pricing). */
  smsCostPerSegment: () => Number(optional("SMS_COST_PER_SEGMENT", "0.0079")),
};
