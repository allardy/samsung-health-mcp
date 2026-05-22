import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSeries } from "../src/services/series.js";
import { bucketKey, estimateBucketCount } from "../src/services/time.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "samsung-health-series-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function samsungCsv(table: string, header: string[], rows: string[][]): string {
  return [
    `com.samsung.shealth.${table},1,1`,
    header.join(","),
    ...rows.map((row) => row.join(","))
  ].join("\n");
}

async function writeCsv(filename: string, body: string): Promise<void> {
  await writeFile(join(workspace, filename), body, "utf8");
}

describe("bucketKey", () => {
  it("aligns daily buckets in the requested timezone", () => {
    // 2026-05-20 02:00 UTC = 2026-05-19 22:00 in America/New_York
    const d = new Date("2026-05-20T02:00:00Z");
    expect(bucketKey(d, "1d", "UTC")).toBe("2026-05-20");
    expect(bucketKey(d, "1d", "America/New_York")).toBe("2026-05-19");
  });

  it("aligns hourly buckets to the hour in the requested timezone", () => {
    const d = new Date("2026-05-20T13:42:00Z");
    expect(bucketKey(d, "1h", "UTC")).toBe("2026-05-20T13:00");
  });

  it("aligns 6h buckets to {00,06,12,18}", () => {
    expect(bucketKey(new Date("2026-05-20T13:42:00Z"), "6h", "UTC")).toBe("2026-05-20T12:00");
    expect(bucketKey(new Date("2026-05-20T05:59:00Z"), "6h", "UTC")).toBe("2026-05-20T00:00");
    expect(bucketKey(new Date("2026-05-20T18:00:00Z"), "6h", "UTC")).toBe("2026-05-20T18:00");
  });

  it("aligns weekly buckets to Monday in the requested timezone", () => {
    // 2026-05-20 is a Wednesday. ISO week starts Monday 2026-05-18.
    expect(bucketKey(new Date("2026-05-20T12:00:00Z"), "1w", "UTC")).toBe("2026-05-18");
    // Sunday 2026-05-24 is part of the same week (Mon=2026-05-18).
    expect(bucketKey(new Date("2026-05-24T12:00:00Z"), "1w", "UTC")).toBe("2026-05-18");
    // Monday 2026-05-25 starts a new week.
    expect(bucketKey(new Date("2026-05-25T12:00:00Z"), "1w", "UTC")).toBe("2026-05-25");
  });

  it("emits year-month for monthly buckets", () => {
    expect(bucketKey(new Date("2026-05-20T13:42:00Z"), "1m", "UTC")).toBe("2026-05");
  });
});

describe("estimateBucketCount", () => {
  it("estimates day buckets across a year", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-12-31T23:59:59Z");
    expect(estimateBucketCount(start, end, "1d")).toBeGreaterThan(360);
    expect(estimateBucketCount(start, end, "1d")).toBeLessThan(370);
  });

  it("estimates hour buckets across a day", () => {
    const start = new Date("2025-05-20T00:00:00Z");
    const end = new Date("2025-05-20T23:59:59Z");
    expect(estimateBucketCount(start, end, "1h")).toBeGreaterThanOrEqual(24);
    expect(estimateBucketCount(start, end, "1h")).toBeLessThan(26);
  });
});

describe("buildSeries", () => {
  it("buckets heart rate by day with avg statistic", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv(
        "tracker.heart_rate",
        ["start_time", "heart_rate", "end_time"],
        [
          ["2026-05-20 08:00:00.000", "60", "2026-05-20 08:00:30.000"],
          ["2026-05-20 09:00:00.000", "80", "2026-05-20 09:00:30.000"],
          ["2026-05-21 08:00:00.000", "70", "2026-05-21 08:00:30.000"]
        ]
      )
    );

    const series: any = await buildSeries(workspace, {
      metric: "samsung_health_heart_rate",
      start: "2026-05-20",
      end: "2026-05-21",
      bucket: "1d",
      stat: "avg",
      timezone: "UTC"
    });

    expect(series.kind).toBe("series");
    expect(series.unit).toBe("bpm");
    expect(series.bucket_count).toBe(2);
    expect(series.points[0]).toEqual({ t: "2026-05-20", value: 70, n: 2 });
    expect(series.points[1]).toEqual({ t: "2026-05-21", value: 70, n: 1 });
  });

  it("supports sum, min, max, count, median, p95 statistics", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv(
        "tracker.heart_rate",
        ["start_time", "heart_rate", "end_time"],
        [
          ["2026-05-20 08:00:00.000", "60", "2026-05-20 08:00:30.000"],
          ["2026-05-20 09:00:00.000", "80", "2026-05-20 09:00:30.000"],
          ["2026-05-20 10:00:00.000", "100", "2026-05-20 10:00:30.000"],
          ["2026-05-20 11:00:00.000", "120", "2026-05-20 11:00:30.000"]
        ]
      )
    );
    const base = { metric: "samsung_health_heart_rate", start: "2026-05-20", end: "2026-05-20", bucket: "1d" as const, timezone: "UTC" };

    expect((await buildSeries(workspace, { ...base, stat: "sum" })).points[0].value).toBe(360);
    expect((await buildSeries(workspace, { ...base, stat: "min" })).points[0].value).toBe(60);
    expect((await buildSeries(workspace, { ...base, stat: "max" })).points[0].value).toBe(120);
    expect((await buildSeries(workspace, { ...base, stat: "count" })).points[0].value).toBe(4);
    // Nearest-rank percentile: idx = floor(q * (n-1)). For [60,80,100,120]:
    // median (q=0.5, n=4) -> idx=1 -> 80; p95 (q=0.95, n=4) -> idx=2 -> 100.
    expect((await buildSeries(workspace, { ...base, stat: "median" })).points[0].value).toBe(80);
    expect((await buildSeries(workspace, { ...base, stat: "p95" })).points[0].value).toBe(100);
  });

  it("rejects requests that would exceed the bucket cap", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate"], [["2026-05-20 08:00:00.000", "60"]])
    );
    await expect(
      buildSeries(workspace, {
        metric: "samsung_health_heart_rate",
        start: "2025-01-01",
        end: "2026-12-31",
        bucket: "1h",
        stat: "avg",
        timezone: "UTC",
        maxBuckets: 100
      })
    ).rejects.toThrow(/buckets/);
  });

  it("returns empty points when no records match the metric", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate"], [["2026-05-20 08:00:00.000", "60"]])
    );
    const series: any = await buildSeries(workspace, {
      metric: "samsung_health_stress",
      start: "2026-05-20",
      end: "2026-05-20",
      bucket: "1d",
      stat: "avg",
      timezone: "UTC"
    });
    expect(series.bucket_count).toBe(0);
    expect(series.points).toEqual([]);
  });
});
