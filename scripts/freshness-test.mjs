import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildExportFreshness, formatExportFreshnessMarkdown } from '../dist/services/freshness.js';

const MS_DAY = 86_400_000;

// ---------- no export configured ----------
{
  const out = await buildExportFreshness(undefined);
  assert.equal(out.ok, false);
  assert.equal(out.exists, false);
  assert.equal(out.is_stale, true);
  assert.equal(out.stale_reason, 'no_export');
  assert.match(out.recommendation, /SAMSUNG_HEALTH_EXPORT_PATH|export/i);
}

// ---------- non-existent path ----------
{
  const out = await buildExportFreshness('/tmp/__definitely_not_here');
  assert.equal(out.exists, false);
  assert.equal(out.is_stale, true);
  assert.equal(out.stale_reason, 'no_export');
}

// ---------- fixture directory (newest CSV mtime is used by inspectExportLocation for dir? Actually uses dir stat) ----------

const fixtureDir = resolve('fixtures/samsung_health_export');
const fixtureStat = await fs.stat(fixtureDir);
const fixtureFreshNow = fixtureStat.mtimeMs + 60_000;

{
  const out = await buildExportFreshness(fixtureDir, { now: () => fixtureFreshNow });
  assert.equal(out.exists, true);
  assert.equal(out.export_kind, 'directory');
  assert.equal(out.days_since_export, 0);
  assert.equal(out.is_stale, false);
  assert.equal(out.recommendation, 'Export is fresh');
}

// ---------- 31 days old → stale (older_than_30d) ----------
{
  const out = await buildExportFreshness(fixtureDir, {
    now: () => fixtureStat.mtimeMs + 31 * MS_DAY
  });
  assert.equal(out.is_stale, true);
  assert.equal(out.stale_reason, 'older_than_30d');
}

// ---------- 8 days old + no recent records → stale ----------
{
  const out = await buildExportFreshness(fixtureDir, {
    now: () => fixtureStat.mtimeMs + 8 * MS_DAY,
    daysSinceLatestRecord: 9
  });
  assert.equal(out.is_stale, true);
  assert.equal(out.stale_reason, 'older_than_7d_and_no_recent_records');
}

// ---------- 8 days old WITH recent records → fresh ----------
{
  const out = await buildExportFreshness(fixtureDir, {
    now: () => fixtureStat.mtimeMs + 8 * MS_DAY,
    daysSinceLatestRecord: 3
  });
  assert.equal(out.is_stale, false);
}

// ---------- 8 days old + no inventory data → not stale ----------
{
  const out = await buildExportFreshness(fixtureDir, {
    now: () => fixtureStat.mtimeMs + 8 * MS_DAY
  });
  assert.equal(out.is_stale, false);
  assert.equal(out.recent_records_found, undefined);
}

// ---------- temp directory boundaries ----------
const tmp = mkdtempSync(join(tmpdir(), 'samsung-health-freshness-'));
try {
  await fs.writeFile(join(tmp, 'com.samsung.health.step_count.csv'), 'a,b\n1,2\n', 'utf8');
  const dirStat = await fs.stat(tmp);

  // Exactly 30 days → boundary not stale
  let out = await buildExportFreshness(tmp, {
    now: () => dirStat.mtimeMs + 30 * MS_DAY
  });
  assert.equal(out.is_stale, false);

  // 31 days + 1 second → stale
  out = await buildExportFreshness(tmp, {
    now: () => dirStat.mtimeMs + 31 * MS_DAY + 1000
  });
  assert.equal(out.is_stale, true);
  assert.equal(out.stale_reason, 'older_than_30d');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- markdown formatter ----------
{
  const out = await buildExportFreshness(fixtureDir, { now: () => fixtureFreshNow });
  const md = formatExportFreshnessMarkdown(out);
  assert.match(md, /Samsung Health Export Freshness/);
  assert.match(md, /is_stale.*false/);
  assert.match(md, /Export is fresh/);
}

console.log(JSON.stringify({ ok: true, freshness: true }, null, 2));
