import { SUPPORTED_RECORD_TYPES } from "../constants.js";

const SUPPORTED_SET = new Set(SUPPORTED_RECORD_TYPES);

// Short-form aliases that don't follow the `samsung_health_<name>` prefix rule.
// Anything that does (e.g. "steps" → "samsung_health_steps") is handled
// automatically below; only add entries here for abbreviations / synonyms
// where the canonical name diverges from "samsung_health_<input>".
const EXPLICIT_ALIASES: Record<string, string> = {
  hr: "samsung_health_heart_rate",
  rhr: "samsung_health_resting_heart_rate",
  resting_hr: "samsung_health_resting_heart_rate",
  bp: "samsung_health_blood_pressure",
  spo2: "samsung_health_oxygen_saturation",
  oxygen: "samsung_health_oxygen_saturation",
  rr: "samsung_health_respiratory_rate",
  breathing_rate: "samsung_health_respiratory_rate",
  weight: "samsung_health_body_weight",
  floors: "samsung_health_floors_climbed"
};

/**
 * Resolve a user-supplied record-type string to its canonical form.
 *
 * Accepted inputs (in priority order):
 *   1. A canonical name already prefixed with `samsung_health_` — passed through
 *      verbatim so callers can target parser-emitted types that aren't yet in
 *      `SUPPORTED_RECORD_TYPES`.
 *   2. A short abbreviation in `EXPLICIT_ALIASES` (e.g. `hr`, `spo2`, `bp`).
 *   3. A bare name that maps to a known canonical type by adding the
 *      `samsung_health_` prefix (e.g. `steps` → `samsung_health_steps`).
 *
 * Throws with a helpful message when none of the above match — failing loudly
 * is strictly better than the previous silent-zero-matches behaviour.
 */
export function resolveRecordType(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Record type is empty.");
  if (trimmed.startsWith("samsung_health_")) return trimmed;
  const lowered = trimmed.toLowerCase();
  const alias = EXPLICIT_ALIASES[lowered];
  if (alias) return alias;
  const prefixed = `samsung_health_${lowered}`;
  if (SUPPORTED_SET.has(prefixed)) return prefixed;
  throw new Error(
    `Unknown Samsung Health record type "${input}". ` +
    `Use a canonical name (e.g. samsung_health_steps) or a short alias ` +
    `(steps, hr, hrv, spo2, sleep, stress, weight, floors). ` +
    `Call samsung_health_capabilities for the full list.`
  );
}
