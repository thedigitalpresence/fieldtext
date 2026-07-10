import { config } from "./config";

// Live site status for the HQ dashboard, pulled from UptimeRobot's v2 API.
// Best-effort: if the key isn't set or the API is unreachable, HQ just shows a
// "connect UptimeRobot" hint instead of breaking.

export interface UptimeStatus {
  configured: boolean; // is an UPTIMEROBOT_API_KEY set?
  ok: boolean; // did the fetch succeed?
  state: "up" | "down" | "paused" | "pending" | "unknown";
  uptime7d: number | null; // percent
  uptime30d: number | null; // percent
  avgResponseMs: number | null;
  monitorName: string | null;
  error?: string;
}

// UptimeRobot status codes → our friendly states.
function mapState(code: number): UptimeStatus["state"] {
  switch (code) {
    case 2: return "up";
    case 8: // seems down
    case 9: return "down";
    case 0: return "paused";
    case 1: return "pending"; // not checked yet
    default: return "unknown";
  }
}

let _cache: { at: number; data: UptimeStatus } | null = null;
const TTL_MS = 2 * 60 * 1000;

export async function getUptimeStatus(): Promise<UptimeStatus> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.data;

  const key = config.uptimeRobotKey();
  if (!key) {
    return { configured: false, ok: false, state: "unknown", uptime7d: null, uptime30d: null, avgResponseMs: null, monitorName: null };
  }

  try {
    const res = await fetch("https://api.uptimerobot.com/v2/getMonitors", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
      body: new URLSearchParams({
        api_key: key,
        format: "json",
        custom_uptime_ratios: "7-30", // → [7d, 30d]
        response_times: "1",
        response_times_average: "60",
      }),
      cache: "no-store",
    });
    const json: any = await res.json();
    if (json?.stat !== "ok") throw new Error(json?.error?.message ?? "UptimeRobot returned an error");

    const m = json.monitors?.[0];
    if (!m) throw new Error("No monitor found on this key");

    const ratios = String(m.custom_uptime_ratio ?? "").split("-").map((x: string) => Number(x));
    const data: UptimeStatus = {
      configured: true,
      ok: true,
      state: mapState(Number(m.status)),
      uptime7d: Number.isFinite(ratios[0]) ? ratios[0] : null,
      uptime30d: Number.isFinite(ratios[1]) ? ratios[1] : null,
      avgResponseMs: m.average_response_time != null ? Math.round(Number(m.average_response_time)) : null,
      monitorName: m.friendly_name ?? null,
    };
    _cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[uptime] fetch failed:", error);
    return { configured: true, ok: false, state: "unknown", uptime7d: null, uptime30d: null, avgResponseMs: null, monitorName: null, error };
  }
}
