const assert = require('assert');
const { applyPricing, parseCreditRates, parseUsdRates, priceUsage, resolveRates } = require('../pricing');

const credits = parseCreditRates('<h2>Codex rate card - token-based pricing</h2><p>Credits per 1M tokens</p><table><tr><td>GPT-5.6 Luna</td><td>25 credits</td><td>2.50 credits</td><td>150 credits</td></tr></table><h2>Legacy rate card</h2>');
const usd = parseUsdRates('<div>Standard</div><table><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Cache writes</th><th>Output</th></tr><tr><td>gpt-5.6-luna</td><td>$1.00</td><td>$0.10</td><td>$1.25</td><td>$6.00</td></tr><tr><td>gpt-5.5</td><td>$5.00</td><td>$0.50</td><td>-</td><td>$30.00</td></tr></table><div>Batch</div>');

assert.deepStrictEqual(resolveRates(credits, 'gpt-5.6-luna'), { input: 25, cached: 2.5, output: 150 });
assert.deepStrictEqual(resolveRates(usd, 'gpt-5.5'), { input: 5, cached: 0.5, output: 30 });
assert.strictEqual(priceUsage({ input_tokens: 1000, cached_tokens: 600, output_tokens: 100 }, { input: 1, cached: 0.1, output: 6 }), 0.00106);

const data = { week: { daily: [{ date: '2026-07-01', end: '2026-07-07' }], sessions: [{ timestamp: '2026-07-03T12:00:00Z', model: 'gpt-5.6-luna', usage: { input_tokens: 1000, cached_tokens: 600, output_tokens: 100 }, iterations: [] }] } };
applyPricing(data, { credits, usd, sources: { credits: 'credits', usd: 'usd' } });
assert.strictEqual(data.pricing.usd, 0.00106);
assert.strictEqual(data.pricing.credits, 0.0265);
assert.deepStrictEqual(data.week.daily[0].cost, { usd: 0.00106, credits: 0.0265 });
console.log('pricing checks passed');
