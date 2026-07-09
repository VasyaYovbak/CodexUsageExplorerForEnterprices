const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cached_tokens', 'reasoning_tokens'];

function number(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function normalizeUsage(raw) {
  raw = raw || {};
  return {
    input_tokens: number(raw.input_tokens),
    output_tokens: number(raw.output_tokens),
    cached_tokens: number(raw.cached_input_tokens ?? raw.cached_tokens),
    reasoning_tokens: number(raw.reasoning_output_tokens ?? raw.reasoning_tokens),
    cached_writes: null,
  };
}

function addUsage(target, source) {
  for (const key of USAGE_KEYS) target[key] += source[key] || 0;
  return target;
}

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
}

function expandHome(value) {
  if (!value || value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function walkJsonl(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonl(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
  }
  return files;
}

function loadSessionIndex(codexHome) {
  const index = new Map();
  const file = path.join(codexHome, 'session_index.jsonl');
  if (!fs.existsSync(file)) return index;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const item = JSON.parse(line);
      if (item.id) index.set(item.id, item.thread_name || 'Untitled session');
    } catch {
      // A partially written index line should not hide the usable sessions.
    }
  }
  return index;
}

function titleFromMessage(message) {
  if (!message) return 'Untitled session';
  const oneLine = String(message).replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 69)}…` : oneLine;
}

function parseTranscript(file, titles) {
  let meta;
  let firstUserMessage;
  let lastToken;
  let tokenTimestamp;
  let model;
  let malformedLines = 0;
  const iterations = [];
  const toolNames = new Map();
  let trigger;
  let pendingToolTrigger;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (record.type === 'session_meta') {
      meta = record.payload || {};
      model = meta.model || model;
      continue;
    }
    const payload = record.payload || {};
    if (record.type === 'turn_context') model = payload.model || model;
    if (record.type === 'response_item' && payload.type === 'function_call') {
      toolNames.set(payload.call_id, payload.name || 'tool');
    }
    if (record.type === 'response_item' && payload.type === 'function_call_output') {
      pendingToolTrigger = { type: 'Tool response', label: toolNames.get(payload.call_id) || 'Tool response' };
    }
    if (record.type !== 'event_msg') continue;
    if (payload.type === 'user_message' && !firstUserMessage) {
      firstUserMessage = payload.message || payload.text;
    }
    if (payload.type === 'user_message') {
      trigger = { type: 'User message', label: titleFromMessage(payload.message || payload.text) };
      pendingToolTrigger = undefined;
    }
    if (payload.type === 'turn_context') model = payload.model || model;
    if (payload.type === 'token_count' && payload.info) {
      lastToken = payload.info;
      tokenTimestamp = record.timestamp || tokenTimestamp;
      model = payload.model || model;
      if (lastToken.last_token_usage) {
      // baza: Codex does not link usage events to their input event. Transcript
      // order lets us carry a tool result to the next LLM call; use provider
      // call IDs instead if Codex exposes that relationship later.
        const iterationTrigger = trigger || pendingToolTrigger;
        iterations.push({
          index: iterations.length + 1,
          timestamp: record.timestamp || tokenTimestamp,
          trigger: iterationTrigger?.type || 'Model call',
          label: iterationTrigger?.label || 'Model call',
          model: model || 'Codex',
          usage: normalizeUsage(lastToken.last_token_usage),
        });
      }
      trigger = trigger ? pendingToolTrigger : undefined;
      pendingToolTrigger = undefined;
    }
  }

  if (!lastToken) return null;
  const sessionId = meta?.session_id || meta?.id || path.basename(file).match(/[0-9a-f-]{20,}/i)?.[0] || file;
  const timestamp = tokenTimestamp || meta?.timestamp || fs.statSync(file).mtime.toISOString();
  const totalUsage = normalizeUsage(lastToken.total_token_usage || lastToken.last_token_usage);
  return {
    id: sessionId,
    title: titles.get(sessionId) || titleFromMessage(firstUserMessage),
    model: model || 'Codex',
    timestamp,
    usage: totalUsage,
    iterations,
    cached_writes: null,
    source: file,
    malformedLines,
  };
}

function mondayUtc(date) {
  const utcDay = date.getUTCDay();
  const daysSinceMonday = (utcDay + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseUtcDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${name} must be a valid date`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`${name} must be a valid date`);
  return time;
}

function resolveRange(now, selection = {}) {
  const mode = ['week', 'month', 'custom'].includes(selection.mode) ? selection.mode : 'week';
  let startMs;
  let endMs;
  let normalized;
  if (mode === 'month') {
    if (!/^\d{4}-\d{2}$/.test(selection.month || '')) throw new Error('Month must be valid');
    startMs = parseUtcDay(`${selection.month}-01`, 'Month');
    const start = new Date(startMs);
    endMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    normalized = { mode, month: selection.month };
  } else if (mode === 'custom') {
    startMs = parseUtcDay(selection.start, 'Start date');
    endMs = parseUtcDay(selection.end, 'End date') + 86400000;
    if (endMs <= startMs) throw new Error('End date must not be before start date');
    if ((endMs - startMs) / 86400000 > 366) throw new Error('Custom ranges are limited to 366 days');
    normalized = { mode, start: selection.start, end: selection.end };
  } else {
    const anchor = selection.anchor ? new Date(parseUtcDay(selection.anchor, 'Week')) : now;
    startMs = mondayUtc(anchor);
    endMs = startMs + 7 * 86400000;
    normalized = { mode, anchor: new Date(startMs).toISOString().slice(0, 10) };
  }
  return { startMs, endMs, selection: normalized };
}

function parseFilesInParallel(files, titles, onProgress) {
  if (!files.length) return Promise.resolve({ sessions: [], malformedFiles: 0 });
  const cpuCount = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const workerCount = Math.min(Math.max(cpuCount, 1), files.length, 8);
  const titleEntries = [...titles.entries()];

  return new Promise((resolve, reject) => {
    const workers = [];
    const sessions = [];
    let nextFile = 0;
    let completed = 0;
    let malformedFiles = 0;
    let settled = false;

    const stop = () => workers.forEach((worker) => worker.terminate());
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    };
    const finish = () => {
      if (settled || completed !== files.length) return;
      settled = true;
      Promise.all(workers.map((worker) => worker.terminate())).then(() => resolve({ sessions, malformedFiles }));
    };
    const assign = (worker) => {
      if (settled) return;
      if (nextFile >= files.length) {
        worker.postMessage({ type: 'stop' });
        return;
      }
      worker.postMessage({ type: 'parse', file: files[nextFile++] });
    };

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(path.join(__dirname, 'usage-worker.js'));
      workers.push(worker);
      worker.postMessage({ type: 'init', titles: titleEntries });
      worker.on('message', (result) => {
        if (result.error) malformedFiles += 1;
        if (result.session) sessions.push(result.session);
        completed += 1;
        onProgress?.(completed, files.length);
        if (completed === files.length) finish();
        else assign(worker);
      });
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (code !== 0) fail(new Error(`Usage worker exited with code ${code}`));
      });
      assign(worker);
    }
  });
}

async function buildUsageData(configuredHome, now = new Date(), onProgress, selection) {
  const codexHome = expandHome(configuredHome || '~/.codex');
  const titles = loadSessionIndex(codexHome);
  const files = [
    ...walkJsonl(path.join(codexHome, 'sessions')),
    ...walkJsonl(path.join(codexHome, 'archived_sessions')),
  ];
  const parsed = await parseFilesInParallel(files, titles, onProgress);
  const byId = new Map();
  for (const session of parsed.sessions) {
    if (session.malformedLines) parsed.malformedFiles += 1;
    const previous = byId.get(session.id);
    if (!previous || new Date(session.timestamp) > new Date(previous.timestamp)) byId.set(session.id, session);
  }

  const sessions = [...byId.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const { startMs, endMs, selection: normalizedSelection } = resolveRange(now, selection);
  const rangeSessions = sessions.filter((session) => {
    const time = new Date(session.timestamp).getTime();
    return Number.isFinite(time) && time >= startMs && time < endMs;
  });
  const rangeTotal = emptyUsage();
  const dayCount = (endMs - startMs) / 86400000;
  const showDays = dayCount <= 7;
  const bucketCount = showDays ? dayCount : Math.ceil(dayCount / 7);
  const daily = Array.from({ length: bucketCount }, (_, index) => {
    const firstOffset = showDays ? index : index * 7;
    const lastOffset = showDays ? firstOffset : Math.min(firstOffset + 6, dayCount - 1);
    const first = new Date(startMs + firstOffset * 86400000);
    const last = new Date(startMs + lastOffset * 86400000);
    const shortDate = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const label = showDays
      ? first.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
      : `${shortDate(first)}–${shortDate(last)}`;
    return { date: dayKey(first), end: dayKey(last), label, usage: emptyUsage() };
  });
  for (const session of rangeSessions) {
    addUsage(rangeTotal, session.usage);
    const dayOffset = Math.floor((new Date(session.timestamp).getTime() - startMs) / 86400000);
    const bucket = daily[showDays ? dayOffset : Math.floor(dayOffset / 7)];
    if (bucket) addUsage(bucket.usage, session.usage);
  }

  return {
    week: {
      start: new Date(startMs).toISOString().slice(0, 10),
      end: new Date(endMs - 1).toISOString().slice(0, 10),
      selection: normalizedSelection,
      total: rangeTotal,
      daily,
      sessions: rangeSessions,
    },
    meta: { codexHome, sessionCount: rangeSessions.length, malformedFiles: parsed.malformedFiles },
  };
}

module.exports = { buildUsageData, mondayUtc, normalizeUsage, parseTranscript, resolveRange };
