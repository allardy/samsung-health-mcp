# Agent Development Notes

## Scope

This repo is the local-first, unofficial Samsung Health export MCP connector. It parses user-provided Samsung Health exports (zip / CSVs / JSON sidecars) and exposes **19 tools, 5 resources, and 2 prompts** via the Model Context Protocol. It must never require cloud credentials or network access.

This is a fork of `davidmosiah/samsung-health-mcp` with accuracy and performance fixes. Default branch is **`master`**; `main` is preserved as a snapshot baseline.

## Rules

- Never commit Samsung Health exports, generated health data, tokens, API keys, or local config.
- Keep the connector explicitly unofficial and not medical advice.
- Preserve agent-ready surfaces: manifest, connection status, privacy audit, CLI UX, and metadata checks.
- Prefer fixture/local data in tests. Do not add network-dependent tests.
- Code and comments wrap at 150 cols. Do NOT hard-wrap at 70/80.
- Use **npm**, not pnpm — upstream tooling and `npm test` assume `package-lock.json`.

## Commands

```bash
npm ci                     # install (npm, not pnpm)
npm run typecheck
npm run build              # tsc → dist/
npm run dev                # tsx src/index.ts (stdio mode)
npm run smoke              # stdio MCP smoke test against fixtures/samsung_health_export
npm run smoke:http         # HTTP transport health check
npm test                   # full gate: typecheck + build + vitest + 8 script smokes
npm run test:unit          # vitest only

node scripts/full-tool-audit.mjs   # exercise every tool/resource/prompt via stdio
node scripts/perf-test.mjs         # cold vs warm timing for the main read paths
```

Set `SAMSUNG_HEALTH_EXPORT_PATH` to your export path (a zip, a single CSV, or a directory of CSVs) before anything that reads data. The shipped `fixtures/samsung_health_export/` is intentionally tiny — useful for smokes, not representative of a real multi-year export.

## Transports

The server picks its transport via `SAMSUNG_HEALTH_MCP_TRANSPORT`:

- **`stdio`** (default) — for direct MCP client consumers running locally.
- **`http`** — Express server on `SAMSUNG_HEALTH_MCP_HOST` (default `127.0.0.1`) `:SAMSUNG_HEALTH_MCP_PORT` (default `3000`), serving `POST /mcp` and `GET /health`. Intended to sit behind an OAuth-enforcing proxy; the server itself does no auth.

Both transports register the same tools/resources/prompts and share the same cache.

## Architecture

```
src/
├── index.ts                       # entrypoint: picks transport, registers tools, fires warmExportCache()
├── cli/                           # one-shot CLI subcommands (--help, --version, import/export)
├── constants.ts                   # SUPPORTED_RECORD_TYPES, MAX_LIMIT, package name/version
├── schemas/common.ts              # zod schemas for every tool input
├── services/
│   ├── samsung-health-export.ts   # ★ parser, source loader, in-memory cache. EVERY data path goes through here.
│   ├── record-types.ts            # alias resolver (steps → samsung_health_steps, hr → samsung_health_heart_rate)
│   ├── series.ts                  # samsung_health_series — bucketed single-metric trends
│   ├── range-summary.ts           # samsung_health_range_summary — multi-metric per-bucket totals
│   ├── summary.ts                 # samsung_health_daily_summary + samsung_health_weekly_summary
│   ├── inventory.ts               # samsung_health_data_inventory
│   ├── freshness.ts               # samsung_health_export_freshness
│   ├── capabilities.ts            # samsung_health_capabilities
│   ├── connection-status.ts       # samsung_health_connection_status
│   ├── agent-manifest.ts          # samsung_health_agent_manifest
│   ├── context.ts                 # samsung_health_wellness_context
│   ├── audit.ts                   # samsung_health_privacy_audit
│   ├── privacy.ts                 # privacy redaction (summary / structured / raw)
│   ├── profile-store.ts           # ~/.delx-wellness/profile.json + onboarding flow
│   ├── format.ts                  # makeResponse / bulletList / makeError
│   ├── time.ts                    # bucketKey, dayBounds, parseFlexibleDate, BucketSize
│   ├── incremental-cache.ts       # on-disk per-category cursor at ~/.samsung-health-mcp/incremental-cache.json
│   └── import-export.ts           # CLI helpers
├── tools/samsung-health-tools.ts  # server.registerTool ×19
├── resources/                     # samsung-health:// resource registrations
└── prompts/                       # samsung_health_daily_review, samsung_health_weekly_review
```

**Rule:** consumer code reads data through `getExportSnapshot()` in `samsung-health-export.ts`. Direct calls to `parseExportEntities()` from anywhere else are forbidden — they bypass the cache and re-parse the full export on every request. Both `listRecords` and `listWorkouts` were caught violating this and routed through the snapshot in a perf fix.

## The export parser: invariants and quirks

### Caching (`PARSED_EXPORT_CACHE`)

- **Keyed only by file state** (path + size + mtime). Reusing the parse across query windows turns ~30 s parses into in-memory filters; without this every request walks ~89K records and ~2K JSON sidecars from scratch.
- Capped at 2 entries. The resident set for a 7-year / 89K-record export is around 50 MB.
- **Async warmup on server start** via `warmExportCache()` (`src/index.ts`). Fires after `app.listen()` in HTTP mode and after `server.connect(transport)` in stdio mode. Errors are swallowed so the server still starts on a missing/broken export. Look for `Export cache warmed: N records, M workouts.` in stderr to confirm.
- The cache is in-memory only — wiped on process exit. The on-disk **incremental-cache** at `~/.samsung-health-mcp/incremental-cache.json` is a separate feature (per-category "last seen timestamp" cursors used only when callers pass `incremental_cache: true` to `samsung_health_list_records`).

### Samsung's three date-encoding formats

`bestDate()` picks them up via the `DATE_KEYS.start` alias list:

1. **Naive local datetime + `time_offset` column** — e.g. `"2026-05-20 08:00:00.000"` + `"UTC-0400"`. `combineDateAndOffset` splices them. Used by per-event tables (`heart_rate`, `step_count`, `hrv`, `respiratory_rate`, …).
2. **`day_time` numeric ms** — e.g. `1779235200000`. Samsung stores the local-midnight wall-clock as if it were UTC midnight. Used by `step_daily_trend`, `pedometer_day_summary`, `floors_day_summary`.
3. **`day_time` date string** — e.g. `"2026-05-20 00:00:00.000"`. Same naive-local-midnight semantics, just stringified. Used by `activity.day_summary`.

Formats 2 and 3 have **no `time_offset` column** — there's no way to recover the exact local-midnight UTC instant. `parseDayTimeToNoon()` anchors these at **noon UTC of the inferred calendar day**, keeping the record on the correct local day in every reasonable user timezone (UTC-12 through UTC+12). The matcher accepts the literal column `day_time` AND any column whose normalized name ends in `_day_time` (e.g. `com.samsung.shealth.calories_burned.day_time`).

### HRV values live in JSON sidecars

The HRV CSV (`com.samsung.health.hrv.*.csv`) only has timing + a `binning_data` filename column. The actual RMSSD/SDNN samples are in `<uuid>.binning_data.json` files alongside (typically under `jsons/com.samsung.health.hrv/<bucket>/`), structured as `[{ start_time, end_time, sdnn, rmssd }, …]` (per-30-second bins).

- `readExportSources()` loads CSV sources AND a `binningJsons: Map<basename, content>` together.
- Sidecar loading is **selective** via `isHrvBinningPath()` — only HRV. Loading all sidecar types would balloon memory (heart_rate alone is ~70 MB across 11K JSON files on a multi-year export) with no benefit, since other types carry numeric values directly in the CSV.
- `metricForRecord(samsung_health_hrv, …)` tries direct CSV columns first (older / future formats), falls back to averaging `rmssd` across the JSON's bins via `averageRmssdFromBinning()`.
- Works for both the nested Samsung-zip layout and flat extracts — files are keyed by basename, not path. **If a user provides a flat-CSV-only repack, HRV values disappear**: records exist but `numeric_value` is undefined and series filters them out.

### Source-preference chain for daily totals

Samsung emits the same metric across multiple tables with different aggregation semantics. The summaries pick the source that matches the Samsung Health app's UI:

- **Steps** (`sumDailySteps` / `summarizeBucket`): `step_daily_trend → step_daily → activity_daily → samsung_health_steps`. `step_daily_trend` is the per-device daily total; multiple rows per day (one per contributing device) summed = the number shown in the app. `samsung_health_steps` (raw `pedometer_step_count` events) is a single device only and undercounts vs the app by ~2×. It is still used for **sub-day series queries** where event-level granularity matters.
- **Active energy** (`sumDailyActiveEnergy`): `samsung_health_calories_daily → samsung_health_active_energy`. `calories_daily` comes from `calories_burned.details.csv` (per-day `active_calorie`); `active_energy` is the legacy fallback.
- **Distance** (secondary emission in `rowToSecondaryRecords`): emitted **only from `step_daily_trend`** rows, dividing the metres column by 1000 to get km. NOT also emitted from `pedometer_day_summary` (would double-count — same data, two tables). The conversion bypasses `normalizeDistance()` because its magnitude heuristic mis-classifies short walks (<100 m) as kilometres.

### Alias resolver

`samsung_health_series.metric` and `samsung_health_list_records.type` accept three input styles via `resolveRecordType()`:

- **Canonical** prefixed names (`samsung_health_steps`, `samsung_health_heart_rate`) — passed through.
- **Bare names** that resolve by prefix-stripping (`steps` → `samsung_health_steps`).
- **Short aliases** for things that don't follow the prefix rule: `hr`, `rhr`, `resting_hr`, `bp`, `spo2`, `oxygen`, `rr`, `breathing_rate`, `weight`, `floors`.

Unknown metrics throw with the alias list in the error message.

## Testing

- **Unit tests** (`tests/`): vitest. Each test builds a temp workspace with synthetic Samsung CSVs (and HRV JSON sidecars where relevant) and exercises one parser/aggregator path. The suite is the ground truth for the parser's tricky cases (date encodings, source preference, alias resolution).
- **Script smokes** (8 of them, all run after vitest in `npm test`): stdio smoke, HTTP smoke, export parser, freshness, incremental cache, CLI UX, agent readiness, hermes manifest, metadata. They confirm the published MCP surface stays stable across releases.
- **`scripts/full-tool-audit.mjs`** — single-shot audit of all 19 tools + 5 resources + 2 prompts via an stdio MCP client. Exit 1 on any non-PASS. Useful as a debug smoke against a real fixture.
- **Ground-truth verification:** when changing the parser or aggregation, point `SAMSUNG_HEALTH_EXPORT_PATH` at a real Samsung Health export and compare tool outputs against raw-CSV sums. See `scripts/accuracy-check.mjs` and `scripts/multi-metric-truth.mjs` for the pattern (one tool call → one Python CSV computation → diff). **Never commit a real export to the repo** — it's personal health data.

## Known limitations / footguns

- **MCP SDK doesn't enforce zod `.strict()`** on tool args. Unknown KEYS in arguments are silently dropped, so a typo like `record_type:` instead of `type:` returns all records without erroring. Either guard per-tool or upstream a fix.
- **`samsung_health_steps` (raw events) ≠ Samsung Health app total** for any day with multiple contributing devices. The daily/weekly/range aggregators all prefer the day-aggregate sources, but callers querying `samsung_health_series metric=samsung_health_steps` directly are getting the watch-only count.
- **HRV requires the JSON sidecars.** If the export doesn't include `jsons/com.samsung.health.hrv/`, HRV records have no numeric value and disappear from series.
- **Cold parse is ~30 s** for a multi-year nested export. The warmup hides this from users post-restart, but if the export file changes mid-process the next request after the file-state change pays the cost (and resets the cache via the new file key).
- **`samsung_health_range_summary` over a full year is ~35 s** even with the cache warm — the bottleneck is `parseSamsungDate` + `bucketKey` called once per record per bucket pass. A reasonable next optimization is to attach a precomputed `startMs: number` to each cached record so bucketing skips string parsing on every hit.
