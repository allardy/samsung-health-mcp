import type { SamsungHealthRecord, SamsungHealthWorkout } from "../types.js";
import { getExportSnapshot, parseSamsungDate } from "./samsung-health-export.js";
import { type BucketSize, bucketKey, dayBounds, estimateBucketCount, todayIsoDate } from "./time.js";

export type RangeGranularity = "day" | "week" | "month";

interface RangeSummaryOptions {
  start?: string;
  end?: string;
  granularity?: RangeGranularity;
  timezone?: string;
  maxBuckets?: number;
}

interface BucketSummary {
  t: string;
  steps: number;
  active_energy_kcal: number | undefined;
  distance_km: number | undefined;
  avg_resting_hr_bpm: number | undefined;
  avg_hrv_ms: number | undefined;
  avg_heart_rate_bpm: number | undefined;
  avg_stress: number | undefined;
  avg_oxygen_saturation_pct: number | undefined;
  sleep_minutes: number;
  workouts: number;
  workout_minutes: number;
  records: number;
}

export async function buildRangeSummary(exportPath: string | undefined, options: RangeSummaryOptions = {}) {
  const timezone = options.timezone ?? "UTC";
  const granularity: RangeGranularity = options.granularity ?? "week";
  const maxBuckets = Math.max(1, Math.min(options.maxBuckets ?? 200, 1000));

  const today = todayIsoDate(timezone);
  const endDate = options.end ?? today;
  const defaultBack = granularity === "day" ? 90 : granularity === "week" ? 365 : 365 * 3;
  const startDate = options.start ?? backCalendarDays(endDate, defaultBack);

  const startBound = dayBounds(asYmd(startDate), timezone).start;
  const endBound = dayBounds(asYmd(endDate), timezone).end;

  const bucket: BucketSize = granularity === "day" ? "1d" : granularity === "week" ? "1w" : "1m";
  const estimated = estimateBucketCount(startBound, endBound, bucket);
  if (estimated > maxBuckets) {
    throw new Error(
      `Range summary would produce ~${estimated} buckets (cap: ${maxBuckets}). ` +
      `Choose a coarser granularity or narrow the range.`
    );
  }

  const snapshot = await getExportSnapshot({
    exportPath,
    start: startBound.toISOString(),
    end: endBound.toISOString()
  });

  const groups = new Map<string, { records: SamsungHealthRecord[]; workouts: SamsungHealthWorkout[] }>();
  for (const record of snapshot.records) {
    const start = parseSamsungDate(record.startDate);
    if (!start) continue;
    const key = bucketKey(start, bucket, timezone);
    const entry = groups.get(key) ?? { records: [], workouts: [] };
    entry.records.push(record);
    groups.set(key, entry);
  }
  for (const workout of snapshot.workouts) {
    const start = parseSamsungDate(workout.startDate);
    if (!start) continue;
    const key = bucketKey(start, bucket, timezone);
    const entry = groups.get(key) ?? { records: [], workouts: [] };
    entry.workouts.push(workout);
    groups.set(key, entry);
  }

  const buckets: BucketSummary[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { records, workouts }]) => summarizeBucket(key, records, workouts));

  const totals = aggregateTotals(buckets);

  return {
    kind: "range_summary",
    source: "samsung_health_export",
    generated_at: snapshot.generated_at,
    timezone,
    granularity,
    start: asYmd(startDate),
    end: asYmd(endDate),
    bucket_count: buckets.length,
    totals,
    averages: {
      steps_per_bucket: average(buckets.map((b) => b.steps)),
      sleep_hours_per_bucket: round(average(buckets.map((b) => b.sleep_minutes / 60))),
      resting_hr_bpm: averageDefined(buckets.map((b) => b.avg_resting_hr_bpm)),
      hrv_ms: averageDefined(buckets.map((b) => b.avg_hrv_ms)),
      stress: averageDefined(buckets.map((b) => b.avg_stress))
    },
    buckets,
    cache: {
      hit: snapshot.cache.hit,
      records_indexed: snapshot.records.length,
      workouts_indexed: snapshot.workouts.length
    },
    notes: [
      "Range summary is computed from a Samsung Health export file, not live Samsung Health.",
      "Each bucket aggregates records and workouts that overlap the bucket window.",
      "Use samsung_health_series for single-metric trends at finer resolution.",
      "This is wellness context, not medical diagnosis."
    ]
  };
}

export function formatRangeSummaryMarkdown(summary: Awaited<ReturnType<typeof buildRangeSummary>>): string {
  const lines = [
    "# Samsung Health Range Summary",
    "",
    `- **granularity**: ${summary.granularity}`,
    `- **range**: ${summary.start} → ${summary.end} (${summary.timezone})`,
    `- **bucket_count**: ${summary.bucket_count}`,
    `- **totals.steps**: ${summary.totals.steps}`,
    `- **totals.workouts**: ${summary.totals.workouts}`,
    `- **averages.resting_hr_bpm**: ${summary.averages.resting_hr_bpm ?? "—"}`,
    `- **averages.sleep_hours_per_bucket**: ${summary.averages.sleep_hours_per_bucket ?? "—"}`
  ];
  if (summary.buckets.length === 0) {
    lines.push("", "_No records found in the requested window._");
  }
  return lines.join("\n");
}

function summarizeBucket(key: string, records: SamsungHealthRecord[], workouts: SamsungHealthWorkout[]): BucketSummary {
  const stepValues = numericValues(records, "samsung_health_steps");
  const stepDaily = numericValues(records, "samsung_health_step_daily");
  // Prefer instantaneous step counts when present; fall back to per-day rollups so we
  // don't double-count older exports that only have daily aggregates.
  const stepsTotal = stepValues.length > 0 ? sum(stepValues) : sum(stepDaily);

  const activeEnergy = sum(numericValues(records, "samsung_health_active_energy"));
  const caloriesDaily = sum(numericValues(records, "samsung_health_calories_daily"));
  const energyTotal = activeEnergy > 0 ? activeEnergy : caloriesDaily;

  const distance = sum(numericValues(records, "samsung_health_distance"));
  const sleepMinutes = sumSleepMinutes(records);
  const workoutMinutes = workouts.reduce((s, w) => s + workoutDurationMinutes(w), 0);

  return {
    t: key,
    steps: round(stepsTotal) ?? 0,
    active_energy_kcal: energyTotal > 0 ? round(energyTotal) : undefined,
    distance_km: distance > 0 ? round(distance) : undefined,
    avg_resting_hr_bpm: averageDefined(numericValues(records, "samsung_health_resting_heart_rate")),
    avg_hrv_ms: averageDefined(numericValues(records, "samsung_health_hrv")),
    avg_heart_rate_bpm: averageDefined(numericValues(records, "samsung_health_heart_rate")),
    avg_stress: averageDefined(numericValues(records, "samsung_health_stress")),
    avg_oxygen_saturation_pct: averageDefined(numericValues(records, "samsung_health_oxygen_saturation")),
    sleep_minutes: round(sleepMinutes) ?? 0,
    workouts: workouts.length,
    workout_minutes: round(workoutMinutes) ?? 0,
    records: records.length
  };
}

function aggregateTotals(buckets: BucketSummary[]) {
  return {
    steps: round(sum(buckets.map((b) => b.steps))) ?? 0,
    active_energy_kcal: round(sum(buckets.map((b) => b.active_energy_kcal ?? 0))) || undefined,
    distance_km: round(sum(buckets.map((b) => b.distance_km ?? 0))) || undefined,
    sleep_minutes: round(sum(buckets.map((b) => b.sleep_minutes))) ?? 0,
    workouts: sum(buckets.map((b) => b.workouts)),
    workout_minutes: round(sum(buckets.map((b) => b.workout_minutes))) ?? 0,
    records: sum(buckets.map((b) => b.records))
  };
}

function numericValues(records: SamsungHealthRecord[], type: string): number[] {
  return records
    .filter((r) => r.type === type && r.numeric_value !== undefined)
    .map((r) => r.numeric_value as number);
}

function sumSleepMinutes(records: SamsungHealthRecord[]): number {
  // Match summary.ts: prefer stages when present, else sessions, to avoid double-counting.
  const stages = records.filter((r) => r.type === "samsung_health_sleep_stage");
  const sessions = records.filter((r) => r.type === "samsung_health_sleep");
  const source = stages.length > 0 ? stages : sessions;
  let minutes = 0;
  for (const record of source) {
    const start = parseSamsungDate(record.startDate);
    const end = parseSamsungDate(record.endDate);
    if (!start || !end) continue;
    minutes += Math.max(0, end.getTime() - start.getTime()) / 60000;
  }
  return minutes;
}

function workoutDurationMinutes(workout: SamsungHealthWorkout): number {
  if (!workout.duration) return 0;
  if (workout.durationUnit === "sec") return workout.duration / 60;
  if (workout.durationUnit === "hr") return workout.duration * 60;
  return workout.duration;
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

function averageDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  if (defined.length === 0) return undefined;
  return round(sum(defined) / defined.length);
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
  return value.length >= 10 ? value.slice(0, 10) : value;
}
