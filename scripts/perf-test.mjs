import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'perf-test', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    SAMSUNG_HEALTH_EXPORT_PATH: process.env.SAMSUNG_HEALTH_EXPORT_PATH || 'fixtures/samsung_health_export',
    SAMSUNG_HEALTH_PRIVACY_MODE: 'raw',
    SAMSUNG_HEALTH_TIMEZONE: 'America/Toronto'
  }
});
await client.connect(transport);

async function timed(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - t0);
  const sc = result.structuredContent;
  console.log(`${label}: ${ms}ms${sc?.cache?.hit !== undefined ? ` (cache hit=${sc.cache.hit})` : ''}`);
  return result;
}

try {
  await timed('1. daily_summary cold (full parse)', () => client.callTool({
    name: 'samsung_health_daily_summary', arguments: { date: '2026-05-20', response_format: 'json' }
  }));
  await timed('2. daily_summary same window', () => client.callTool({
    name: 'samsung_health_daily_summary', arguments: { date: '2026-05-20', response_format: 'json' }
  }));
  await timed('3. daily_summary different day', () => client.callTool({
    name: 'samsung_health_daily_summary', arguments: { date: '2026-05-15', response_format: 'json' }
  }));
  await timed('4. weekly_summary 7-day', () => client.callTool({
    name: 'samsung_health_weekly_summary', arguments: { end_date: '2026-05-21', days: 7, response_format: 'json' }
  }));
  await timed('5. range_summary year-month', () => client.callTool({
    name: 'samsung_health_range_summary', arguments: { granularity: 'month', start: '2025-01-01', end: '2025-12-31', response_format: 'json' }
  }));
  await timed('6. series HRV 30d', () => client.callTool({
    name: 'samsung_health_series', arguments: { metric: 'samsung_health_hrv', stat: 'avg', bucket: '1d', start: '2026-04-21', end: '2026-05-21', response_format: 'json' }
  }));
  await timed('7. data_inventory', () => client.callTool({
    name: 'samsung_health_data_inventory', arguments: { response_format: 'json' }
  }));
} finally {
  await client.close();
}
