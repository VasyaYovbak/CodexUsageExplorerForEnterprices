const assert = require('assert');
const { buildOpenCodeUsageData } = require('../opencode-usage');

const hex = (value) => Buffer.from(value).toString('hex').toUpperCase();
const row = (id, timestamp, parent, cost, input, cache) => ({
  session_id: 'session-1',
  title_hex: hex('OpenCode fixture'),
  directory_hex: hex('/fixture'),
  message_id: id,
  message_created: Date.parse(timestamp),
  message_updated: Date.parse(timestamp),
  prompt_hex: hex('Inspect\nthe project'),
  parent_id: parent,
  model_hex: hex('fixture-model'),
  cost,
  input_tokens: input,
  output_tokens: 4,
  reasoning_tokens: 1,
  cache_read: cache,
  cache_write: 2,
  total_rows: 2,
});

(async () => {
  const rows = [
    row('message-1', '2026-07-08T10:00:00Z', 'user-1', 0.1, 10, 5),
    row('message-2', '2026-07-09T10:00:00Z', 'user-1', 0.2, 20, 6),
  ];
  let calls = 0;
  const execute = async (command, args) => {
    calls += 1;
    assert.strictEqual(command, 'opencode');
    assert.deepStrictEqual(args.slice(-2), ['--format', 'tsv']);
    assert.ok(!args[1].includes('m.time_created >='));
    const result = calls === 1 ? rows.slice(0, 1) : rows;
    return { stdout: `${Object.keys(rows[0]).join('\t')}\n${result.map((item) => Object.values(item).join('\t')).join('\n')}\n` };
  };
  const data = await buildOpenCodeUsageData(new Date('2026-07-09T12:00:00Z'), undefined, execute);
  assert.deepStrictEqual([data.meta.source, data.week.sessions[0].usage.input_tokens, data.today.total.cached_tokens, data.week.total.cached_writes], ['opencode', 41, 6, 4]);
  assert.ok(Math.abs(data.pricing.usd - 0.3) < Number.EPSILON);
  assert.deepStrictEqual(data.week.sessions[0].iterations.map((item) => item.trigger), ['User message', 'Model call']);
  assert.strictEqual(data.week.sessions[0].iterations[0].label, 'Inspect the project');
  assert.strictEqual(calls, 2);
  console.log('OpenCode usage checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
