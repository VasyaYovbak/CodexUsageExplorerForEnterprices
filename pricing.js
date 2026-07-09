const fs = require('fs');
const path = require('path');

const SOURCES = {
  // The .json route serves the same Help Center article without its bot-check interstitial.
  credits: 'https://help.openai.com/en/articles/20001106-codex-rate-card.json',
  usd: 'https://developers.openai.com/api/docs/pricing',
};
const DAY = 86400000;

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:tr|p|div|li|h[1-6]|section|table|thead|tbody)>/gi, '\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeModel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/^codex\s+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseCreditRates(html) {
  const lines = htmlToText(html);
  const start = lines.findIndex((line) => /credits per 1m tokens/i.test(line));
  if (start < 0) return new Map();
  const rates = new Map();
  for (const line of lines.slice(start)) {
    if (/^(legacy rate card|feature availability|frequently asked questions)$/i.test(line)) break;
    if (/research preview/i.test(line)) continue;
    const values = [...line.matchAll(/([\d,]+(?:\.\d+)?)\s+credits?/gi)];
    if (values.length < 3) continue;
    const model = normalizeModel(line.slice(0, values[0].index).replace(/^.*?((?:gpt|o\d)[a-z0-9 ._-]*)$/i, '$1'));
    if (!model.startsWith('gpt-') && !/^o\d/.test(model)) continue;
    rates.set(model, { input: Number(values[0][1].replaceAll(',', '')), cached: Number(values[1][1].replaceAll(',', '')), output: Number(values[2][1].replaceAll(',', '')) });
  }
  return rates;
}

function parseUsdRates(html) {
  const lines = htmlToText(html);
  const header = lines.findIndex((line) => /Model Input Cached input(?: Cache writes)? Output/i.test(line));
  if (header < 0) return new Map();
  const hasCacheWriteColumn = /Cache writes/i.test(lines[header]);
  const rates = new Map();
  for (const line of lines.slice(header + 1)) {
    if (/^(Batch|Flex|Priority)$/i.test(line)) break;
    const firstPrice = line.indexOf('$');
    if (firstPrice < 0) continue;
    const modelMatch = line.slice(0, firstPrice).match(/(?:gpt|o\d|chat-latest)[a-z0-9 ._()<>-]*/i);
    if (!modelMatch) continue;
    const values = [];
    for (const slot of line.slice(firstPrice).matchAll(/\$\s*([\d,]+(?:\.\d+)?)|(?:^|\s)-(?:\s|$)/g)) {
      values.push(slot[1] ? Number(slot[1].replaceAll(',', '')) : null);
    }
    const outputIndex = hasCacheWriteColumn ? 3 : 2;
    if (values.length <= outputIndex || values[0] === null || values[1] === null || values[outputIndex] === null) continue;
    rates.set(normalizeModel(modelMatch[0]), { input: values[0], cached: values[1], output: values[outputIndex] });
  }
  return rates;
}

function resolveRates(rates, model) {
  const requested = normalizeModel(model);
  const matches = [...rates].filter(([candidate]) => requested === candidate || requested.startsWith(`${candidate}-`));
  matches.sort((left, right) => right[0].length - left[0].length);
  return matches[0]?.[1];
}

function priceUsage(usage, rates) {
  if (!rates) return null;
  const fresh = Math.max(0, usage.input_tokens - usage.cached_tokens);
  return (fresh * rates.input + usage.cached_tokens * rates.cached + usage.output_tokens * rates.output) / 1_000_000;
}

async function fetchWithCache(url, cacheFile, now = Date.now()) {
  let cached;
  try { cached = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8')); } catch {}
  if (cached?.url === url && typeof cached.payload === 'string' && now - cached.fetchedAt <= DAY) return { ...cached, stale: false };
  try {
    const response = await fetch(url, { headers: { Accept: 'text/html, text/plain;q=0.9', 'User-Agent': 'codex-token-usage/0.1' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.text();
    const value = { url, payload, fetchedAt: now, stale: false };
    await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.promises.writeFile(cacheFile, JSON.stringify(value), 'utf8');
    return value;
  } catch (error) {
    if (cached?.url === url && typeof cached.payload === 'string' && now - cached.fetchedAt <= 30 * DAY) return { ...cached, stale: true };
    console.warn(`[Codex Usage] Pricing fetch failed for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadPricing(cacheDirectory) {
  const [credits, usd] = await Promise.all([
    fetchWithCache(SOURCES.credits, path.join(cacheDirectory, 'credits.json')),
    fetchWithCache(SOURCES.usd, path.join(cacheDirectory, 'usd.json')),
  ]);
  return {
    credits: credits ? parseCreditRates(credits.payload) : new Map(),
    usd: usd ? parseUsdRates(usd.payload) : new Map(),
    sources: {
      credits: credits ? `${credits.url}${credits.stale ? ' (stale cache)' : ''}` : null,
      usd: usd ? `${usd.url}${usd.stale ? ' (stale cache)' : ''}` : null,
    },
  };
}

function applyPricing(data, pricing) {
  const total = { usd: 0, credits: 0 };
  for (const bucket of data.week.daily || []) bucket.cost = { usd: 0, credits: 0 };
  let hasUsd = false;
  let hasCredits = false;
  const missing = new Set();
  for (const session of data.week.sessions) {
    const usdRates = resolveRates(pricing.usd, session.model);
    const creditRates = resolveRates(pricing.credits, session.model);
    if (!usdRates || !creditRates) missing.add(session.model);
    session.cost = { usd: priceUsage(session.usage, usdRates), credits: priceUsage(session.usage, creditRates) };
    const day = String(session.timestamp || '').slice(0, 10);
    const bucket = (data.week.daily || []).find((item) => item.date <= day && day <= item.end);
    if (bucket) {
      if (session.cost.usd !== null) bucket.cost.usd += session.cost.usd;
      if (session.cost.credits !== null) bucket.cost.credits += session.cost.credits;
    }
    for (const iteration of session.iterations) {
      iteration.cost = {
        usd: priceUsage(iteration.usage, resolveRates(pricing.usd, iteration.model) || usdRates),
        credits: priceUsage(iteration.usage, resolveRates(pricing.credits, iteration.model) || creditRates),
      };
    }
    if (session.cost.usd !== null) { total.usd += session.cost.usd; hasUsd = true; }
    if (session.cost.credits !== null) { total.credits += session.cost.credits; hasCredits = true; }
  }
  data.pricing = { usd: hasUsd ? total.usd : null, credits: hasCredits ? total.credits : null, sources: pricing.sources, missingModels: [...missing] };
  return data;
}

module.exports = { applyPricing, loadPricing, normalizeModel, parseCreditRates, parseUsdRates, priceUsage, resolveRates };
