import type { SamsungHealthRecord } from "../types.js";
import { resolveRecordType } from "./record-types.js";
import { getExportSnapshot, parseSamsungDate } from "./samsung-health-export.js";
import {
  type BucketSize,
  bucketKey,
  dayBounds,
  estimateBucketCount,
  todayIsoDate
} from "./time.js";

export type SeriesStat = "avg" | "sum" | "min" | "max" | "median" | "p95" | "count";

interface SeriesOptions {
  metric: string;
  start?: string;
  end?: string;
  bucket?: BucketSize;
  stat?: SeriesStat;
  timezone?: string;
  maxBuckets?: number;
}

interface SeriesPoint {
  t: string;
  value: number | undefined;
  n: number;
}

export async function buildSeries(exportPath: string | undefined, options: SeriesOptions) {
  const metric = resolveRecordType(options.metric);
  const timezone = options.timezone ?? "UTC";
  const bucket: BucketSize = options.bucket ?? "1d";
  const stat: SeriesStat = options.stat ?? "avg";
  const maxBuckets = Math.max(1, Math.min(options.maxBuckets ?? 1000, 5000));

  const today = todayIsoDate(timezone);
  const endDate = options.end ?? today;
  // For series, default start is 30 days back (1h/6h), or wider for coarser buckets,
  // so a "show me a trend" call without bounds returns useful data.
  const defaultBackDays = bucket === "1h" || bucket === "6h" ? 30 : bucket === "1d" ? 90 : 365;
  const startDate = options.start ?? backCalendarDays(endDate, defaultBackDays);

  const startBound = dayBounds(asYmd(startDate), timezone).start;
  const endBound = dayBounds(asYmd(endDate), timezone).end;

  const estimated = estimateBucketCount(startBound, endBound, bucket);
  if (estimated > maxBuckets) {
    throw new Error(
      `Series would produce ~${estimated} buckets (cap: ${maxBuckets}). ` +
      `Choose a coarser bucket (e.g. ${suggestCoarser(bucket)}) or narrow the range.`
    );
  }

  const snapshot = await getExportSnapshot({
    exportPath,
    start: startBound.toISOString(),
    end: endBound.toISOString()
  });

  const matching = snapshot.records.filter(
    (record) => record.type === metric && record.numeric_value !== undefined
  );

  const groups = new Map<string, number[]>();
  for (const record of matching) {
    const start = parseSamsungDate(record.startDate);
    if (!start) continue;
    const key = bucketKey(start, bucket, timezone);
    const arr = groups.get(key) ?? [];
    arr.push(record.numeric_value as number);
    groups.set(key, arr);
  }

  const points: SeriesPoint[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => ({ t: key, value: aggregate(values, stat), n: values.length }));

  const unit = matching[0]?.unit;

  return {
    kind: "series",
    source: "samsung_health_export",
    generated_at: snapshot.generated_at,
    metric,
    stat,
    bucket,
    timezone,
    start: asYmd(startDate),
    end: asYmd(endDate),
    unit,
    bucket_count: points.length,
    points,
    cache: {
      hit: snapshot.cache.hit,
      records_indexed: snapshot.records.length,
      records_matched: matching.length
    },
    notes: [
      "Series is computed from a Samsung Health export file, not live Samsung Health.",
      "Each point aggregates raw records whose start time falls in the bucket window.",
      "Use samsung_health_list_records for unaggregated rows; use samsung_health_data_inventory to discover available record types and ranges."
    ]
  };
}

export function formatSeriesMarkdown(series: Awaited<ReturnType<typeof buildSeries>>): string {
  const lines = [
    `# Samsung Health Series — ${series.metric}`,
    "",
    `- **stat**: ${series.stat}`,
    `- **bucket**: ${series.bucket}`,
    `- **range**: ${series.start} → ${series.end} (${series.timezone})`,
    `- **bucket_count**: ${series.bucket_count}`,
    `- **records_matched**: ${series.cache.records_matched}`,
    `- **unit**: ${series.unit ?? "n/a"}`,
    ""
  ];
  if (series.points.length === 0) {
    lines.push("_No records found for this metric in the requested window._");
    return lines.join("\n");
  }
  const head = series.points.slice(0, 5);
  const tail = series.points.slice(-5);
  lines.push("First points:");
  head.forEach((p) => lines.push(`- ${p.t}: ${p.value ?? "—"} (n=${p.n})`));
  if (series.points.length > 10) {
    lines.push("...");
    lines.push("Last points:");
    tail.forEach((p) => lines.push(`- ${p.t}: ${p.value ?? "—"} (n=${p.n})`));
  }
  return lines.join("\n");
}

function aggregate(values: number[], stat: SeriesStat): number | undefined {
  if (values.length === 0) return undefined;
  switch (stat) {
    case "count": return values.length;
    case "sum": return round(values.reduce((s, v) => s + v, 0));
    case "min": return round(Math.min(...values));
    case "max": return round(Math.max(...values));
    case "avg": return round(values.reduce((s, v) => s + v, 0) / values.length);
    case "median": return round(percentile(values, 0.5));
    case "p95": return round(percentile(values, 0.95));
  }
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

function round(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * 100) / 100;
}

function backCalendarDays(date: string, days: number): string {
  const parsed = new Date(`${asYmd(date)}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function asYmd(value: string): string {
  // Accept "YYYY-MM-DD" or ISO timestamps; return YYYY-MM-DD.
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function suggestCoarser(bucket: BucketSize): BucketSize {
  switch (bucket) {
    case "1h": return "6h";
    case "6h": return "1d";
    case "1d": return "1w";
    case "1w": return "1m";
    case "1m": return "1m";
  }
}
