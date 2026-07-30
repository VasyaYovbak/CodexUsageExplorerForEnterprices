const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { summarizeSessions } = require('./usage');

const run = promisify(execFile);
let DatabaseSync;
let checkedSqlite = false;
const messages = new Map();
let sessions;
let latestUpdate = 0;
let databasePath;
let databaseSignature;
let database;

const text = (hex) => hex ? Buffer.from(hex, 'hex').toString('utf8') : '';

function sqlite() {
  if (!checkedSqlite) {
    checkedSqlite = true;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
  }
  return DatabaseSync;
}

function parseTsv(value) {
  const lines = value.trimEnd().split('\n');
  const headers = lines.shift()?.split('\t') || [];
  return lines.filter(Boolean).map((line) => Object.fromEntries(line.split('\t').map((item, index) => [headers[index], item])));
}

function parseRows(rows) {
  const result = new Map();
  for (const row of rows) {
    const cacheRead = Number(row.cache_read) || 0;
    const model = text(row.model_hex) || 'OpenCode';
    const parent = row.parent_id || row.message_id;
    const session = result.get(row.session_id) || {
      id: row.session_id,
      title: text(row.title_hex) || 'Untitled session',
      model,
      timestamp: new Date(Number(row.message_created)).toISOString(),
      usage: {},
      iterations: [],
      source: text(row.directory_hex),
    };
    const previous = session.iterations.at(-1);
    session.iterations.push({
      index: session.iterations.length + 1,
      timestamp: new Date(Number(row.message_created)).toISOString(),
      trigger: !previous || previous.parent !== parent ? 'User message' : 'Model call',
      label: text(row.prompt_hex).replace(/\s+/g, ' ').trim() || 'Model call',
      model,
      usage: {
        input_tokens: (Number(row.input_tokens) || 0) + cacheRead,
        output_tokens: Number(row.output_tokens) || 0,
        cached_tokens: cacheRead,
        reasoning_tokens: Number(row.reasoning_tokens) || 0,
        cached_writes: Number(row.cache_write) || 0,
      },
      cost: { usd: Number(row.cost) || 0, credits: null },
      parent,
    });
    if (session.model !== model) session.model = 'Multiple';
    session.timestamp = new Date(Number(row.message_created)).toISOString();
    result.set(row.session_id, session);
  }
  return [...result.values()];
}

function addCosts(data) {
  const price = (session) => {
    const usd = session.iterations.reduce((total, item) => total + item.cost.usd, 0);
    session.cost = { usd, credits: null };
    return usd;
  };
  const weekUsd = data.week.sessions.reduce((total, session) => total + price(session), 0);
  const todayUsd = data.today.sessions.reduce((total, session) => total + price(session), 0);
  const iterations = data.week.sessions.flatMap((session) => session.iterations);
  for (const bucket of data.week.daily) {
    const end = Date.parse(`${bucket.end}T00:00:00Z`) + 86400000;
    const start = Date.parse(`${bucket.date}T00:00:00Z`);
    bucket.cost = { usd: iterations.filter((item) => Date.parse(item.timestamp) >= start && Date.parse(item.timestamp) < end).reduce((total, item) => total + item.cost.usd, 0), credits: null };
  }
  data.today.cost = { usd: todayUsd, credits: null };
  data.pricing = { usd: weekUsd, credits: null, sources: {}, missingModels: [] };
  return data;
}

async function signature(execute) {
  if (execute !== run) return undefined;
  if (!databasePath) databasePath = (await execute('opencode', ['db', 'path'], { encoding: 'utf8', windowsHide: true })).stdout.trim();
  return [databasePath, `${databasePath}-wal`].map((file) => {
    try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return ''; }
  }).join(':');
}

async function loadSessions(execute) {
  const currentSignature = await signature(execute);
  if (sessions && currentSignature && currentSignature === databaseSignature) return sessions;
  // baza: OpenCode exposes updated rows but no deletion feed; the dashboard's
  // manual refresh rebuilds the cache. Use a change feed if the CLI adds one.
  const changed = messages.size ? ` AND m.time_updated >= ${latestUpdate}` : '';
  // baza: joining every prompt makes `opencode db` silently return partial
  // snapshots on large histories. Load prompt text on demand if details need it.
  const sql = `SELECT s.id AS session_id, hex(s.title) AS title_hex, hex(s.directory) AS directory_hex,
    m.id AS message_id, m.time_created AS message_created, m.time_updated AS message_updated,
    hex(coalesce(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.providerID'), 'OpenCode')) AS model_hex,
    json_extract(m.data, '$.parentID') AS parent_id, json_extract(m.data, '$.cost') AS cost,
    json_extract(m.data, '$.tokens.input') AS input_tokens, json_extract(m.data, '$.tokens.output') AS output_tokens,
    json_extract(m.data, '$.tokens.reasoning') AS reasoning_tokens, json_extract(m.data, '$.tokens.cache.read') AS cache_read,
    json_extract(m.data, '$.tokens.cache.write') AS cache_write, '' AS prompt_hex,
    COUNT(*) OVER() AS total_rows
    FROM session s JOIN message m ON m.session_id = s.id
    WHERE json_extract(m.data, '$.role') = 'assistant'${changed}
    ORDER BY s.id, m.time_created`;
  let rows;
  const NativeDatabase = execute === run && sqlite();
  if (NativeDatabase) {
    database ||= new NativeDatabase(databasePath, { readOnly: true });
    rows = database.prepare(sql).all();
  } else {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { stdout } = await execute('opencode', ['db', sql, '--format', 'tsv'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true });
      rows = parseTsv(stdout);
      if (rows.length === (Number(rows[0]?.total_rows) || 0)) break;
    }
  }
  if (rows.length !== (Number(rows[0]?.total_rows) || 0)) throw new Error(`OpenCode returned an incomplete usage snapshot (${rows.length}/${Number(rows[0]?.total_rows) || 0}); retry refresh`);
  for (const row of rows) {
    messages.set(row.message_id, row);
    latestUpdate = Math.max(latestUpdate, Number(row.message_updated) || 0);
  }
  sessions = parseRows(messages.values());
  databaseSignature = currentSignature;
  return sessions;
}

async function buildOpenCodeUsageData(now = new Date(), selection, execute = run) {
  let allSessions;
  try {
    allSessions = await loadSessions(execute);
  } catch (error) {
    throw new Error(`OpenCode is unavailable: ${error.stderr?.trim() || error.message}`);
  }
  return addCosts(summarizeSessions(allSessions, now, selection, { source: 'opencode', codexHome: 'OpenCode local database', malformedFiles: 0 }));
}

function clearOpenCodeCache() {
  database?.close();
  database = undefined;
  messages.clear();
  sessions = undefined;
  latestUpdate = 0;
  databaseSignature = undefined;
}

module.exports = { buildOpenCodeUsageData, clearOpenCodeCache, parseRows, parseTsv };
