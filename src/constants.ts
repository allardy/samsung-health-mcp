export const SERVER_NAME = "samsung-health-mcp-server";
export const SERVER_VERSION = "0.4.3";
export const NPM_PACKAGE_NAME = "samsung-health-mcp-unofficial";
export const PINNED_NPM_PACKAGE = `${NPM_PACKAGE_NAME}@${SERVER_VERSION}`;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export const SUPPORTED_RECORD_TYPES = [
  // Activity — instantaneous & per-minute
  "samsung_health_steps",
  "samsung_health_distance",
  "samsung_health_active_energy",
  "samsung_health_movement",
  "samsung_health_floors_climbed",
  // Activity — daily aggregates
  "samsung_health_step_daily",
  "samsung_health_step_daily_trend",
  "samsung_health_activity_daily",
  "samsung_health_floors_daily",
  "samsung_health_calories_daily",
  // Heart
  "samsung_health_heart_rate",
  "samsung_health_alerted_heart_rate",
  "samsung_health_resting_heart_rate",
  "samsung_health_hrv",
  "samsung_health_ecg",
  "samsung_health_blood_pressure",
  // Respiratory & oxygen
  "samsung_health_respiratory_rate",
  "samsung_health_oxygen_saturation",
  // Body
  "samsung_health_body_weight",
  "samsung_health_body_fat",
  "samsung_health_height",
  "samsung_health_skin_temperature",
  // Sleep family
  "samsung_health_sleep",
  "samsung_health_sleep_stage",
  "samsung_health_sleep_combined",
  "samsung_health_sleep_raw",
  "samsung_health_sleep_apnea",
  "samsung_health_sleep_snoring",
  "samsung_health_sleep_goal",
  "samsung_health_nap",
  // Stress
  "samsung_health_stress",
  "samsung_health_alerted_stress",
  "samsung_health_stress_histogram",
  // Vitality & wellness signals
  "samsung_health_vitality_score",
  "samsung_health_breathing_exercise",
  // Nutrition
  "samsung_health_water_intake",
  "samsung_health_caffeine_intake",
  "samsung_health_food",
  // Samsung-generated context (not raw sensors, but high-signal for agents)
  "samsung_health_insight",
  "samsung_health_report",
  // Profile (for normalization: age, height, goals)
  "samsung_health_user_profile"
];
