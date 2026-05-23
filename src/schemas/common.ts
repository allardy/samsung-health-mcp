import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, SUPPORTED_RECORD_TYPES } from "../constants.js";
import { AGENT_CLIENTS } from "../services/agent-manifest.js";

export const ResponseFormatSchema = z.enum(["markdown", "json"]).default("markdown");
export const AgentClientSchema = z.enum(AGENT_CLIENTS).default("generic");
export const PrivacyModeSchema = z.enum(["summary", "structured", "raw"]).optional();
export const TimezoneSchema = z.string().min(1).max(80).optional().describe("IANA timezone, e.g. America/Fortaleza. Defaults to SAMSUNG_HEALTH_TIMEZONE or UTC.");

export const ResponseOnlyInputSchema = z.object({
  response_format: ResponseFormatSchema
}).strict();

export const AgentManifestInputSchema = z.object({
  client: AgentClientSchema,
  response_format: ResponseFormatSchema
}).strict();

export const ConnectionStatusInputSchema = z.object({
  client: AgentClientSchema.optional(),
  response_format: ResponseFormatSchema
}).strict();

export const RecordListInputSchema = z.object({
  type: z.string().optional().describe(`Samsung Health record type. Accepts canonical names (${SUPPORTED_RECORD_TYPES[0]}), bare names (steps, heart_rate, hrv) and short aliases (hr, spo2, bp, weight, floors). Unknown types throw with the list of known aliases.`),
  start: z.string().optional().describe("Optional ISO date/time lower bound."),
  end: z.string().optional().describe("Optional ISO date/time upper bound."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  privacy_mode: PrivacyModeSchema,
  incremental_cache: z.boolean().optional().describe("When true and `type` is set, skip records already seen in a previous call (per-category cache at ~/.samsung-health-mcp/incremental-cache.json). Cache auto-invalidates when the export file mtime changes."),
  response_format: ResponseFormatSchema
}).strict();

export const WorkoutListInputSchema = z.object({
  start: z.string().optional().describe("Optional ISO date/time lower bound."),
  end: z.string().optional().describe("Optional ISO date/time upper bound."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  privacy_mode: PrivacyModeSchema,
  response_format: ResponseFormatSchema
}).strict();

export const DailySummaryInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD local date. Defaults to today in the configured timezone."),
  timezone: TimezoneSchema,
  response_format: ResponseFormatSchema
}).strict();

export const WellnessContextInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD local date. Defaults to today in the configured timezone."),
  timezone: TimezoneSchema,
  soreness: z.array(z.string().min(1).max(80)).default([]),
  injury_flags: z.array(z.string().min(1).max(120)).default([]),
  notes: z.string().max(500).optional(),
  response_format: ResponseFormatSchema
}).strict();

export const WeeklySummaryInputSchema = z.object({
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD local end date. Defaults to today in the configured timezone."),
  days: z.number().int().min(1).max(90).default(7).describe("Days of history to include (1..90). For longer windows or coarser views prefer samsung_health_range_summary."),
  timezone: TimezoneSchema,
  privacy_mode: PrivacyModeSchema,
  response_format: ResponseFormatSchema
}).strict();

export const SeriesStatSchema = z.enum(["avg", "sum", "min", "max", "median", "p95", "count"]).default("avg");
export const SeriesBucketSchema = z.enum(["1h", "6h", "1d", "1w", "1m"]).default("1d");

export const SeriesInputSchema = z.object({
  metric: z.string().min(1).describe("Samsung Health record type to aggregate. Accepts canonical names (samsung_health_heart_rate, samsung_health_stress, samsung_health_steps, samsung_health_hrv), bare names (steps, heart_rate, hrv) and short aliases (hr, spo2, bp, weight, floors). Unknown metrics throw with the list of known aliases."),
  start: z.string().optional().describe("Optional ISO date/time lower bound. Defaults to a sensible look-back based on the chosen bucket size."),
  end: z.string().optional().describe("Optional ISO date/time upper bound. Defaults to today in the configured timezone."),
  bucket: SeriesBucketSchema,
  stat: SeriesStatSchema,
  timezone: TimezoneSchema,
  max_buckets: z.number().int().min(1).max(5000).optional().describe("Safety cap on bucket count (default 1000). Requests above the cap fail with a hint to widen the bucket."),
  response_format: ResponseFormatSchema
}).strict();

export const RangeSummaryGranularitySchema = z.enum(["day", "week", "month"]).default("week");

export const RangeSummaryInputSchema = z.object({
  start: z.string().optional().describe("Optional ISO date/time lower bound. Defaults to a sensible look-back based on granularity."),
  end: z.string().optional().describe("Optional ISO date/time upper bound. Defaults to today in the configured timezone."),
  granularity: RangeSummaryGranularitySchema,
  timezone: TimezoneSchema,
  max_buckets: z.number().int().min(1).max(1000).optional().describe("Safety cap on bucket count (default 200)."),
  response_format: ResponseFormatSchema
}).strict();

export const InventoryInputSchema = z.object({
  start: z.string().optional().describe("Optional ISO date/time lower bound."),
  end: z.string().optional().describe("Optional ISO date/time upper bound."),
  timezone: TimezoneSchema,
  privacy_mode: PrivacyModeSchema,
  response_format: ResponseFormatSchema
}).strict();

export const PassthroughOutputSchema = z.object({}).passthrough();

export type AgentManifestInput = z.infer<typeof AgentManifestInputSchema>;
export type RecordListInput = z.infer<typeof RecordListInputSchema>;
export type WorkoutListInput = z.infer<typeof WorkoutListInputSchema>;
export type DailySummaryInput = z.infer<typeof DailySummaryInputSchema>;
export type WellnessContextInput = z.infer<typeof WellnessContextInputSchema>;
export type WeeklySummaryInput = z.infer<typeof WeeklySummaryInputSchema>;
export type InventoryInput = z.infer<typeof InventoryInputSchema>;
export type SeriesInput = z.infer<typeof SeriesInputSchema>;
export type RangeSummaryInput = z.infer<typeof RangeSummaryInputSchema>;
