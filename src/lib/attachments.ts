/**
 * Site photos — texted to the number as MMS, copied out of Twilio's temporary
 * media URLs into Supabase Storage, and attached to a client. The dashboard
 * shows them in the client panel via short-lived signed URLs.
 *
 * In LOCAL_TEST mode there is no Storage: the raw media URL is stored as the
 * path and returned as-is, so the whole flow stays testable offline.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { db } from "./supabase";
import { config } from "./config";
import type { Attachment } from "./types";

const BUCKET = "attachments";

let _storage: SupabaseClient | null = null;
function storage(): SupabaseClient {
  if (!_storage) {
    _storage = createClient(config.supabase.url(), config.supabase.serviceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _storage;
}

let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await storage().storage.createBucket(BUCKET, { public: false });
  // "already exists" is success for our purposes.
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`attachments bucket: ${error.message}`);
  }
  bucketReady = true;
}

export interface InboundMedia { url: string; contentType?: string }

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic",
};

/**
 * Copy Twilio media into permanent storage and index it against a client.
 * Returns how many photos were saved.
 */
export async function saveMedia(
  businessId: string, clientId: string, media: InboundMedia[], caption?: string | null
): Promise<number> {
  let saved = 0;
  for (const m of media.slice(0, 10)) {
    let path = m.url;
    if (!config.testMode()) {
      // Only ever fetch Twilio-hosted media: the URL arrives in webhook params,
      // and we attach our account credentials to the request — never let a
      // forged URL point that at an internal or attacker host (SSRF).
      let host = "";
      try { host = new URL(m.url).hostname; } catch { /* not a URL */ }
      if (!/(^|\.)twilio\.com$/i.test(host)) {
        console.error(`[attachments] refusing non-Twilio media host: ${host || "(invalid url)"}`);
        continue;
      }
      await ensureBucket();
      // Twilio media requires basic auth with the account credentials.
      const auth = Buffer.from(`${config.twilio.accountSid()}:${config.twilio.authToken()}`).toString("base64");
      const res = await fetch(m.url, { headers: { Authorization: `Basic ${auth}` }, redirect: "follow" });
      if (!res.ok) {
        console.error(`[attachments] media fetch failed ${res.status} for ...${m.url.slice(-12)}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = m.contentType || res.headers.get("content-type") || "image/jpeg";
      const ext = EXT[contentType] ?? "jpg";
      path = `${businessId}/${clientId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await storage().storage.from(BUCKET).upload(path, buf, { contentType });
      if (error) {
        console.error(`[attachments] upload failed: ${error.message}`);
        continue;
      }
    }
    await db().from("attachments").insert({
      business_id: businessId,
      client_id: clientId,
      storage_path: path,
      content_type: m.contentType ?? null,
      caption: caption || null,
    });
    saved++;
  }
  return saved;
}

/** All photos for a business with viewable URLs (signed, 1h) — for the dashboard. */
export async function listPhotos(businessId: string): Promise<{ id: string; clientId: string | null; url: string; caption: string | null }[]> {
  const { data } = await db()
    .from("attachments").select("*").eq("business_id", businessId).order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as Attachment[];
  if (config.testMode()) {
    return rows.map((a) => ({ id: a.id, clientId: a.client_id, url: a.storage_path, caption: a.caption }));
  }
  if (!rows.length) return [];
  // One batched signing call instead of one round-trip per photo.
  const { data: signed } = await storage().storage.from(BUCKET)
    .createSignedUrls(rows.map((a) => a.storage_path), 3600);
  const byPath = new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
  const out: { id: string; clientId: string | null; url: string; caption: string | null }[] = [];
  for (const a of rows) {
    const url = byPath.get(a.storage_path);
    if (url) out.push({ id: a.id, clientId: a.client_id, url, caption: a.caption });
  }
  return out;
}
