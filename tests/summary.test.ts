import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDailySummary } from "../src/services/summary.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "samsung-health-summary-"));
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

describe("buildDailySummary sleep breakdown", () => {
  it("prefers stage records over the session record (no double-counting)", async () => {
    // Session: 6h block (10:00-16:00 UTC, to stay within one UTC day).
    await writeCsv(
      "com.samsung.shealth.sleep.csv",
      samsungCsv(
        "sleep",
        ["start_time", "end_time"],
        [["2026-05-20 10:00:00.000", "2026-05-20 16:00:00.000"]]
      )
    );
    // Stages totalling 3h asleep + 1h awake = 4h in bed (intentionally less than the session
    // so we can detect whether the session got summed in).
    await writeCsv(
      "com.samsung.shealth.sleep_stage.csv",
      samsungCsv(
        "sleep_stage",
        ["start_time", "end_time", "stage"],
        [
          ["2026-05-20 10:00:00.000", "2026-05-20 11:00:00.000", "40002"], // light, 60 min
          ["2026-05-20 11:00:00.000", "2026-05-20 12:00:00.000", "40003"], // deep, 60 min
          ["2026-05-20 12:00:00.000", "2026-05-20 13:00:00.000", "40004"], // rem,  60 min
          ["2026-05-20 13:00:00.000", "2026-05-20 14:00:00.000", "40001"]  //awake, 60 min
        ]
      )
    );

    const summary: any = await buildDailySummary(workspace, "2026-05-20", { timezone: "UTC" });

    // Stage sum is 180 min asleep. Session was 360 min. With double-counting the result
    // would be 540 min = 9h. The fix should yield exactly the stage total.
    expect(summary.sleep.minutes_asleep).toBe(180);
    expect(summary.sleep.hours_asleep).toBe(3);
    expect(summary.sleep.stages_minutes.light).toBe(60);
    expect(summary.sleep.stages_minutes.deep).toBe(60);
    expect(summary.sleep.stages_minutes.rem).toBe(60);
    expect(summary.sleep.stages_minutes.awake).toBe(60);
  });

  it("falls back to the session record when no stage records exist", async () => {
    await writeCsv(
      "com.samsung.shealth.sleep.csv",
      samsungCsv(
        "sleep",
        ["start_time", "end_time"],
        [["2026-05-20 10:00:00.000", "2026-05-20 16:00:00.000"]]
      )
    );

    const summary: any = await buildDailySummary(workspace, "2026-05-20", { timezone: "UTC" });
    expect(summary.sleep.minutes_asleep).toBe(360);
    expect(summary.sleep.hours_asleep).toBe(6);
  });
});
