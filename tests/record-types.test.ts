import { describe, expect, it } from "vitest";

import { resolveRecordType } from "../src/services/record-types.js";

describe("resolveRecordType", () => {
  it("passes canonical names through unchanged", () => {
    expect(resolveRecordType("samsung_health_steps")).toBe("samsung_health_steps");
    expect(resolveRecordType("samsung_health_heart_rate")).toBe("samsung_health_heart_rate");
  });

  it("passes prefixed names through even when not in the supported list", () => {
    // Parser may emit types we haven't documented yet — don't reject those.
    expect(resolveRecordType("samsung_health_some_future_metric")).toBe("samsung_health_some_future_metric");
  });

  it("auto-prefixes bare metric names that match supported types", () => {
    expect(resolveRecordType("steps")).toBe("samsung_health_steps");
    expect(resolveRecordType("heart_rate")).toBe("samsung_health_heart_rate");
    expect(resolveRecordType("hrv")).toBe("samsung_health_hrv");
    expect(resolveRecordType("stress")).toBe("samsung_health_stress");
    expect(resolveRecordType("sleep")).toBe("samsung_health_sleep");
  });

  it("resolves explicit short-form aliases", () => {
    expect(resolveRecordType("hr")).toBe("samsung_health_heart_rate");
    expect(resolveRecordType("rhr")).toBe("samsung_health_resting_heart_rate");
    expect(resolveRecordType("resting_hr")).toBe("samsung_health_resting_heart_rate");
    expect(resolveRecordType("spo2")).toBe("samsung_health_oxygen_saturation");
    expect(resolveRecordType("oxygen")).toBe("samsung_health_oxygen_saturation");
    expect(resolveRecordType("bp")).toBe("samsung_health_blood_pressure");
    expect(resolveRecordType("weight")).toBe("samsung_health_body_weight");
    expect(resolveRecordType("floors")).toBe("samsung_health_floors_climbed");
  });

  it("is case-insensitive for aliases and bare names", () => {
    expect(resolveRecordType("Steps")).toBe("samsung_health_steps");
    expect(resolveRecordType("HR")).toBe("samsung_health_heart_rate");
    expect(resolveRecordType("SpO2")).toBe("samsung_health_oxygen_saturation");
  });

  it("trims whitespace", () => {
    expect(resolveRecordType("  steps  ")).toBe("samsung_health_steps");
  });

  it("throws with a helpful message on truly unknown inputs", () => {
    expect(() => resolveRecordType("foobar")).toThrowError(/Unknown Samsung Health record type "foobar"/);
    expect(() => resolveRecordType("foobar")).toThrowError(/short alias.*steps.*hr.*hrv/i);
  });

  it("throws on empty input", () => {
    expect(() => resolveRecordType("")).toThrowError(/empty/i);
    expect(() => resolveRecordType("   ")).toThrowError(/empty/i);
  });
});
