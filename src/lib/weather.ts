/**
 * Daily forecast for the dashboard. Two free, keyless sources:
 *   1. National Weather Service (api.weather.gov) — the official US forecast,
 *      the same data the iPhone weather app tracks. Primary for days 1–7.
 *   2. Open-Meteo — fills days 8–16 and is the fallback if NWS is down or the
 *      business is outside the US.
 *
 * The operator sets their city once; we geocode it to lat/lon and store both.
 * Best-effort by design: any failure returns empty and the dashboard simply
 * renders without weather.
 */
import { config } from "./config";
import type { Lang } from "./types";

export interface DayWeather {
  date: string; // YYYY-MM-DD in the business timezone
  emoji: string;
  label: string; // localized short description ("Rain")
  hi: number; // °F
  lo: number; // °F
  precip: number | null; // max precipitation probability %, if provided
}

// Coarse condition buckets — an operator needs "rain or not", not 28 shades of drizzle.
type Bucket = "sunny" | "mostlySunny" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "heavyRain" | "freezing" | "snow" | "storm" | "mixed";
const BUCKETS: Record<Bucket, [emoji: string, en: string, es: string]> = {
  sunny: ["☀️", "Sunny", "Soleado"],
  mostlySunny: ["🌤️", "Mostly sunny", "Mayormente soleado"],
  partly: ["⛅", "Partly cloudy", "Parcialmente nublado"],
  cloudy: ["☁️", "Cloudy", "Nublado"],
  fog: ["🌫️", "Fog", "Niebla"],
  drizzle: ["🌦️", "Drizzle", "Llovizna"],
  rain: ["🌧️", "Rain", "Lluvia"],
  heavyRain: ["🌧️", "Heavy rain", "Lluvia fuerte"],
  freezing: ["🌧️", "Freezing rain", "Lluvia helada"],
  snow: ["🌨️", "Snow", "Nieve"],
  storm: ["⛈️", "Thunderstorms", "Tormentas"],
  mixed: ["🌡️", "Mixed", "Variable"],
};

function wmoToBucket(code: number): Bucket {
  if (code === 0) return "sunny";
  if (code === 1) return "mostlySunny";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([65, 82].includes(code)) return "heavyRain";
  if ([66, 67].includes(code)) return "freezing";
  if ([61, 63, 80, 81].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "storm";
  return "mixed";
}

/** NWS gives prose ("Chance Rain Showers then Partly Sunny") — classify by keyword, wettest first. */
function textToBucket(s: string): Bucket {
  const t = s.toLowerCase();
  if (/thunder/.test(t)) return "storm";
  if (/snow|sleet|flurr|blizzard/.test(t)) return "snow";
  if (/freezing/.test(t)) return "freezing";
  if (/heavy rain/.test(t)) return "heavyRain";
  if (/rain|shower/.test(t)) return "rain";
  if (/drizzle/.test(t)) return "drizzle";
  if (/fog|haze|smoke/.test(t)) return "fog";
  if (/mostly cloudy|overcast|cloudy/.test(t)) return "cloudy";
  if (/partly/.test(t)) return "partly";
  if (/mostly sunny|mostly clear/.test(t)) return "mostlySunny";
  if (/sunny|clear/.test(t)) return "sunny";
  return "mixed";
}

async function getJson(url: string, headers?: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** City name → coordinates + a clean display label. null if not found. */
export async function geocodeCity(query: string): Promise<{ lat: number; lon: number; label: string } | null> {
  if (config.testMode()) return null;
  const q = query.trim().slice(0, 80);
  if (!q) return null;
  const data = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`
  );
  const hit = data?.results?.[0];
  if (!hit || typeof hit.latitude !== "number") return null;
  const label = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null].filter(Boolean).join(", ");
  return { lat: hit.latitude, lon: hit.longitude, label };
}

interface RawDay { date: string; bucket: Bucket; hi: number | null; lo: number | null; precip: number | null }

const NWS_HEADERS = { "User-Agent": "FieldText (fieldtextapp.com, eric@fieldtextapp.com)" };

/** Official US forecast, ~7 days. null outside NWS coverage or on any hiccup. */
async function nwsDays(lat: number, lon: number): Promise<RawDay[] | null> {
  const meta = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, NWS_HEADERS);
  const url = meta?.properties?.forecast;
  if (!url) return null;
  const fc = await getJson(url, NWS_HEADERS);
  const periods = fc?.properties?.periods;
  if (!Array.isArray(periods) || !periods.length) return null;

  const byDate = new Map<string, RawDay>();
  for (const p of periods) {
    const date = String(p.startTime ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const cur = byDate.get(date) ?? { date, bucket: "mixed" as Bucket, hi: null, lo: null, precip: null };
    if (p.isDaytime) {
      cur.hi = Number(p.temperature);
      cur.bucket = textToBucket(String(p.shortForecast ?? "")); // the daytime sky is what plans the route
    } else {
      cur.lo = cur.lo == null ? Number(p.temperature) : Math.min(cur.lo, Number(p.temperature));
      if (cur.hi == null) cur.bucket = textToBucket(String(p.shortForecast ?? ""));
    }
    const pop = p.probabilityOfPrecipitation?.value;
    if (pop != null) cur.precip = Math.max(cur.precip ?? 0, Number(pop));
    byDate.set(date, cur);
  }
  return byDate.size ? [...byDate.values()] : null;
}

/** Open-Meteo, 16 days — the fill + fallback layer. */
async function openMeteoDays(lat: number, lon: number, timezone: string): Promise<RawDay[]> {
  const data = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(timezone)}&forecast_days=16`
  );
  const d = data?.daily;
  if (!d?.time?.length) return [];
  return (d.time as string[]).map((date, i) => ({
    date,
    bucket: wmoToBucket(Number(d.weather_code?.[i] ?? 3)),
    hi: d.temperature_2m_max?.[i] != null ? Math.round(Number(d.temperature_2m_max[i])) : null,
    lo: d.temperature_2m_min?.[i] != null ? Math.round(Number(d.temperature_2m_min[i])) : null,
    precip: d.precipitation_probability_max?.[i] != null ? Number(d.precipitation_probability_max[i]) : null,
  }));
}

// One merged fetch per location per half hour — plenty fresh for daily highs.
const cache = new Map<string, { at: number; days: RawDay[] }>();
const CACHE_MS = 30 * 60 * 1000;

/** Up to 16 days of daily forecast, localized for `lang`. Empty array on total failure. */
export async function getForecast(lat: number, lon: number, timezone: string, lang: Lang): Promise<DayWeather[]> {
  if (config.testMode()) return [];
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${timezone}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    const [om, nws] = await Promise.all([openMeteoDays(lat, lon, timezone), nwsDays(lat, lon)]);
    const byDate = new Map(om.map((d) => [d.date, d]));
    // NWS wins wherever it has data (it's the official one); Open-Meteo fills
    // any field NWS lacks (e.g. today's high after the daytime period passes).
    for (const n of nws ?? []) {
      const base = byDate.get(n.date);
      byDate.set(n.date, {
        date: n.date,
        bucket: n.hi != null || !base ? n.bucket : base.bucket,
        hi: n.hi ?? base?.hi ?? null,
        lo: n.lo ?? base?.lo ?? null,
        precip: n.precip ?? base?.precip ?? null,
      });
    }
    const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!days.length) return entry ? toWeather(entry.days, lang) : [];
    entry = { at: Date.now(), days };
    cache.set(key, entry);
  }
  return toWeather(entry.days, lang);
}

function toWeather(days: RawDay[], lang: Lang): DayWeather[] {
  return days
    .filter((d) => d.hi != null && d.lo != null)
    .map((d) => {
      const [emoji, en, es] = BUCKETS[d.bucket];
      return { date: d.date, emoji, label: lang === "es" ? es : en, hi: Math.round(d.hi!), lo: Math.round(d.lo!), precip: d.precip };
    });
}
