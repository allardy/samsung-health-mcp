import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'samsung-health-mcp-full-audit', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, SAMSUNG_HEALTH_EXPORT_PATH: process.env.SAMSUNG_HEALTH_EXPORT_PATH || 'fixtures/samsung_health_export', SAMSUNG_HEALTH_PRIVACY_MODE: 'raw', SAMSUNG_HEALTH_TIMEZONE: 'America/Toronto' }
});
await client.connect(transport);

const toolCalls = [
  { name: 'samsung_health_agent_manifest', args: { client: 'hermes', response_format: 'json' }, checkShape: (sc) => sc?.samsung_health_live_access === false && Array.isArray(sc?.agent_rules) },
  { name: 'samsung_health_capabilities', args: { response_format: 'json' }, checkShape: (sc) => sc?.project === 'samsung-health-mcp-unofficial' && Array.isArray(sc?.supported_data) },
  { name: 'samsung_health_clear_incremental_cache', args: {}, checkShape: (sc, raw) => /cleared|nothing|no cache/i.test(JSON.stringify(raw)) },
  { name: 'samsung_health_connection_status', args: { client: 'hermes', response_format: 'json' }, checkShape: (sc) => sc?.ok === true && sc?.client === 'hermes' },
  { name: 'samsung_health_daily_summary', args: { date: '2026-05-20', response_format: 'json' }, checkShape: (sc) => sc?.kind === 'daily_summary' && sc?.date === '2026-05-20' },
  { name: 'samsung_health_data_inventory', args: { response_format: 'json' }, checkShape: (sc) => sc?.kind === 'data_inventory' && sc?.totals?.records > 0 },
  { name: 'samsung_health_demo', args: { response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 100 || sc },
  { name: 'samsung_health_export_freshness', args: { response_format: 'json' }, checkShape: (sc) => sc?.ok === true && sc?.exists === true },
  { name: 'samsung_health_list_records', args: { type: 'samsung_health_steps', start: '2026-05-20', end: '2026-05-21', limit: 5, response_format: 'json' }, checkShape: (sc) => sc?.type === 'samsung_health_steps' && Array.isArray(sc?.records) },
  { name: 'samsung_health_list_workouts', args: { start: '2025-01-01', end: '2026-05-21', limit: 5, response_format: 'json' }, checkShape: (sc) => Array.isArray(sc?.workouts) && sc.workouts.length > 0 },
  { name: 'samsung_health_onboarding', args: { response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 100 || sc },
  { name: 'samsung_health_privacy_audit', args: { response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 100 || sc },
  { name: 'samsung_health_profile_get', args: { response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 50 || sc },
  { name: 'samsung_health_profile_update', args: { patch: { profile: { age: 35 } }, explicit_user_intent: true, response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 50 || sc },
  { name: 'samsung_health_quickstart', args: { response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 100 || sc },
  { name: 'samsung_health_range_summary', args: { granularity: 'month', start: '2025-01-01', end: '2025-12-31', response_format: 'json' }, checkShape: (sc) => sc?.kind === 'range_summary' && sc?.bucket_count > 0 },
  { name: 'samsung_health_series', args: { metric: 'samsung_health_heart_rate', bucket: '1d', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }, checkShape: (sc) => sc?.kind === 'series' && sc?.bucket_count > 0 },
  { name: 'samsung_health_weekly_summary', args: { end_date: '2026-05-21', days: 7, response_format: 'json' }, checkShape: (sc) => sc?.kind === 'weekly_summary' && sc?.totals?.steps !== undefined },
  { name: 'samsung_health_wellness_context', args: { date: '2026-05-20', response_format: 'json' }, checkShape: (sc, raw) => raw?.content?.[0]?.text?.length > 50 || sc },
];

const resources = [
  'samsung-health://agent-manifest',
  'samsung-health://capabilities',
  'samsung-health://inventory',
  'samsung-health://summary/daily',
  'samsung-health://summary/weekly',
];

const prompts = [
  { name: 'samsung_health_daily_review', args: {} },
  { name: 'samsung_health_weekly_review', args: {} },
];

const results = { tools: [], resources: [], prompts: [] };

try {
  // Tools
  for (const call of toolCalls) {
    try {
      const r = await client.callTool({ name: call.name, arguments: call.args });
      const sc = r.structuredContent;
      const isError = r.isError === true;
      const shapeOk = call.checkShape ? call.checkShape(sc, r) : true;
      const status = isError ? 'ERROR' : shapeOk ? 'PASS' : 'SHAPE_FAIL';
      const note = isError ? (r.content?.[0]?.text ?? '').slice(0, 120) : '';
      results.tools.push({ tool: call.name, status, note });
    } catch (e) {
      results.tools.push({ tool: call.name, status: 'THROW', note: String(e).slice(0, 120) });
    }
  }

  // Resources
  for (const uri of resources) {
    try {
      const r = await client.readResource({ uri });
      const hasContent = (r.contents?.length ?? 0) > 0 && (r.contents[0].text?.length ?? 0) > 10;
      results.resources.push({ uri, status: hasContent ? 'PASS' : 'EMPTY', bytes: r.contents?.[0]?.text?.length ?? 0 });
    } catch (e) {
      results.resources.push({ uri, status: 'THROW', note: String(e).slice(0, 120) });
    }
  }

  // Prompts
  for (const p of prompts) {
    try {
      const r = await client.getPrompt({ name: p.name, arguments: p.args });
      const hasMessages = (r.messages?.length ?? 0) > 0;
      results.prompts.push({ prompt: p.name, status: hasMessages ? 'PASS' : 'EMPTY', messages: r.messages?.length ?? 0 });
    } catch (e) {
      results.prompts.push({ prompt: p.name, status: 'THROW', note: String(e).slice(0, 120) });
    }
  }
} finally {
  await client.close();
}

console.log(JSON.stringify(results, null, 2));
const failed = [
  ...results.tools.filter((t) => t.status !== 'PASS'),
  ...results.resources.filter((r) => r.status !== 'PASS'),
  ...results.prompts.filter((p) => p.status !== 'PASS'),
];
console.log(`\n=== SUMMARY ===`);
console.log(`Tools:     ${results.tools.filter(t => t.status === 'PASS').length}/${results.tools.length} pass`);
console.log(`Resources: ${results.resources.filter(r => r.status === 'PASS').length}/${results.resources.length} pass`);
console.log(`Prompts:   ${results.prompts.filter(p => p.status === 'PASS').length}/${results.prompts.length} pass`);
if (failed.length > 0) {
  console.log(`\nFAILED:`);
  for (const f of failed) console.log(`  ${JSON.stringify(f)}`);
  process.exit(1);
}
