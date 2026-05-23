export function todayIsoDate(timezone = "UTC", now = new Date()): string {
  const parts = datePartsInTimezone(now, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function dayBounds(date: string, timezone = "UTC"): { start: Date; end: Date } {
  const [year, month, day] = date.split("-").map(Number);
  const start = zonedTimeToUtc(year, month, day, 0, 0, 0, 0, timezone);
  const next = addCalendarDays(date, 1);
  const [nextYear, nextMonth, nextDay] = next.split("-").map(Number);
  const nextStart = zonedTimeToUtc(nextYear, nextMonth, nextDay, 0, 0, 0, 0, timezone);
  return { start, end: new Date(nextStart.getTime() - 1) };
}

export function addCalendarDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function dateOnlyInTimezone(value: string | undefined, timezone = "UTC"): string | undefined {
  const parsed = parseFlexibleDate(value);
  if (!parsed) return undefined;
  return todayIsoDate(timezone, parsed);
}

export function parseFlexibleDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const compactOffsetMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(value);
  if (compactOffsetMatch) {
    const parsed = new Date(`${compactOffsetMatch[1]}T${compactOffsetMatch[2]}${compactOffsetMatch[3]}:${compactOffsetMatch[4]}`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function diffDays(from: Date, to = new Date()): number {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

export type BucketSize = "1h" | "6h" | "1d" | "1w" | "1m";

/**
 * Returns a sortable bucket label for a record's start time, anchored in the
 * given timezone. Labels are lexicographically sortable:
 *   1h   -> "YYYY-MM-DDTHH:00"
 *   6h   -> "YYYY-MM-DDTHH:00" (HH in {00,06,12,18})
 *   1d   -> "YYYY-MM-DD"
 *   1w   -> "YYYY-MM-DD" (Monday of the ISO week, in the given timezone)
 *   1m   -> "YYYY-MM"
 */
export function bucketKey(date: Date, bucket: BucketSize, timezone = "UTC"): string {
  const parts = datePartsWithTimeInTimezone(date, timezone);
  switch (bucket) {
    case "1h":
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
    case "6h": {
      const hour = Math.floor(Number(parts.hour) / 6) * 6;
      return `${parts.year}-${parts.month}-${parts.day}T${pad(hour)}:00`;
    }
    case "1d":
      return `${parts.year}-${parts.month}-${parts.day}`;
    case "1w": {
      const localDate = `${parts.year}-${parts.month}-${parts.day}`;
      const dow = isoDayOfWeek(Number(parts.year), Number(parts.month), Number(parts.day));
      return addCalendarDays(localDate, -(dow - 1));
    }
    case "1m":
      return `${parts.year}-${parts.month}`;
  }
}

/**
 * Estimates how many buckets a [start, end] range will produce at a given bucket size.
 * Used to reject obviously-too-large series requests before scanning the export.
 */
export function estimateBucketCount(start: Date, end: Date, bucket: BucketSize): number {
  const ms = Math.max(0, end.getTime() - start.getTime());
  switch (bucket) {
    case "1h": return Math.ceil(ms / 3_600_000) + 1;
    case "6h": return Math.ceil(ms / 21_600_000) + 1;
    case "1d": return Math.ceil(ms / 86_400_000) + 1;
    case "1w": return Math.ceil(ms / (7 * 86_400_000)) + 1;
    case "1m": return Math.ceil(ms / (30 * 86_400_000)) + 1;
  }
}

function datePartsWithTimeInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: lookup.year ?? "1970",
    month: lookup.month ?? "01",
    day: lookup.day ?? "01",
    hour: lookup.hour ?? "00",
    minute: lookup.minute ?? "00",
    second: lookup.second ?? "00"
  };
}

// ISO weekday: Monday=1..Sunday=7. Algorithm: Zeller-style using proleptic Gregorian.
function isoDayOfWeek(year: number, month: number, day: number): number {
  const utc = Date.UTC(year, month - 1, day);
  const jsDow = new Date(utc).getUTCDay(); // 0=Sun..6=Sat
  return jsDow === 0 ? 7 : jsDow;
}

function datePartsInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return {
    year: parts.find((part) => part.type === "year")?.value ?? "1970",
    month: parts.find((part) => part.type === "month")?.value ?? "01",
    day: parts.find((part) => part.type === "day")?.value ?? "01"
  };
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number, timezone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  const offset = timezoneOffsetMs(utcGuess, timezone);
  const first = new Date(utcGuess.getTime() - offset);
  const secondOffset = timezoneOffsetMs(first, timezone);
  return secondOffset === offset ? first : new Date(utcGuess.getTime() - secondOffset);
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second)
  );
  return asUtc - date.getTime();
}

function normalizeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "UTC";
  }
}

function pad(value: string | number): string {
  return String(value).padStart(2, "0");
}
