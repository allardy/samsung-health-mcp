import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listRecords,
  listWorkouts,
  parseSamsungDate,
  recordOverlaps
} from "../src/services/samsung-health-export.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "samsung-health-test-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeCsv(filename: string, body: string): Promise<void> {
  await writeFile(join(workspace, filename), body, "utf8");
}

// Samsung's CSV exports always begin with a metadata line:
//   com.samsung.shealth.<table>,<version>,<revision>
// followed by the actual column header line.
function samsungCsv(table: string, header: string[], rows: string[][]): string {
  return [
    `com.samsung.shealth.${table},1,1`,
    header.join(","),
    ...rows.map((row) => row.join(","))
  ].join("\n");
}

// ─── parseSamsungDate ──────────────────────────────────────────────────────────

describe("parseSamsungDate", () => {
  it("returns undefined for the legacy '0' epoch sentinel", () => {
    expect(parseSamsungDate("0")).toBeUndefined();
  });

  it("returns undefined for pre-2000 numeric timestamps", () => {
    // Version numbers like 58685730 appear in date columns; any epoch < year-2000 is rejected.
    expect(parseSamsungDate("58685730")).toBeUndefined();
  });

  it("returns undefined for undefined / empty string", () => {
    expect(parseSamsungDate(undefined)).toBeUndefined();
    expect(parseSamsungDate("")).toBeUndefined();
    expect(parseSamsungDate("   ")).toBeUndefined();
  });

  it("parses a naive Samsung datetime as UTC", () => {
    const parsed = parseSamsungDate("2026-04-17 04:41:00.000");
    expect(parsed?.toISOString()).toBe("2026-04-17T04:41:00.000Z");
  });

  it("parses a millisecond epoch", () => {
    const parsed = parseSamsungDate("1747000000000");
    expect(parsed?.toISOString()).toBe("2025-05-11T21:46:40.000Z");
  });

  it("disambiguates seconds vs milliseconds: values ≤ 10 000 000 000 are multiplied by 1000", () => {
    // 1 700 000 000 < 10^10 → treated as seconds → × 1000 = same ms as the explicit ms form.
    const fromSeconds = parseSamsungDate("1700000000");
    const fromMs      = parseSamsungDate("1700000000000");
    // Both should resolve to the same point in time: 2023-11-14T22:13:20.000Z.
    expect(fromSeconds?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(fromMs?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("parses an ISO offset string and converts to UTC", () => {
    const parsed = parseSamsungDate("2026-04-17T04:41:00.000-04:00");
    expect(parsed?.toISOString()).toBe("2026-04-17T08:41:00.000Z");
  });

  it("parses a slash-delimited date", () => {
    const parsed = parseSamsungDate("2026/05/20");
    expect(parsed?.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("returns undefined for a date clearly before year 2000", () => {
    expect(parseSamsungDate("1999-12-31")).toBeUndefined();
  });
});

// ─── recordOverlaps ────────────────────────────────────────────────────────────

describe("recordOverlaps", () => {
  const makeDate = (iso: string) => new Date(iso);

  it("always returns true when no window bounds are supplied", () => {
    expect(recordOverlaps("2026-05-20T08:00:00.000Z", "2026-05-20T08:01:00.000Z")).toBe(true);
  });

  it("returns true for a record fully inside the window", () => {
    expect(recordOverlaps(
      "2026-05-20T08:00:00.000Z",
      "2026-05-20T08:01:00.000Z",
      makeDate("2026-05-20T00:00:00.000Z"),
      makeDate("2026-05-20T23:59:59.999Z")
    )).toBe(true);
  });

  it("returns true for a record that straddles the window start", () => {
    expect(recordOverlaps(
      "2026-05-19T22:00:00.000Z",
      "2026-05-20T06:00:00.000Z",
      makeDate("2026-05-20T00:00:00.000Z"),
      makeDate("2026-05-20T23:59:59.999Z")
    )).toBe(true);
  });

  it("returns true for a record that straddles the window end", () => {
    expect(recordOverlaps(
      "2026-05-20T22:00:00.000Z",
      "2026-05-21T06:00:00.000Z",
      makeDate("2026-05-20T00:00:00.000Z"),
      makeDate("2026-05-20T23:59:59.999Z")
    )).toBe(true);
  });

  it("returns false for a record entirely before the window", () => {
    expect(recordOverlaps(
      "2026-05-19T06:00:00.000Z",
      "2026-05-19T07:00:00.000Z",
      makeDate("2026-05-20T00:00:00.000Z"),
      makeDate("2026-05-20T23:59:59.999Z")
    )).toBe(false);
  });

  it("returns false for a record entirely after the window", () => {
    expect(recordOverlaps(
      "2026-05-21T06:00:00.000Z",
      "2026-05-21T07:00:00.000Z",
      makeDate("2026-05-20T00:00:00.000Z"),
      makeDate("2026-05-20T23:59:59.999Z")
    )).toBe(false);
  });

  it("returns false when both record dates are missing", () => {
    expect(recordOverlaps(
      undefined,
      undefined,
      makeDate("2026-05-20T00:00:00.000Z"),
      makeDate("2026-05-20T23:59:59.999Z")
    )).toBe(false);
  });
});

// ─── parseCsv (via listRecords) ────────────────────────────────────────────────

describe("parseCsv: Samsung 2-line metadata header", () => {
  it("skips the com.samsung.* metadata line and parses real rows", async () => {
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["start_time", "heart_rate", "end_time", "time_offset"],
      [
        ["2026-05-20 08:00:00.000", "72", "2026-05-20 08:00:30.000", "UTC+0200"],
        ["2026-05-20 08:01:00.000", "75", "2026-05-20 08:01:30.000", "UTC+0200"]
      ]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const records = await listRecords({ exportPath: workspace, limit: 10 });
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe("samsung_health_heart_rate");
    expect(records[0].numeric_value).toBe(72);
    expect(records[1].numeric_value).toBe(75);
  });

  it("parses correctly when there is no metadata prefix", async () => {
    const csv = [
      "start_time,heart_rate,end_time",
      "2026-05-20 08:00:00.000,72,2026-05-20 08:00:30.000"
    ].join("\n");
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const records = await listRecords({ exportPath: workspace, limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0].numeric_value).toBe(72);
  });

  it("strips a UTF-8 BOM without corrupting the header", async () => {
    const csv = "﻿" + [
      "start_time,heart_rate,end_time",
      "2026-05-20 08:00:00.000,80,2026-05-20 08:00:30.000"
    ].join("\n");
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.numeric_value).toBe(80);
  });

  it("handles Windows-style CRLF line endings", async () => {
    const csv = "start_time,heart_rate,end_time\r\n2026-05-20 08:00:00.000,77,2026-05-20 08:00:30.000\r\n";
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.numeric_value).toBe(77);
  });

  it("parses quoted fields with embedded commas", async () => {
    const csv = [
      "start_time,heart_rate,note",
      '2026-05-20 08:00:00.000,72,"easy, rested"'
    ].join("\n");
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.numeric_value).toBe(72);
  });

  it("returns empty array for a header-only CSV with no data rows", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      "start_time,heart_rate,end_time\n"
    );
    const records = await listRecords({ exportPath: workspace, limit: 10 });
    expect(records).toHaveLength(0);
  });
});

// ─── filename with date-stamp suffix ──────────────────────────────────────────

describe("filename date-stamp stripping", () => {
  it("still classifies heart_rate when the filename has an 8+ digit timestamp suffix", async () => {
    // Samsung sometimes appends export timestamps: com.samsung.shealth.tracker.heart_rate.20260521094693.csv
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["start_time", "heart_rate", "end_time"],
      [["2026-05-20 08:00:00.000", "72", "2026-05-20 08:00:30.000"]]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.20260521094693.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.type).toBe("samsung_health_heart_rate");
  });

  it("still classifies sleep_stage when the filename has a date stamp", async () => {
    const csv = samsungCsv(
      "sleep_stage",
      ["start_time", "end_time", "stage"],
      [["2026-05-20 23:00:00.000", "2026-05-20 23:30:00.000", "40002"]]
    );
    await writeCsv("com.samsung.shealth.sleep_stage.20260521094693.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.type).toBe("samsung_health_sleep_stage");
  });
});

// ─── findEntry alias priority ──────────────────────────────────────────────────

describe("findEntry alias priority", () => {
  it("exact column 'heart_rate' wins over a substring match in 'create_sh_ver'", async () => {
    // Regression: loose includes() on "heart_rate" alias matched "create_sh_ver", returning
    // the build version number (58685730) as the HR value.
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["create_sh_ver", "start_time", "heart_rate", "end_time"],
      [["58685730", "2026-05-20 08:00:00.000", "72", "2026-05-20 08:00:30.000"]]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.numeric_value).toBe(72);
    expect(record.numeric_value).not.toBe(58685730);
  });

  it("endsWith tier: col 'com_heart_rate' is preferred over unrelated 'version_hr_flag'", async () => {
    // 'com_heart_rate' ends with '_heart_rate'; 'version_hr_flag' only contains 'r' loosely.
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["version_hr_flag", "start_time", "com_heart_rate", "end_time"],
      [["1", "2026-05-20 08:00:00.000", "85", "2026-05-20 08:00:30.000"]]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.numeric_value).toBe(85);
  });
});

// ─── time_offset combination ───────────────────────────────────────────────────

describe("time_offset combination", () => {
  it("shifts a naive timestamp using UTC-0400", async () => {
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["start_time", "heart_rate", "end_time", "time_offset"],
      [["2026-04-17 04:41:00.000", "80", "2026-04-17 04:41:30.000", "UTC-0400"]]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    // local 04:41 at UTC-4 == 08:41Z
    expect(record.startDate).toBe("2026-04-17T08:41:00.000Z");
  });

  it("shifts a naive timestamp using UTC+0200", async () => {
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["start_time", "heart_rate", "end_time", "time_offset"],
      [["2026-05-20 10:00:00.000", "65", "2026-05-20 10:00:30.000", "UTC+0200"]]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    // local 10:00 at UTC+2 == 08:00Z
    expect(record.startDate).toBe("2026-05-20T08:00:00.000Z");
  });

  it("leaves an already-offset timestamp unchanged", async () => {
    // If the value already has a timezone suffix, combineDateAndOffset must not re-apply.
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["start_time", "heart_rate", "end_time", "time_offset"],
      [["2026-05-20T08:00:00.000Z", "65", "2026-05-20T08:00:30.000Z", "UTC+0200"]]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.startDate).toBe("2026-05-20T08:00:00.000Z");
  });
});

// ─── inferRecordType: filename-based, ordering ────────────────────────────────

describe("inferRecordType is strictly filename-based", () => {
  it("badge file with stage-like columns is never classified as sleep", async () => {
    const csv = samsungCsv(
      "badge",
      ["stage", "start_time", "end_time"],
      [["40002", "2026-05-20 22:00:00.000", "2026-05-20 22:01:00.000"]]
    );
    await writeCsv("com.samsung.shealth.badge.csv", csv);

    const records = await listRecords({ exportPath: workspace, limit: 10 });
    for (const record of records) {
      expect(record.type).not.toBe("samsung_health_sleep");
      expect(record.type).not.toBe("samsung_health_sleep_stage");
    }
  });

  it("sleep_combined.csv is not classified as plain sleep", async () => {
    const csv = samsungCsv(
      "sleep_combined",
      ["start_time", "end_time"],
      [["2026-05-20 00:00:00.000", "2026-05-20 08:00:00.000"]]
    );
    await writeCsv("com.samsung.shealth.sleep_combined.csv", csv);

    const records = await listRecords({ exportPath: workspace, limit: 10 });
    for (const record of records) {
      expect(record.type).not.toBe("samsung_health_sleep");
    }
  });

  it("resting_heart_rate.csv is not classified as plain heart_rate", async () => {
    const csv = samsungCsv(
      "resting_heart_rate",
      ["start_time", "resting_heart_rate", "end_time"],
      [["2026-05-20 08:00:00.000", "58", "2026-05-20 08:00:30.000"]]
    );
    await writeCsv("com.samsung.shealth.resting_heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.type).toBe("samsung_health_resting_heart_rate");
    expect(record.type).not.toBe("samsung_health_heart_rate");
  });

  it("hrv.csv is not classified as heart_rate", async () => {
    const csv = samsungCsv(
      "hrv",
      ["start_time", "end_time", "sdnn"],
      [["2026-05-20 08:00:00.000", "2026-05-20 08:05:00.000", "42"]]
    );
    await writeCsv("com.samsung.shealth.hrv.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.type).toBe("samsung_health_hrv");
  });

  it("alerted_heart_rate.csv is not classified as plain heart_rate", async () => {
    const csv = samsungCsv(
      "alerted_heart_rate",
      ["start_time", "heart_rate", "end_time"],
      [["2026-05-20 08:00:00.000", "120", "2026-05-20 08:00:30.000"]]
    );
    await writeCsv("com.samsung.shealth.alerted_heart_rate.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.type).toBe("samsung_health_alerted_heart_rate");
    expect(record.type).not.toBe("samsung_health_heart_rate");
  });

  it("stress.csv with score column is classified as samsung_health_stress", async () => {
    const csv = samsungCsv(
      "stress",
      ["start_time", "score", "end_time"],
      [["2026-05-20 10:00:00.000", "45", "2026-05-20 10:05:00.000"]]
    );
    await writeCsv("com.samsung.shealth.stress.csv", csv);

    const [record] = await listRecords({ exportPath: workspace, limit: 10 });
    expect(record.type).toBe("samsung_health_stress");
    expect(record.numeric_value).toBe(45);
  });
});

// ─── sleep_stage decoding ──────────────────────────────────────────────────────

describe("sleep_stage decoding (Samsung SDK codes)", () => {
  it("decodes 40001=awake, 40002=light, 40003=deep, 40004=rem", async () => {
    const csv = samsungCsv(
      "sleep_stage",
      ["start_time", "end_time", "stage"],
      [
        ["2026-05-20 23:00:00.000", "2026-05-20 23:30:00.000", "40001"],
        ["2026-05-20 23:30:00.000", "2026-05-21 00:00:00.000", "40002"],
        ["2026-05-21 00:00:00.000", "2026-05-21 00:30:00.000", "40003"],
        ["2026-05-21 00:30:00.000", "2026-05-21 01:00:00.000", "40004"]
      ]
    );
    await writeCsv("com.samsung.shealth.sleep_stage.csv", csv);

    const records = await listRecords({
      exportPath: workspace,
      type: "samsung_health_sleep_stage",
      limit: 10
    });
    expect(records.map((r) => r.value)).toEqual(["awake", "light", "deep", "rem"]);
  });

  it("decodes legacy code 0 as 'asleep'", async () => {
    const csv = samsungCsv(
      "sleep_stage",
      ["start_time", "end_time", "stage"],
      [["2026-05-20 23:00:00.000", "2026-05-21 06:00:00.000", "0"]]
    );
    await writeCsv("com.samsung.shealth.sleep_stage.csv", csv);

    const [record] = await listRecords({
      exportPath: workspace,
      type: "samsung_health_sleep_stage",
      limit: 10
    });
    expect(record.value).toBe("asleep");
  });

  it("numeric_value for a stage record is the segment duration in minutes", async () => {
    const csv = samsungCsv(
      "sleep_stage",
      ["start_time", "end_time", "stage"],
      [["2026-05-20 23:00:00.000", "2026-05-21 00:00:00.000", "40003"]] // 60 min
    );
    await writeCsv("com.samsung.shealth.sleep_stage.csv", csv);

    const [record] = await listRecords({
      exportPath: workspace,
      type: "samsung_health_sleep_stage",
      limit: 10
    });
    expect(record.numeric_value).toBe(60);
    expect(record.unit).toBe("min");
  });
});

// ─── metricForRecord: various types ───────────────────────────────────────────

describe("metricForRecord: correct metric extracted per record type", () => {
  it("step_daily extracts step_count", async () => {
    const csv = samsungCsv(
      "pedometer_day_summary",
      ["start_time", "end_time", "step_count"],
      [["2026-05-20 00:00:00.000", "2026-05-20 23:59:59.000", "8421"]]
    );
    await writeCsv("com.samsung.shealth.pedometer_day_summary.csv", csv);

    const [record] = await listRecords({
      exportPath: workspace,
      type: "samsung_health_step_daily",
      limit: 10
    });
    expect(record.numeric_value).toBe(8421);
    expect(record.unit).toBe("count");
  });

  it("oxygen_saturation extracts spo2 value", async () => {
    const csv = samsungCsv(
      "oxygen_saturation",
      ["start_time", "end_time", "spo2"],
      [["2026-05-20 08:00:00.000", "2026-05-20 08:05:00.000", "97"]]
    );
    await writeCsv("com.samsung.shealth.oxygen_saturation.csv", csv);

    const [record] = await listRecords({
      exportPath: workspace,
      type: "samsung_health_oxygen_saturation",
      limit: 10
    });
    expect(record.numeric_value).toBe(97);
    expect(record.unit).toBe("%");
  });

  it("body_weight extracts weight", async () => {
    const csv = samsungCsv(
      "weight",
      ["start_time", "weight", "end_time"],
      [["2026-05-20 08:00:00.000", "74.5", "2026-05-20 08:00:01.000"]]
    );
    await writeCsv("com.samsung.shealth.weight.csv", csv);

    const [record] = await listRecords({
      exportPath: workspace,
      type: "samsung_health_body_weight",
      limit: 10
    });
    expect(record.numeric_value).toBe(74.5);
  });

  it("calories_daily extracts total_calorie", async () => {
    const csv = samsungCsv(
      "calories_burned",
      ["start_time", "end_time", "total_calorie"],
      [["2026-05-20 00:00:00.000", "2026-05-20 23:59:59.000", "1850"]]
    );
    await writeCsv("com.samsung.shealth.calories_burned.csv", csv);

    const [record] = await listRecords({
      exportPath: workspace,
      type: "samsung_health_calories_daily",
      limit: 10
    });
    expect(record.numeric_value).toBe(1850);
    expect(record.unit).toBe("kcal");
  });
});

// ─── workout properties ────────────────────────────────────────────────────────

describe("listWorkouts: workout properties", () => {
  it("calculates duration from start/end when no explicit duration column exists", async () => {
    const csv = samsungCsv(
      "exercise",
      ["start_time", "end_time", "exercise_type"],
      [["2026-05-20 09:00:00.000", "2026-05-20 09:45:00.000", "1001"]] // 45 min walk
    );
    await writeCsv("com.samsung.shealth.exercise.csv", csv);

    const [workout] = await listWorkouts({ exportPath: workspace, limit: 10 });
    expect(workout.duration).toBe(45);
    expect(workout.durationUnit).toBe("min");
  });

  it("captures energy burned from total_calorie", async () => {
    const csv = samsungCsv(
      "exercise",
      ["start_time", "end_time", "exercise_type", "total_calorie"],
      [["2026-05-20 09:00:00.000", "2026-05-20 09:30:00.000", "1002", "320"]]
    );
    await writeCsv("com.samsung.shealth.exercise.csv", csv);

    const [workout] = await listWorkouts({ exportPath: workspace, limit: 10 });
    expect(workout.totalEnergyBurned).toBe(320);
    expect(workout.totalEnergyBurnedUnit).toBe("kcal");
  });

  it("normalises distance in meters to km", async () => {
    // Samsung stores distance in metres; values > 100 are auto-divided by 1000.
    const csv = samsungCsv(
      "exercise",
      ["start_time", "end_time", "exercise_type", "distance"],
      [["2026-05-20 09:00:00.000", "2026-05-20 09:30:00.000", "1002", "5000"]] // 5 km run
    );
    await writeCsv("com.samsung.shealth.exercise.csv", csv);

    const [workout] = await listWorkouts({ exportPath: workspace, limit: 10 });
    expect(workout.totalDistance).toBe(5);
    expect(workout.totalDistanceUnit).toBe("km");
  });

  it("excludes all four sidecar exercise tables", async () => {
    const sidecars = [
      "exercise_weather",
      "exercise_max_heart_rate",
      "exercise_recovery_heart_rate",
      "exercise_periodization"
    ];
    for (const name of sidecars) {
      await writeCsv(
        `com.samsung.shealth.${name}.csv`,
        samsungCsv(name, ["start_time", "end_time", "exercise_type"], [
          ["2026-05-20 09:00:00.000", "2026-05-20 09:30:00.000", "1001"]
        ])
      );
    }
    const workouts = await listWorkouts({ exportPath: workspace, limit: 10 });
    expect(workouts).toHaveLength(0);
  });
});

// ─── listRecords query options ─────────────────────────────────────────────────

describe("listRecords query options", () => {
  it("respects the limit parameter", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => {
      const ts = `2026-05-20 ${String(i).padStart(2, "0")}:00:00.000`;
      return [ts, String(60 + i), ts];
    });
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate", "end_time"], rows)
    );

    const records = await listRecords({ exportPath: workspace, limit: 5 });
    expect(records).toHaveLength(5);
  });

  it("type filter returns only records of the requested type", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate", "end_time"], [
        ["2026-05-20 08:00:00.000", "72", "2026-05-20 08:00:30.000"]
      ])
    );
    await writeCsv(
      "com.samsung.shealth.stress.csv",
      samsungCsv("stress", ["start_time", "score", "end_time"], [
        ["2026-05-20 10:00:00.000", "35", "2026-05-20 10:05:00.000"]
      ])
    );

    const hrOnly = await listRecords({
      exportPath: workspace,
      type: "samsung_health_heart_rate",
      limit: 10
    });
    expect(hrOnly.every((r) => r.type === "samsung_health_heart_rate")).toBe(true);
    expect(hrOnly).toHaveLength(1);
  });

  it("start/end bounds exclude records outside the window", async () => {
    const csv = samsungCsv(
      "tracker.heart_rate",
      ["start_time", "heart_rate", "end_time", "time_offset"],
      [
        ["2026-05-19 08:00:00.000", "70", "2026-05-19 08:00:30.000", "UTC+0200"],
        ["2026-05-20 08:00:00.000", "72", "2026-05-20 08:00:30.000", "UTC+0200"],
        ["2026-05-21 08:00:00.000", "74", "2026-05-21 08:00:30.000", "UTC+0200"]
      ]
    );
    await writeCsv("com.samsung.shealth.tracker.heart_rate.csv", csv);

    const records = await listRecords({
      exportPath: workspace,
      start: "2026-05-20",
      end: "2026-05-20T23:59:59.000Z",
      limit: 10
    });
    expect(records).toHaveLength(1);
    expect(records[0].numeric_value).toBe(72);
  });

  it("aggregates records from multiple CSV files in the same directory", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate", "end_time"], [
        ["2026-05-20 08:00:00.000", "72", "2026-05-20 08:00:30.000"],
        ["2026-05-20 08:01:00.000", "74", "2026-05-20 08:01:30.000"]
      ])
    );
    await writeCsv(
      "com.samsung.shealth.stress.csv",
      samsungCsv("stress", ["start_time", "score", "end_time"], [
        ["2026-05-20 10:00:00.000", "40", "2026-05-20 10:05:00.000"]
      ])
    );

    const all = await listRecords({ exportPath: workspace, limit: 50 });
    expect(all.length).toBe(3);
    const types = new Set(all.map((r) => r.type));
    expect(types.has("samsung_health_heart_rate")).toBe(true);
    expect(types.has("samsung_health_stress")).toBe(true);
  });

  it("throws when the export path does not exist", async () => {
    await expect(
      listRecords({ exportPath: "/nonexistent/path/samsung", limit: 10 })
    ).rejects.toThrow();
  });

  it("accepts a single .csv file as the exportPath", async () => {
    const csvPath = join(workspace, "com.samsung.shealth.tracker.heart_rate.csv");
    await writeFile(
      csvPath,
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate", "end_time"], [
        ["2026-05-20 08:00:00.000", "88", "2026-05-20 08:00:30.000"]
      ]),
      "utf8"
    );
    const records = await listRecords({ exportPath: csvPath, limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0].numeric_value).toBe(88);
  });
});
