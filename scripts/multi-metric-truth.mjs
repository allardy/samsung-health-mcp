import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'multi-metric-truth', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, SAMSUNG_HEALTH_EXPORT_PATH: process.env.SAMSUNG_HEALTH_EXPORT_PATH || 'fixtures/samsung_health_export', SAMSUNG_HEALTH_PRIVACY_MODE: 'raw', SAMSUNG_HEALTH_TIMEZONE: 'America/Toronto' }
});
await client.connect(transport);

try {
  for (const date of ['2026-05-20']) {
    // Daily summary fields
    const daily = (await client.callTool({ name: 'samsung_health_daily_summary', arguments: { date, response_format: 'json' } })).structuredContent;
    console.log(`\n=== daily_summary ${date} (relevant fields) ===`);
    console.log('steps:', daily.totals.steps);
    console.log('active_energy_kcal:', daily.totals.active_energy_kcal);
    console.log('heart:', JSON.stringify(daily.heart));
    console.log('sleep:', JSON.stringify(daily.sleep));
  }

  // Series for HRV over a week
  const hrvSeries = (await client.callTool({
    name: 'samsung_health_series',
    arguments: { metric: 'samsung_health_hrv', stat: 'avg', bucket: '1d', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }
  })).structuredContent;
  console.log('\n=== series HRV (avg ms, daily) ===');
  for (const p of hrvSeries.points) console.log(`  ${p.t}: ${p.value} ms (n=${p.n})`);

  // Series for respiratory rate
  const rr = (await client.callTool({
    name: 'samsung_health_series',
    arguments: { metric: 'samsung_health_respiratory_rate', stat: 'avg', bucket: '1d', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }
  })).structuredContent;
  console.log('\n=== series respiratory_rate (avg, daily) ===');
  for (const p of rr.points) console.log(`  ${p.t}: ${p.value} (n=${p.n})`);

  // Floors series
  const floors = (await client.callTool({
    name: 'samsung_health_series',
    arguments: { metric: 'samsung_health_floors_climbed', stat: 'sum', bucket: '1d', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }
  })).structuredContent;
  console.log('\n=== series floors_climbed (sum, daily) ===');
  for (const p of floors.points) console.log(`  ${p.t}: ${p.value} (n=${p.n})`);

  // Distance via series
  const dist = (await client.callTool({
    name: 'samsung_health_series',
    arguments: { metric: 'samsung_health_distance', stat: 'sum', bucket: '1d', start: '2026-05-15', end: '2026-05-21', response_format: 'json' }
  })).structuredContent;
  console.log('\n=== series distance (sum, daily) ===');
  for (const p of dist.points) console.log(`  ${p.t}: ${p.value} (n=${p.n})`);
} finally {
  await client.close();
}
