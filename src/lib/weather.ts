/**
 * Daily forecast for the dashboard, via Open-Meteo (free, no API key).
 * The operator sets their city once; we geocode it to lat/lon and store both.
 * Field work lives and dies by the weather, so the schedule shows it per day.
 *
 * Best-effort by design: any failure (network, bad city, rate limit) returns
 * null/empty and the dashboard simply renders without weather.
 */
import { config } from "./config";
import type { Lang } from "./types";

export interface DayWeather {
  date: string; // YYYY-MM-DD in the business timezone
  emoji: string;
  label: string; // localized short description ("Light rain")
  hi: number; // °F
  lo: number; // °F
  precip: number | null; // max precipitation probability %, if provided
}

// WMO weather codes → emoji + EN/ES description, grouped coarsely — an operator
// needs "rain or not", not 28 shades of drizzle.
const WMO: [codes: number[], emoji: string, en: string, es: string][] = [
  [[0], "☀️", "Sunny", "Soleado"],
  [[1], "🌤️", "Mostly sunny", "Mayormente soleado"],
  [[2], "⛅", "Partly cloudy", "Parcialmente nublado"],
  [[3], "☁️", "Cloudy", "Nublado"],
  [[45, 48], "🌫️", "Fog", "Niebla"],
  [[51, 53, 55, 56, 57], "🌦️", "Drizzle", "Llovizna"],
  [[61, 63, 80, 81], "🌧️", "Rain", "Lluvia"],
  [[65, 82], "🌧️", "Heavy rain", "Lluvia fuerte"],
  [[66, 67], "🌧️", "Freezing rain", "Lluvia helada"],
  [[71, 73, 75, 77, 85, 86], "🌨️", "Snow", "Nieve"],
  [[95, 96, 99], "⛈️", "Thunderstorms", "Tormentas"],
];

export function describeWmo(code: number, lang: Lang): { emoji: string; label: string } {
  for (const [codes, emoji, en, es] of WMO) {
    if (codes.includes(code)) return { emoji, label: lang === "es" ? es : en };
  }
  return { emoji: "🌡️", label: lang === "es" ? "Variable" : "Mixed" };
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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

// One forecast fetch per location per half hour — plenty fresh for daily highs.
const cache = new Map<string, { at: number; days: { date: string; code: number; hi: number; lo: number; precip: number | null }[] }>();
const CACHE_MS = 30 * 60 * 1000;

/** Up to 16 days of daily forecast, localized for `lang`. Empty array on any failure. */
export async function getForecast(lat: number, lon: number, timezone: string, lang: Lang): Promise<DayWeather[]> {
  if (config.testMode()) return [];
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${timezone}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    const data = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(timezone)}&forecast_days=16`
    );
    const d = data?.daily;
    if (!d?.time?.length) return entry ? toWeather(entry.days, lang) : [];
    entry = {
      at: Date.now(),
      days: (d.time as string[]).map((date, i) => ({
        date,
        code: Number(d.weather_code?.[i] ?? 3),
        hi: Math.round(Number(d.temperature_2m_max?.[i] ?? 0)),
        lo: Math.round(Number(d.temperature_2m_min?.[i] ?? 0)),
        precip: d.precipitation_probability_max?.[i] != null ? Number(d.precipitation_probability_max[i]) : null,
      })),
    };
    cache.set(key, entry);
  }
  return toWeather(entry.days, lang);
}

function toWeather(days: { date: string; code: number; hi: number; lo: number; precip: number | null }[], lang: Lang): DayWeather[] {
  return days.map((d) => ({ date: d.date, ...describeWmo(d.code, lang), hi: d.hi, lo: d.lo, precip: d.precip }));
}
