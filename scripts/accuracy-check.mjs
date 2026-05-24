import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'samsung-health-mcp-accuracy', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, SAMSUNG_HEALTH_EXPORT_PATH: process.env.SAMSUNG_HEALTH_EXPORT_PATH || 'fixtures/samsung_health_export', SAMSUNG_HEALTH_PRIVACY_MODE: 'raw', SAMSUNG_HEALTH_TIMEZONE: 'America/Toronto' }
});
await client.connect(transport);

try {
  // 1. Range summary daily granularity for the same week
  const range = (await client.callTool({
    name: 'samsung_health_range_summary',
    arguments: { granularity: 'day', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }
  })).structuredContent;
  console.log('=== range_summary daily ===');
  console.log(JSON.stringify(range.buckets, null, 2));

  // 2. Daily summary for one specific day
  const daily = (await client.callTool({
    name: 'samsung_health_daily_summary',
    arguments: { date: '2026-05-20', response_format: 'json' }
  })).structuredContent;
  console.log('\n=== daily_summary 2026-05-20 ===');
  console.log('steps:', daily.totals.steps);
  console.log('sleep_minutes:', daily.sleep.minutes_asleep);
  console.log('workouts:', daily.workouts.count, 'records:', daily.data_quality.record_count);
  console.log('heart (avg/min/max):', daily.heart);

  // 3. Sum sum vs avg via series for one metric
  const stepsSeries = (await client.callTool({
    name: 'samsung_health_series',
    arguments: { metric: 'samsung_health_steps', stat: 'sum', bucket: '1d', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }
  })).structuredContent;
  console.log('\n=== series(steps, stat=sum, bucket=1d) ===');
  console.log(JSON.stringify(stepsSeries.points, null, 2));

  // 4. Data inventory for step-related types
  const inv = (await client.callTool({
    name: 'samsung_health_data_inventory',
    arguments: { response_format: 'json' }
  })).structuredContent;
  console.log('\n=== inventory: step-related types ===');
  for (const [type, info] of Object.entries(inv.record_types)) {
    if (type.includes('step')) console.log(`  ${type}: count=${info.count} ${info.first_date}..${info.last_date}`);
  }
} finally {
  await client.close();
}
