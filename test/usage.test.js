const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildUsageData, mondayUtc, normalizeUsage, resolveRange } = require('../usage');

assert.strictEqual(new Date(mondayUtc(new Date('2026-07-09T18:00:00Z'))).toISOString(), '2026-07-06T00:00:00.000Z');
assert.deepStrictEqual(resolveRange(new Date('2026-07-09T18:00:00Z'), { mode: 'month', month: '2026-07' }).selection, { mode: 'month', month: '2026-07' });
assert.strictEqual((resolveRange(new Date(), { mode: 'custom', start: '2026-07-01', end: '2026-07-09' }).endMs - Date.parse('2026-07-01T00:00:00Z')) / 86400000, 9);
assert.throws(() => resolveRange(new Date(), { mode: 'custom', start: '2026-07-10', end: '2026-07-09' }), /End date/);
assert.deepStrictEqual(normalizeUsage({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 }), {
  input_tokens: 10,
  output_tokens: 3,
  cached_tokens: 4,
  reasoning_tokens: 1,
  cached_writes: null,
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  const sessionDir = path.join(root, 'sessions', '2026', '07', '09');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), '{"id":"session-1","thread_name":"Fixture chat"}\n');
  fs.writeFileSync(path.join(sessionDir, 'rollout-session-1.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', timestamp: '2026-07-09T10:00:00Z' } }),
    JSON.stringify({ timestamp: '2026-07-09T10:00:30Z', type: 'event_msg', payload: { type: 'user_message', message: 'Inspect the project' } }),
    JSON.stringify({ timestamp: '2026-07-09T10:01:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 }, last_token_usage: { input_tokens: 10, output_tokens: 2 } } } }),
    JSON.stringify({ timestamp: '2026-07-09T10:01:30Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'read_file' } }),
    JSON.stringify({ timestamp: '2026-07-09T10:01:31Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'contents' } }),
    JSON.stringify({ timestamp: '2026-07-09T10:02:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 1 }, last_token_usage: { input_tokens: 12, cached_input_tokens: 5, output_tokens: 2, reasoning_output_tokens: 1 } } } }),
  ].join('\n'));
  const fixture = await buildUsageData(root, new Date('2026-07-09T12:00:00Z'));
  assert.deepStrictEqual(fixture.week.daily.map(({ label }) => label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepStrictEqual(fixture.week.sessions[0].usage, { input_tokens: 20, output_tokens: 4, cached_tokens: 5, reasoning_tokens: 1, cached_writes: null });
  assert.strictEqual(fixture.week.sessions[0].title, 'Fixture chat');
  assert.deepStrictEqual(fixture.week.sessions[0].iterations.map((iteration) => [iteration.trigger, iteration.label, iteration.usage.input_tokens]), [
    ['User message', 'Inspect the project', 10],
    ['Tool response', 'read_file', 12],
  ]);
  const monthly = await buildUsageData(root, new Date(), undefined, { mode: 'month', month: '2026-07' });
  assert.strictEqual(monthly.week.daily.length, 5);
  assert.deepStrictEqual(monthly.week.daily.map(({ date, end }) => [date, end]), [
    ['2026-07-01', '2026-07-07'],
    ['2026-07-08', '2026-07-14'],
    ['2026-07-15', '2026-07-21'],
    ['2026-07-22', '2026-07-28'],
    ['2026-07-29', '2026-07-31'],
  ]);
  assert.strictEqual(monthly.week.daily[1].usage.input_tokens, 20);
  assert.strictEqual(monthly.meta.sessionCount, 1);
  const custom = await buildUsageData(root, new Date(), undefined, { mode: 'custom', start: '2026-07-01', end: '2026-07-09' });
  assert.strictEqual(custom.week.daily.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('usage parser checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
