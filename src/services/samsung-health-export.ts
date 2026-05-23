import { promises as fs } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import yauzl from "yauzl";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import type { SamsungHealthRecord, SamsungHealthWorkout } from "../types.js";
import { resolveRecordType } from "./record-types.js";
import { parseFlexibleDate } from "./time.js";
import {
  getLastParsedAt,
  invalidateIfExportChanged,
  loadCache,
  saveCache
} from "./incremental-cache.js";

export interface ExportLocation {
  input_path?: string;
  resolved_path?: string;
  exists: boolean;
  kind: "missing" | "csv" | "directory" | "zip" | "unsupported";
  size_bytes?: number;
  modified_at?: string;
  mtime_ms?: number;
  csv_count?: number;
  note?: string;
}

export interface RecordQuery {
  exportPath?: string;
  type?: string;
  start?: string;
  end?: string;
  limit?: number;
  /**
   * When true, skip records older than the per-category last-parsed timestamp
   * in the incremental cache and persist the newest seen timestamp back. The
   * cache auto-invalidates when the export file mtime changes.
   */
  useIncrementalCache?: boolean;
}

export interface WorkoutQuery {
  exportPath?: string;
  start?: string;
  end?: string;
  limit?: number;
}

export interface SnapshotQuery {
  exportPath?: string;
  start?: string;
  end?: string;
}

export interface SamsungHealthSnapshot {
  source: "samsung_health_export";
  generated_at: string;
  location: ExportLocation;
  range: {
    start?: string;
    end?: string;
  };
  cache: {
    key: string;
    hit: boolean;
  };
  records: SamsungHealthRecord[];
  workouts: SamsungHealthWorkout[];
}

interface CsvSource {
  name: string;
  text: string;
  size_bytes?: number;
  modified_at?: string;
}

interface ExportSources {
  csv: CsvSource[];
  // Indexed by basename (e.g. "5dd628ad-….binning_data.json"). Only contains files Samsung
  // references from a CSV's `binning_data` column — currently HRV; other record types
  // (oxygen_saturation, stress, heart_rate, …) carry their numeric values directly in the CSV
  // and don't need the JSON sidecars, so we skip those to keep memory bounded.
  binningJsons: Map<string, string>;
}

interface EntityVisitor {
  onRecord?: (record: SamsungHealthRecord) => boolean;
  onWorkout?: (workout: SamsungHealthWorkout) => boolean;
}

type CsvRow = Record<string, string>;

const SNAPSHOT_CACHE = new Map<string, SamsungHealthSnapshot>();
const MAX_SNAPSHOT_CACHE_ENTRIES = 6;

const DATE_KEYS = {
  start: ["start_time", "starttime", "start_date", "startdate", "start", "from_time", "from", "day_time", "record_time", "measurement_time", "timestamp", "date"],
  end: ["end_time", "endtime", "end_date", "enddate", "end", "to_time", "to"],
  created: ["create_time", "created_time", "creation_time", "update_time", "updated_time", "modify_time", "modified_time"]
};

export async function inspectExportLocation(inputPath?: string): Promise<ExportLocation> {
  if (!inputPath) {
    return {
      exists: false,
      kind: "missing",
      note: "Set SAMSUNG_HEALTH_EXPORT_PATH or run setup with --export-path."
    };
  }

  const resolvedPath = resolve(inputPath.replace(/^~/, process.env.HOME ?? ""));
  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      const csvCount = await countCsvFiles(resolvedPath);
      return {
        input_path: inputPath,
        resolved_path: resolvedPath,
        exists: csvCount > 0,
        kind: "directory",
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        mtime_ms: stat.mtimeMs,
        csv_count: csvCount,
        note: csvCount > 0 ? undefined : "Directory exists, but no Samsung Health CSV files were found."
      };
    }
    if (stat.isFile() && extname(resolvedPath).toLowerCase() === ".csv") {
      return {
        input_path: inputPath,
        resolved_path: resolvedPath,
        exists: true,
        kind: "csv",
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        mtime_ms: stat.mtimeMs,
        csv_count: 1
      };
    }
    if (stat.isFile() && extname(resolvedPath).toLowerCase() === ".zip") {
      const csvCount = await countZipCsvEntries(resolvedPath);
      return {
        input_path: inputPath,
        resolved_path: resolvedPath,
        exists: csvCount > 0,
        kind: "zip",
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        mtime_ms: stat.mtimeMs,
        csv_count: csvCount,
        note: csvCount > 0 ? "Will read Samsung Health CSV files from the zip." : "Zip exists, but no CSV files were found."
      };
    }
    return {
      input_path: inputPath,
      resolved_path: resolvedPath,
      exists: false,
      kind: "unsupported",
      size_bytes: stat.size,
      note: "Expected a Samsung Health export directory, .csv file, or .zip file containing CSVs."
    };
  } catch {
    return {
      input_path: inputPath,
      resolved_path: resolvedPath,
      exists: false,
      kind: "missing",
      note: "Path does not exist."
    };
  }
}

export async function listRecords(query: RecordQuery): Promise<SamsungHealthRecord[]> {
  const limit = normalizeLimit(query.limit);
  const location = await inspectExportLocation(query.exportPath);
  if (!location.exists) throw new Error(location.note ?? "Samsung Health export not found.");
  const start = query.start ? parseSamsungDate(query.start) : undefined;
  const end = query.end ? parseSamsungDate(query.end) : undefined;
  const resolvedType = query.type ? resolveRecordType(query.type) : undefined;
  const records: SamsungHealthRecord[] = [];

  let incrementalCutoff: Date | undefined;
  let useIncremental = false;
  const cachePath = location.resolved_path ?? location.input_path;
  if (query.useIncrementalCache && resolvedType && cachePath) {
    useIncremental = true;
    await invalidateIfExportChanged(cachePath, location.mtime_ms);
    const cached = await getLastParsedAt(resolvedType);
    if (cached) {
      const parsed = parseSamsungDate(cached);
      if (parsed) incrementalCutoff = parsed;
    }
  }

  let newestSeenMs = 0;
  await parseExportEntities(location, {
    onRecord(record) {
      if (resolvedType && record.type !== resolvedType) return false;
      if (!overlaps(record.startDate, record.endDate, start, end)) return false;
      if (incrementalCutoff) {
        const recordStart = parseSamsungDate(record.startDate);
        if (recordStart && recordStart <= incrementalCutoff) return false;
      }
      if (useIncremental) {
        const ts = parseSamsungDate(record.startDate);
        if (ts && ts.getTime() > newestSeenMs) newestSeenMs = ts.getTime();
      }
      records.push(record);
      return records.length >= limit;
    }
  });

  if (useIncremental && resolvedType && newestSeenMs > 0 && cachePath) {
    const cache = await loadCache();
    cache.export_path = cachePath;
    cache.export_mtime_ms = location.mtime_ms;
    cache.categories[resolvedType] = new Date(newestSeenMs).toISOString();
    await saveCache(cache);
  }

  return records;
}

export async function listWorkouts(query: WorkoutQuery): Promise<SamsungHealthWorkout[]> {
  const limit = normalizeLimit(query.limit);
  const location = await inspectExportLocation(query.exportPath);
  if (!location.exists) throw new Error(location.note ?? "Samsung Health export not found.");
  const start = query.start ? parseSamsungDate(query.start) : undefined;
  const end = query.end ? parseSamsungDate(query.end) : undefined;
  const workouts: SamsungHealthWorkout[] = [];

  await parseExportEntities(location, {
    onWorkout(workout) {
      if (!overlaps(workout.startDate, workout.endDate, start, end)) return false;
      workouts.push(workout);
      return workouts.length >= limit;
    }
  });

  return workouts;
}

export async function getExportSnapshot(query: SnapshotQuery): Promise<SamsungHealthSnapshot> {
  const location = await inspectExportLocation(query.exportPath);
  if (!location.exists) throw new Error(location.note ?? "Samsung Health export not found.");
  const start = query.start ? parseSamsungDate(query.start) : undefined;
  const end = query.end ? parseSamsungDate(query.end) : undefined;
  const key = snapshotCacheKey(location, query);
  const cached = SNAPSHOT_CACHE.get(key);
  if (cached) return { ...cached, cache: { ...cached.cache, hit: true } };

  const records: SamsungHealthRecord[] = [];
  const workouts: SamsungHealthWorkout[] = [];
  await parseExportEntities(location, {
    onRecord(record) {
      if (!overlaps(record.startDate, record.endDate, start, end)) return false;
      records.push(record);
      return false;
    },
    onWorkout(workout) {
      if (!overlaps(workout.startDate, workout.endDate, start, end)) return false;
      workouts.push(workout);
      return false;
    }
  });

  const snapshot: SamsungHealthSnapshot = {
    source: "samsung_health_export",
    generated_at: new Date().toISOString(),
    location,
    range: {
      start: query.start,
      end: query.end
    },
    cache: {
      key,
      hit: false
    },
    records,
    workouts
  };
  cacheSnapshot(key, snapshot);
  return snapshot;
}

export function parseSamsungDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      // Reject pre-2000 epochs (catches "0", version numbers, IDs that aren't really timestamps).
      if (milliseconds > 946_684_800_000) {
        const parsed = new Date(milliseconds);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
      return undefined;
    }
  }
  const compact = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(trimmed);
  if (compact) {
    const parsed = new Date(Date.UTC(
      Number(compact[1]),
      Number(compact[2]) - 1,
      Number(compact[3]),
      Number(compact[4] ?? 0),
      Number(compact[5] ?? 0),
      Number(compact[6] ?? 0)
    ));
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > 946_684_800_000) return parsed;
    return undefined;
  }
  const flex = parseFlexibleDate(trimmed);
  if (flex && flex.getTime() > 946_684_800_000) return flex;
  return undefined;
}

export function recordOverlaps(startValue: string | undefined, endValue: string | undefined, start?: Date, end?: Date): boolean {
  return overlaps(startValue, endValue, start, end);
}

async function parseExportEntities(location: ExportLocation, visitor: EntityVisitor): Promise<void> {
  const sources = await readExportSources(location);
  let stopped = false;
  for (const source of sources.csv) {
    if (stopped) break;
    const rows = parseCsv(source.text);
    for (const row of rows) {
      if (stopped) break;
      const workout = rowToWorkout(source.name, row);
      if (workout) {
        stopped = visitor.onWorkout?.(workout) ?? false;
        continue;
      }
      const record = rowToRecord(source.name, row, sources.binningJsons);
      if (record) stopped = visitor.onRecord?.(record) ?? false;
      if (stopped) break;
      for (const secondary of rowToSecondaryRecords(source.name, row, record)) {
        stopped = visitor.onRecord?.(secondary) ?? false;
        if (stopped) break;
      }
    }
  }
}

// Some Samsung tables carry multiple metrics in a single row (e.g. step_daily_trend has both a
// step count and a distance column). The primary record captures the file's defining metric
// (steps for step_daily_trend); this helper emits additional records for secondary metrics so
// callers can query them via `samsung_health_series` / aggregate them via the daily/range
// summaries the same way as primary metrics.
function rowToSecondaryRecords(sourceName: string, row: CsvRow, primary: SamsungHealthRecord | undefined): SamsungHealthRecord[] {
  if (!primary) return [];
  const extras: SamsungHealthRecord[] = [];
  // Distance: only emit from step_daily_trend. The pedometer_day_summary table holds the same
  // values for the same days and emitting from both would double-count when both files exist
  // in an export (the usual case). step_daily_trend's `distance` column is always in metres —
  // skip the magnitude-based unit guess in normalizeDistance (which would mis-classify short
  // distances like 18 m as 18 km).
  if (primary.type === "samsung_health_step_daily_trend") {
    const meters = readNumber(row, ["distance", "distance_meter", "distance_m"]);
    if (meters !== undefined && meters > 0) {
      const km = round(meters / 1000);
      if (km !== undefined && km > 0) {
        extras.push({
          ...primary,
          type: "samsung_health_distance",
          unit: "km",
          value: String(km),
          numeric_value: km
        });
      }
    }
  }
  return extras;
}

function rowToRecord(sourceName: string, row: CsvRow, binningJsons?: Map<string, string>): SamsungHealthRecord | undefined {
  const normalizedFile = normalizeKey(sourceName);
  const type = inferRecordType(normalizedFile, row);
  if (!type) return undefined;

  const startDate = bestDate(row, DATE_KEYS.start);
  const endDate = bestDate(row, DATE_KEYS.end) ?? startDate;
  const creationDate = bestDate(row, DATE_KEYS.created);
  const metric = metricForRecord(type, normalizedFile, row, startDate, endDate, binningJsons);
  if (metric.value === undefined && !startDate && !endDate) return undefined;
  let textValue: string | undefined;
  if (type === "samsung_health_sleep") {
    textValue = "asleep";
  } else if (type === "samsung_health_sleep_stage") {
    textValue = decodeSleepStage(readString(row, ["sleep_stage", "stage", "sleep_status"])) ?? "asleep";
  } else {
    textValue = metric.value === undefined ? undefined : String(metric.value);
  }

  return {
    type,
    sourceName: inferSourceName(row) ?? sourceName,
    unit: metric.unit,
    value: textValue,
    numeric_value: metric.value,
    creationDate,
    startDate,
    endDate,
    metadata: buildMetadata(row, sourceName)
  };
}

function rowToWorkout(sourceName: string, row: CsvRow): SamsungHealthWorkout | undefined {
  const normalizedFile = normalizeKey(sourceName);
  if (!normalizedFile.includes("exercise") && !normalizedFile.includes("workout")) return undefined;
  // Skip sidecar exercise tables that aren't actual workout sessions.
  if (
    normalizedFile.includes("exercise_weather") ||
    normalizedFile.includes("exercise_max_heart_rate") ||
    normalizedFile.includes("exercise_recovery_heart_rate") ||
    normalizedFile.includes("exercise_periodization")
  ) return undefined;
  const startDate = bestDate(row, DATE_KEYS.start);
  const endDate = bestDate(row, DATE_KEYS.end) ?? startDate;
  const duration = durationMinutes(row, startDate, endDate);
  const distance = readNumber(row, ["distance", "total_distance", "distance_meter", "distance_m", "distance_km"]);
  const energy = readNumber(row, ["total_calorie", "calorie", "calories", "calorie_count", "kcal", "active_calorie"]);
  const rawType = readString(row, ["exercise_type", "exercise_name", "activity_type", "workout_type"]);
  const workoutActivityType = decodeExerciseType(rawType);
  if (!startDate && duration === undefined && distance === undefined && energy === undefined) return undefined;

  return {
    workoutActivityType,
    sourceName: inferSourceName(row) ?? sourceName,
    creationDate: bestDate(row, DATE_KEYS.created),
    startDate,
    endDate,
    duration,
    durationUnit: duration === undefined ? undefined : "min",
    totalDistance: normalizeDistance(distance, row),
    totalDistanceUnit: distance === undefined ? undefined : "km",
    totalEnergyBurned: energy,
    totalEnergyBurnedUnit: energy === undefined ? undefined : "kcal",
    metadata: buildMetadata(row, sourceName)
  };
}

function inferRecordType(normalizedFile: string, row: CsvRow): string | undefined {
  // Classify strictly by filename so administrative files (badges, rewards, insight messages, etc.)
  // don't get pulled into health categories by coincidental column-name overlap.
  const f = normalizedFile;
  // Administrative / non-measurement tables
  if (f.includes("badge")) return "samsung_health_badge";
  if (f.includes("rewards")) return "samsung_health_rewards";
  if (f.includes("insight_message")) return "samsung_health_insight";
  if (f.includes("report")) return "samsung_health_report";
  if (f.includes("preferences")) return "samsung_health_preferences";
  if (f.includes("permission")) return "samsung_health_permission";
  if (f.includes("social")) return "samsung_health_social";
  if (f.includes("device_profile")) return "samsung_health_device_profile";
  if (f.includes("user_profile")) return "samsung_health_user_profile";
  if (f.includes("goal_history")) return "samsung_health_goal_history";
  if (f.includes("activity_goal")) return "samsung_health_activity_goal";
  if (f.includes("activity_level")) return "samsung_health_activity_level";
  if (f.includes("shm_device")) return "samsung_health_shm_device";
  if (f.includes("hsp_references")) return "samsung_health_hsp_references";
  if (f.includes("best_records")) return "samsung_health_best_records";
  if (f.includes("food_frequent")) return "samsung_health_food";
  if (f.includes("height")) return "samsung_health_height";
  if (f.includes("breathing")) return "samsung_health_breathing_exercise";
  // Day-summary aggregates (separate types so they don't double-count vs per-minute records)
  if (f.includes("pedometer_day_summary")) return "samsung_health_step_daily";
  if (f.includes("activity_day_summary")) return "samsung_health_activity_daily";
  if (f.includes("floors_day_summary")) return "samsung_health_floors_daily";
  if (f.includes("calories_burned")) return "samsung_health_calories_daily";
  if (f.includes("step_daily_trend")) return "samsung_health_step_daily_trend";
  // Sleep family — order matters, most specific first
  if (f.includes("sleep_combined")) return "samsung_health_sleep_combined";
  if (f.includes("sleep_apnea")) return "samsung_health_sleep_apnea";
  if (f.includes("sleep_goal")) return "samsung_health_sleep_goal";
  if (f.includes("sleep_raw_data")) return "samsung_health_sleep_raw";
  if (f.includes("sleep_snoring")) return "samsung_health_sleep_snoring";
  if (f.includes("sleep_stage")) return "samsung_health_sleep_stage";
  if (f.includes("sleep")) return "samsung_health_sleep";
  // Specialized signals
  if (f.includes("nap_data")) return "samsung_health_nap";
  if (f.includes("alerted_stress")) return "samsung_health_alerted_stress";
  if (f.includes("alerted_heart_rate")) return "samsung_health_alerted_heart_rate";
  if (f.includes("ecg")) return "samsung_health_ecg";
  if (f.includes("blood_pressure") || f.includes("calibration_blood_pressure")) return "samsung_health_blood_pressure";
  if (f.includes("vitality_score")) return "samsung_health_vitality_score";
  if (f.includes("skin_temperature") || f.includes("cycle_daily_temperature")) return "samsung_health_skin_temperature";
  if (f.includes("stress_histogram")) return "samsung_health_stress_histogram";
  if (f.includes("stress")) return "samsung_health_stress";
  if (f.includes("water_intake")) return "samsung_health_water_intake";
  if (f.includes("caffeine_intake")) return "samsung_health_caffeine_intake";
  if (f.includes("food_info")) return "samsung_health_food";
  // Vitals
  if (f.includes("resting_heart_rate")) return "samsung_health_resting_heart_rate";
  if (f.includes("hrv") || f.includes("heart_rate_variability")) return "samsung_health_hrv";
  if (f.includes("tracker_heart_rate") || f.includes("heart_rate")) return "samsung_health_heart_rate";
  if (f.includes("oxygen_saturation") || f.includes("spo2") || f.includes("saturation")) return "samsung_health_oxygen_saturation";
  if (f.includes("respiratory_rate")) return "samsung_health_respiratory_rate";
  // Activity
  if (f.includes("body_fat")) return "samsung_health_body_fat";
  if (f.includes("weight")) return "samsung_health_body_weight";
  if (f.includes("step")) return "samsung_health_steps";
  if (f.includes("distance")) return "samsung_health_distance";
  if (f.includes("calorie") || f.includes("energy")) return "samsung_health_active_energy";
  if (f.includes("movement")) return "samsung_health_movement";
  if (f.includes("floors") || f.includes("floor_count")) return "samsung_health_floors_climbed";
  // Fallback: classify generically
  if (Object.keys(row).length > 0 && f.includes("samsung")) return `samsung_health_${safeTypeFromFile(f)}`;
  return undefined;
}

function metricForRecord(type: string, normalizedFile: string, row: CsvRow, startDate?: string, endDate?: string, binningJsons?: Map<string, string>): { value?: number; unit?: string } {
  switch (type) {
    case "samsung_health_steps":
      return { value: readNumber(row, ["step_count", "count", "steps", "value"]), unit: "count" };
    case "samsung_health_step_daily":
    case "samsung_health_step_daily_trend":
      return { value: readNumber(row, ["step_count", "count", "steps", "value"]), unit: "count" };
    case "samsung_health_activity_daily":
      return { value: readNumber(row, ["step_count", "count", "steps"]), unit: "count" };
    case "samsung_health_floors_daily":
      return { value: readNumber(row, ["floor_count", "floors", "count"]), unit: "count" };
    case "samsung_health_calories_daily":
      return { value: readNumber(row, ["total_calorie", "active_calorie", "rest_calorie", "calorie"]), unit: "kcal" };
    case "samsung_health_heart_rate":
      return { value: readNumber(row, ["heart_rate", "bpm", "rate", "average", "mean", "value"]), unit: "bpm" };
    case "samsung_health_alerted_heart_rate":
      return { value: readNumber(row, ["heart_rate", "bpm", "max", "min", "value"]), unit: "bpm" };
    case "samsung_health_resting_heart_rate":
      return { value: readNumber(row, ["resting_heart_rate", "resting_hr", "heart_rate", "bpm", "value"]), unit: "bpm" };
    case "samsung_health_hrv": {
      // Recent Samsung exports keep HRV values in JSON sidecar files referenced from the CSV's
      // `binning_data` column; the CSV itself only carries timing + the JSON filename. Try
      // direct CSV columns first (older exports / future formats) and fall back to averaging
      // RMSSD across the bins in the sidecar JSON.
      const direct = readNumber(row, ["rmssd", "sdnn", "hrv", "average", "value"]);
      if (direct !== undefined) return { value: direct, unit: "ms" };
      const binningFile = readString(row, ["binning_data"]);
      if (binningFile && binningJsons) {
        const avg = averageRmssdFromBinning(binningJsons.get(binningFile));
        if (avg !== undefined) return { value: avg, unit: "ms" };
      }
      return { value: undefined, unit: "ms" };
    }
    case "samsung_health_oxygen_saturation":
      return { value: readNumber(row, ["spo2", "oxygen_saturation", "saturation", "average", "min", "value"]), unit: "%" };
    case "samsung_health_respiratory_rate":
      return { value: readNumber(row, ["respiratory_rate", "breathing_rate", "average", "value"]), unit: "breaths/min" };
    case "samsung_health_body_weight":
      return { value: readNumber(row, ["weight", "body_weight", "value"]), unit: readString(row, ["unit"]) ?? "kg" };
    case "samsung_health_body_fat":
      return { value: readNumber(row, ["body_fat", "body_fat_percentage", "fat", "value"]), unit: "%" };
    case "samsung_health_distance":
      return { value: normalizeDistance(readNumber(row, ["distance", "distance_meter", "distance_m", "distance_km", "value"]), row), unit: "km" };
    case "samsung_health_active_energy":
      return { value: readNumber(row, ["calorie", "calories", "calorie_count", "kcal", "value"]), unit: "kcal" };
    case "samsung_health_movement":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_floors_climbed":
      return { value: readNumber(row, ["floor", "floor_count", "floors", "count", "value"]), unit: "count" };
    case "samsung_health_height":
      return { value: readNumber(row, ["height", "value"]), unit: readString(row, ["unit"]) ?? "cm" };
    case "samsung_health_sleep":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_sleep_stage":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_sleep_combined":
      return { value: readNumber(row, ["sleep_score", "score", "total_score", "value"]), unit: "score" };
    case "samsung_health_sleep_apnea":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_sleep_snoring":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_sleep_goal":
      return { value: readNumber(row, ["sleep_time", "sleep_minutes", "value"]), unit: "min" };
    case "samsung_health_breathing_exercise":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_stress_histogram":
      return { value: readNumber(row, ["base_hr", "value"]), unit: "bpm" };
    case "samsung_health_stress":
      return { value: readNumber(row, ["score", "stress", "average", "value"]), unit: "score" };
    case "samsung_health_alerted_stress":
      return { value: readNumber(row, ["score", "stress", "max", "value"]), unit: "score" };
    case "samsung_health_skin_temperature":
      return { value: readNumber(row, ["temperature", "skin_temperature", "average", "value"]), unit: "°C" };
    case "samsung_health_ecg":
      return { value: readNumber(row, ["mean_heart_rate", "heart_rate", "bpm"]), unit: "bpm" };
    case "samsung_health_blood_pressure":
      return { value: readNumber(row, ["systolic", "value"]), unit: "mmHg" };
    case "samsung_health_vitality_score":
      return { value: readNumber(row, ["total_score", "score", "activity_score", "sleep_score", "value"]), unit: "score" };
    case "samsung_health_nap":
      return { value: durationMinutes(row, startDate, endDate), unit: "min" };
    case "samsung_health_water_intake":
      return { value: readNumber(row, ["amount", "volume", "value"]), unit: "ml" };
    case "samsung_health_caffeine_intake":
      return { value: readNumber(row, ["amount", "caffeine", "value"]), unit: "mg" };
    case "samsung_health_food":
      return { value: readNumber(row, ["calorie", "kcal", "calories"]), unit: "kcal" };
    default:
      return { value: firstUsefulNumber(row), unit: readString(row, ["unit"]) ?? normalizedFile };
  }
}

function overlaps(startValue: string | undefined, endValue: string | undefined, start?: Date, end?: Date): boolean {
  if (!start && !end) return true;
  const itemStart = parseSamsungDate(startValue);
  const itemEnd = parseSamsungDate(endValue) ?? itemStart;
  if (!itemStart && !itemEnd) return false;
  if (start && itemEnd && itemEnd < start) return false;
  if (end && itemStart && itemStart > end) return false;
  return true;
}

function normalizeLimit(value: number | undefined): number {
  if (!value || Number.isNaN(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

// Only load JSON sidecars whose path indicates they're HRV bins — that's the one record type
// whose numeric value lives outside the CSV. Other types (heart_rate, oxygen_saturation, etc.)
// also have JSON sidecars but we don't need them, and loading them would cost ~400 MB on a
// typical multi-year export. The check matches both nested-original-zip paths
// (`jsons/com.samsung.health.hrv/5/<uuid>.binning_data.json`) and flat extracts where the
// user re-archives JSONs alongside CSVs.
function isHrvBinningPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".binning_data.json")) return false;
  return lower.includes("com.samsung.health.hrv");
}

async function readExportSources(location: ExportLocation): Promise<ExportSources> {
  if (location.kind === "csv" && location.resolved_path) {
    return {
      csv: [{
        name: basename(location.resolved_path),
        text: await fs.readFile(location.resolved_path, "utf8"),
        size_bytes: location.size_bytes,
        modified_at: location.modified_at
      }],
      binningJsons: new Map()
    };
  }
  if (location.kind === "directory" && location.resolved_path) return readDirectoryExportSources(location.resolved_path);
  if (location.kind === "zip" && location.resolved_path) return readZipExportSources(location.resolved_path);
  throw new Error(location.note ?? "Unsupported Samsung Health export location.");
}

async function readDirectoryExportSources(root: string): Promise<ExportSources> {
  const all = await listExportFiles(root);
  const csv: CsvSource[] = [];
  const binningJsons = new Map<string, string>();
  await Promise.all(all.map(async (file) => {
    const lower = file.toLowerCase();
    if (lower.endsWith(".csv")) {
      const stat = await fs.stat(file);
      csv.push({
        name: file.slice(root.length + 1),
        text: await fs.readFile(file, "utf8"),
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString()
      });
    } else if (isHrvBinningPath(file)) {
      binningJsons.set(basename(file), await fs.readFile(file, "utf8"));
    }
  }));
  return { csv, binningJsons };
}

function readZipExportSources(zipPath: string): Promise<ExportSources> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error("Unable to open Samsung Health export zip."));
        return;
      }
      const csv: CsvSource[] = [];
      const binningJsons = new Map<string, string>();
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        const name = entry.fileName.replace(/\\/g, "/");
        if (/\/$/.test(name)) { zipfile.readEntry(); return; }
        const lower = name.toLowerCase();
        const isCsv = lower.endsWith(".csv");
        const isHrvJson = isHrvBinningPath(name);
        if (!isCsv && !isHrvJson) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipfile.close();
            reject(streamError ?? new Error(`Unable to read ${name} from zip.`));
            return;
          }
          streamToString(stream).then((text) => {
            if (isCsv) csv.push({ name, text, size_bytes: entry.uncompressedSize });
            else binningJsons.set(basename(name), text);
            zipfile.readEntry();
          }, (error) => {
            zipfile.close();
            reject(error);
          });
        });
      });
      zipfile.on("end", () => {
        zipfile.close();
        csv.sort((left, right) => left.name.localeCompare(right.name));
        resolvePromise({ csv, binningJsons });
      });
      zipfile.on("error", reject);
    });
  });
}

async function countCsvFiles(root: string): Promise<number> {
  return (await listCsvFiles(root)).length;
}

async function listCsvFiles(root: string): Promise<string[]> {
  return (await listExportFiles(root)).filter((f) => f.toLowerCase().endsWith(".csv"));
}

async function listExportFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath, depth + 1);
      else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".csv") || lower.endsWith(".binning_data.json")) files.push(fullPath);
      }
    }
  }
  await visit(root, 0);
  return files.sort();
}

function countZipCsvEntries(zipPath: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error("Unable to open Samsung Health export zip."));
        return;
      }
      let count = 0;
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        const name = entry.fileName.replace(/\\/g, "/").toLowerCase();
        if (name.endsWith(".csv") && !name.endsWith("/")) count += 1;
        zipfile.readEntry();
      });
      zipfile.on("end", () => {
        zipfile.close();
        resolvePromise(count);
      });
      zipfile.on("error", reject);
    });
  });
}

function parseCsv(text: string): CsvRow[] {
  const trimmed = text.replace(/^\uFEFF/, "");
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field.trim());
  rows.push(row);

  let headerIndex = rows.findIndex((candidate) => candidate.some(Boolean));
  if (headerIndex < 0) return [];
  let headerRow = rows[headerIndex];
  // Samsung Health "personal data" CSVs prefix files with a metadata line:
  //   com.samsung.X.Y,<version>,<revision>
  // followed by the real column-header row. Detect and skip.
  if (
    headerRow.length <= 3 &&
    /^com\.samsung\./i.test((headerRow[0] ?? "").trim())
  ) {
    const remainder = rows.slice(headerIndex + 1);
    const nextOffset = remainder.findIndex((candidate) => candidate.some(Boolean));
    if (nextOffset >= 0) {
      headerIndex = headerIndex + 1 + nextOffset;
      headerRow = rows[headerIndex];
    }
  }
  const headers = headerRow.map((value, index) => value || `column_${index + 1}`);
  return rows.slice(headerIndex + 1)
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function detectDelimiter(line: string): "," | ";" | "\t" {
  const counts = {
    ",": (line.match(/,/g) ?? []).length,
    ";": (line.match(/;/g) ?? []).length,
    "\t": (line.match(/\t/g) ?? []).length
  };
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] as "," | ";" | "\t" ?? ",";
}

function bestDate(row: CsvRow, aliases: string[]): string | undefined {
  const entry = findEntry(row, aliases);
  if (!entry) return undefined;
  const [key, rawValue] = entry;
  const value = rawValue?.trim();
  if (!value) return undefined;
  const offset = readString(row, ["time_offset"]);
  // Samsung's per-day aggregate tables (pedometer_day_summary, step_daily_trend,
  // activity.day_summary, floors_day_summary, calories_burned.details) key rows by a `day_time`
  // column that has no `time_offset` counterpart and that Samsung populates as if local midnight
  // == UTC midnight. Without compensation, every row buckets into the previous calendar day for
  // users west of UTC. The value comes in three flavours across the export:
  //   - numeric ms ("1779235200000")          — step_daily_trend, pedometer_day_summary, floors_day_summary
  //   - prefixed numeric                       — calories_burned.details (column: com.samsung.shealth.calories_burned.day_time)
  //   - naive date string ("2026-05-20 00:00:00.000") — activity.day_summary
  // Anchor any of those at noon UTC of the inferred calendar day so the record lands in the
  // correct bucket in every reasonable user timezone (UTC-12 through UTC+12).
  const normalizedKey = normalizeKey(key);
  const isDayTimeField = normalizedKey === "day_time" || normalizedKey.endsWith("_day_time");
  if (isDayTimeField) {
    const dayIso = parseDayTimeToNoon(value);
    if (dayIso) return dayIso;
  }
  const combined = combineDateAndOffset(value, offset);
  const parsed = parseSamsungDate(combined);
  return parsed?.toISOString();
}

// Resolve a Samsung `day_time` value (numeric ms or "YYYY-MM-DD HH:MM:SS.SSS" string)
// to noon UTC of the represented calendar day. Returns undefined when the value is unrecognised
// so the caller can fall back to the standard date-parsing path.
function parseDayTimeToNoon(value: string): string | undefined {
  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 946_684_800_000) {
      // Use the calendar day of the naive UTC interpretation (not stored-ms + 12h directly,
      // so DST edges don't drift the date) and anchor at noon UTC.
      const dayUtc = new Date(ms);
      if (!Number.isNaN(dayUtc.getTime())) {
        const anchored = new Date(Date.UTC(dayUtc.getUTCFullYear(), dayUtc.getUTCMonth(), dayUtc.getUTCDate(), 12, 0, 0, 0));
        return anchored.toISOString();
      }
    }
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(value);
  if (match) {
    const anchored = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0));
    if (!Number.isNaN(anchored.getTime()) && anchored.getTime() > 946_684_800_000) return anchored.toISOString();
  }
  return undefined;
}

function combineDateAndOffset(value: string | undefined, offset: string | undefined): string | undefined {
  if (!value) return value;
  const trimmed = value.trim();
  if (!offset || /^\d+(\.\d+)?$/.test(trimmed)) return value;
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(trimmed)) return value;
  const offsetMatch = /^UTC([+-])(\d{2}):?(\d{2})?$/i.exec(offset.trim());
  if (!offsetMatch) return value;
  const sign = offsetMatch[1];
  const hh = offsetMatch[2];
  const mm = offsetMatch[3] ?? "00";
  const isoBase = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  return `${isoBase}${sign}${hh}:${mm}`;
}

function readString(row: CsvRow, aliases: string[]): string | undefined {
  const entry = findEntry(row, aliases);
  const value = entry?.[1]?.trim();
  return value ? value : undefined;
}

function readNumber(row: CsvRow, aliases: string[]): number | undefined {
  const value = readString(row, aliases);
  return parseNumber(value);
}

function findEntry(row: CsvRow, aliases: string[]): [string, string] | undefined {
  const normalizedAliases = aliases.map(normalizeKey);
  const entries = Object.entries(row).filter(([, value]) => value?.trim());
  // Priority: exact match > endsWith(_alias) > includes(alias). Within each tier, alias order wins.
  for (const alias of normalizedAliases) {
    const hit = entries.find(([key]) => normalizeKey(key) === alias);
    if (hit) return hit;
  }
  for (const alias of normalizedAliases) {
    const hit = entries.find(([key]) => normalizeKey(key).endsWith(`_${alias}`));
    if (hit) return hit;
  }
  for (const alias of normalizedAliases) {
    const hit = entries.find(([key]) => normalizeKey(key).includes(alias));
    if (hit) return hit;
  }
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized || /^(null|nan|none|unknown)$/i.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstUsefulNumber(row: CsvRow): number | undefined {
  for (const [key, value] of Object.entries(row)) {
    if (DATE_KEYS.start.concat(DATE_KEYS.end, DATE_KEYS.created).some((alias) => normalizeKey(key).includes(alias))) continue;
    const parsed = parseNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function durationMinutes(row: CsvRow, startDate?: string, endDate?: string): number | undefined {
  const explicit = readNumber(row, ["duration", "duration_ms", "duration_millis", "elapsed_time", "sleep_duration", "time"]);
  if (explicit !== undefined) {
    if (explicit > 100_000) return round(explicit / 60_000);
    if (explicit > 1_000) return round(explicit / 60);
    return round(explicit);
  }
  const start = parseSamsungDate(startDate);
  const end = parseSamsungDate(endDate);
  if (!start || !end) return undefined;
  return round(Math.max(0, end.getTime() - start.getTime()) / 60_000);
}

// Each HRV binning JSON is an array of ~30-second bins like:
//   [{ "start_time": …, "end_time": …, "sdnn": 17.27, "rmssd": 20.74 }, …]
// Average RMSSD across the bins is what most HRV summaries (Whoop, Garmin, Oura) report.
function averageRmssdFromBinning(rawJson: string | undefined): number | undefined {
  if (!rawJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const values: number[] = [];
  for (const bin of parsed) {
    if (bin && typeof bin === "object") {
      const v = (bin as Record<string, unknown>).rmssd;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) values.push(n);
    }
  }
  if (values.length === 0) return undefined;
  return round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function normalizeDistance(value: number | undefined, row: CsvRow): number | undefined {
  if (value === undefined) return undefined;
  const unit = readString(row, ["distance_unit", "unit"])?.toLowerCase();
  if (unit?.includes("mile")) return round(value * 1.609344);
  if (unit?.includes("meter") || unit === "m" || value > 100) return round(value / 1000);
  return round(value);
}

function inferSourceName(row: CsvRow): string | undefined {
  return readString(row, ["source", "source_name", "device", "device_name", "pkg_name", "package_name"]);
}

// Samsung Health exercise_type numeric codes (best-effort; codes vary across SDK versions).
const EXERCISE_TYPE_NAMES: Record<string, string> = {
  "0": "free_exercise",
  "1001": "walking",
  "1002": "running",
  "2001": "baseball",
  "3001": "softball",
  "4001": "cricket",
  "5001": "golf",
  "6001": "billiards",
  "7001": "bowling",
  "8001": "fencing",
  "9001": "ice_hockey",
  "10001": "field_hockey",
  "11001": "rugby",
  "12001": "basketball",
  "13001": "soccer",
  "14001": "hiking",
  "15001": "handball",
  "16001": "american_football",
  "11007": "cycling",
  "13150": "weight_machine",
  "14001_alt": "hiking"
};

// Samsung Health sleep stage codes per the SDK enum: AWAKE/LIGHT/DEEP/REM.
// 0 is the legacy "asleep" marker from before per-stage tracking existed.
const SLEEP_STAGE_NAMES: Record<string, string> = {
  "0": "asleep",
  "40001": "awake",
  "40002": "light",
  "40003": "deep",
  "40004": "rem"
};

function decodeSleepStage(value: string | undefined): string | undefined {
  if (!value) return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return SLEEP_STAGE_NAMES[trimmed] ?? trimmed;
}

function decodeExerciseType(value: string | undefined): string {
  if (!value) return "exercise";
  const trimmed = value.trim();
  if (!trimmed) return "exercise";
  if (!/^\d+$/.test(trimmed)) return trimmed.toLowerCase();
  const mapped = EXERCISE_TYPE_NAMES[trimmed];
  return mapped ?? `samsung_exercise_${trimmed}`;
}

function buildMetadata(row: CsvRow, sourceName: string): Record<string, string> {
  const metadata: Record<string, string> = { source_file: sourceName };
  for (const [key, value] of Object.entries(row)) {
    if (!value) continue;
    metadata[key] = value;
  }
  return metadata;
}

function safeTypeFromFile(normalizedFile: string): string {
  return normalizedFile
    .replace(/^.*com_samsung_(shealth|health)_?/, "")
    .replace(/_csv$/, "")
    .replace(/_\d{8,}$/, "")
    .split("_")
    .filter(Boolean)
    .slice(0, 4)
    .join("_") || "record";
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.csv$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function snapshotCacheKey(location: ExportLocation, query: SnapshotQuery): string {
  return [
    location.resolved_path ?? location.input_path ?? "unknown",
    location.size_bytes ?? 0,
    location.mtime_ms ?? 0,
    location.csv_count ?? 0,
    query.start ?? "",
    query.end ?? ""
  ].join("|");
}

function cacheSnapshot(key: string, snapshot: SamsungHealthSnapshot): void {
  SNAPSHOT_CACHE.set(key, snapshot);
  while (SNAPSHOT_CACHE.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
    const oldest = SNAPSHOT_CACHE.keys().next().value;
    if (!oldest) break;
    SNAPSHOT_CACHE.delete(oldest);
  }
}

function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
  });
}

function round(value: number | undefined): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Math.round(value * 100) / 100;
}
