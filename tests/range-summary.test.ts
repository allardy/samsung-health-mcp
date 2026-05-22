import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRangeSummary } from "../src/services/range-summary.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "samsung-health-range-"));
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

describe("buildRangeSummary", () => {
  it("buckets steps and heart rate into daily buckets", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.pedometer_step_count.csv",
      samsungCsv("tracker.pedometer_step_count", ["start_time", "step_count", "end_time"], [
        ["2026-05-20 08:00:00.000", "1000", "2026-05-20 08:10:00.000"],
        ["2026-05-20 09:00:00.000", "1500", "2026-05-20 09:10:00.000"],
        ["2026-05-21 08:00:00.000", "2000", "2026-05-21 08:10:00.000"]
      ])
    );
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate", "end_time"], [
        ["2026-05-20 08:30:00.000", "60", "2026-05-20 08:30:30.000"],
        ["2026-05-20 12:30:00.000", "80", "2026-05-20 12:30:30.000"],
        ["2026-05-21 08:30:00.000", "70", "2026-05-21 08:30:30.000"]
      ])
    );

    const summary: any = await buildRangeSummary(workspace, {
      start: "2026-05-20",
      end: "2026-05-21",
      granularity: "day",
      timezone: "UTC"
    });

    expect(summary.kind).toBe("range_summary");
    expect(summary.granularity).toBe("day");
    expect(summary.bucket_count).toBe(2);
    expect(summary.buckets[0].t).toBe("2026-05-20");
    expect(summary.buckets[0].steps).toBe(2500);
    expect(summary.buckets[0].avg_heart_rate_bpm).toBe(70);
    expect(summary.buckets[1].steps).toBe(2000);
    expect(summary.buckets[1].avg_heart_rate_bpm).toBe(70);
    expect(summary.totals.steps).toBe(4500);
  });

  it("rejects requests exceeding the bucket cap", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.heart_rate.csv",
      samsungCsv("tracker.heart_rate", ["start_time", "heart_rate"], [["2026-05-20 08:00:00.000", "60"]])
    );
    await expect(
      buildRangeSummary(workspace, {
        start: "2020-01-01",
        end: "2026-12-31",
        granularity: "day",
        timezone: "UTC",
        maxBuckets: 100
      })
    ).rejects.toThrow(/buckets/);
  });

  it("groups records by ISO week when granularity=week", async () => {
    await writeCsv(
      "com.samsung.shealth.tracker.pedometer_step_count.csv",
      samsungCsv("tracker.pedometer_step_count", ["start_time", "step_count", "end_time"], [
        // 2026-05-18 = Monday (week start)
        ["2026-05-18 08:00:00.000", "1000", "2026-05-18 08:10:00.000"],
        ["2026-05-20 08:00:00.000", "2000", "2026-05-20 08:10:00.000"],
        ["2026-05-25 08:00:00.000", "3000", "2026-05-25 08:10:00.000"]
      ])
    );

    const summary: any = await buildRangeSummary(workspace, {
      start: "2026-05-18",
      end: "2026-05-31",
      granularity: "week",
      timezone: "UTC"
    });

    expect(summary.granularity).toBe("week");
    expect(summary.buckets.length).toBe(2);
    expect(summary.buckets[0]).toMatchObject({ t: "2026-05-18", steps: 3000 });
    expect(summary.buckets[1]).toMatchObject({ t: "2026-05-25", steps: 3000 });
  });
});
