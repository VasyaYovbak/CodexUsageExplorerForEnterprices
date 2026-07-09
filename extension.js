const vscode = require('vscode');
const { buildUsageData } = require('./usage');
const { applyPricing, loadPricing } = require('./pricing');

class UsageViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = dashboardHtml();
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'ready') this.refresh();
      if (message.type === 'refresh') this.refresh();
      if (message.type === 'range') {
        this.range = message.range;
        this.refresh();
      }
      if (message.type === 'settings') vscode.commands.executeCommand('codexUsage.openSettings');
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
  }

  async refresh() {
    if (!this.view || this.refreshing) return;
    this.refreshing = true;
    const codexHome = vscode.workspace.getConfiguration('codexUsage').get('codexHome', '~/.codex');
    try {
      this.view.webview.postMessage({ type: 'progress', completed: 0, total: 0 });
      const [data, pricing] = await Promise.all([
        buildUsageData(codexHome, new Date(), (completed, total) => {
          this.view?.webview.postMessage({ type: 'progress', completed, total });
        }, this.range),
        loadPricing(this.context.globalStorageUri.fsPath),
      ]);
      applyPricing(data, pricing);
      this.view.webview.postMessage({ type: 'data', data });
    } catch (error) {
      this.view?.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.refreshing = false;
    }
  }
}

function activate(context) {
  const provider = new UsageViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexUsage.dashboard', provider),
    vscode.commands.registerCommand('codexUsage.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('codexUsage.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.codex-token-usage')),
  );
  const timer = setInterval(() => provider.refresh(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function dashboardHtml() {
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Codex Usage</title>
<style>
  :root { color-scheme: dark; --bg: #0d111c; --panel: #151c2d; --panel-2: #1b2539; --text: #f4f7ff; --muted: #8994aa; --line: #28334a; --cyan: #4de1d5; --purple: #a88bff; --pink: #ef8dca; }
  * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #46526b transparent; }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { border-radius: 8px; background: #46526b; }
  html { min-height: 100%; background: var(--bg); }
  body { min-height: 100vh; margin: 0; padding: 22px 18px 28px; color: var(--text); background: radial-gradient(circle at 80% 0, #26365d 0, transparent 42%) fixed, var(--bg); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #app { min-height: calc(100vh - 50px); display: flex; flex-direction: column; }
  button { color: inherit; font: inherit; cursor: pointer; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 22px; }
  .eyebrow { color: var(--cyan); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  h1 { margin: 4px 0 4px; font-size: 25px; letter-spacing: -.04em; }
  .subtle, .muted { color: var(--muted); }
  .icon-button { width: 33px; height: 33px; border: 1px solid var(--line); border-radius: 10px; background: #192238; }
  .icon-button:hover { border-color: var(--cyan); color: var(--cyan); }
  .tabs { display: flex; gap: 6px; margin-bottom: 15px; padding: 3px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel); }
  .tab { flex: 1; padding: 6px 10px; border: 0; border-radius: 8px; color: var(--muted); background: transparent; }
  .tab[aria-selected="true"] { color: var(--text); background: var(--panel-2); }
  .tab-panel[hidden] { display: none; }
  .tab-panel[data-panel="overview"]:not([hidden]) { flex: 1; display: flex; flex-direction: column; }
  .range { margin: 0 0 15px; color: var(--muted); font-size: 12px; }
  .range-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-bottom: 11px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: rgba(21,28,45,.78); }
  .range-control { display: grid; gap: 4px; color: var(--muted); font-size: 10px; }
  select, input { min-height: 30px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: var(--panel-2); font: inherit; }
  .range-button { min-height: 30px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  .range-button.primary { border-color: #3b827e; color: var(--cyan); }
  .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-bottom: 15px; }
  .card, .chart, .sessions { border: 1px solid var(--line); border-radius: 16px; background: linear-gradient(145deg, rgba(29,40,64,.96), rgba(16,22,36,.96)); box-shadow: 0 14px 34px rgba(0,0,0,.16); }
  .card { padding: 13px; min-width: 0; }
  .card-label { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
  .dot { width: 7px; height: 7px; display: inline-block; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 10px var(--cyan); }
  .card-value { margin-top: 6px; font-size: 20px; font-weight: 700; letter-spacing: -.04em; }
  .card-note { margin-top: 3px; color: var(--muted); font-size: 10px; }
  .chart { flex: 1; display: flex; flex-direction: column; min-height: 197px; padding: 15px 14px 12px; margin-bottom: 15px; }
  .section-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 17px; font-weight: 700; }
  .chart-toggle { display: flex; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  .chart-toggle button { padding: 3px 7px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; font-size: 9px; }
  .chart-toggle button[aria-pressed="true"] { color: var(--text); background: #2a3650; }
  .chart-scroll { flex: 1; min-height: 165px; display: flex; overflow: hidden; }
  .chart-grid { flex: 1; width: 100%; min-height: 165px; display: grid; gap: 8px; align-items: end; }
  .bar-column { height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 7px; }
  .bar-wrap { flex: 1; min-height: 115px; width: 100%; display: flex; align-items: end; justify-content: center; }
  .bar-measure { width: 100%; min-height: 4px; display: flex; flex-direction: column; align-items: center; gap: 5px; transition: height .35s ease; }
  .bar { flex: 1; width: min(25px, 72%); min-height: 4px; border-radius: 7px 7px 3px 3px; background: linear-gradient(180deg, var(--cyan), #4389e9); box-shadow: 0 0 16px rgba(77,225,213,.22); }
  .bar-column.today .bar { background: linear-gradient(180deg, var(--pink), var(--purple)); }
  .bar-label { min-height: 24px; color: var(--muted); font-size: 10px; line-height: 1.2; text-align: center; }
  .bar-value { color: var(--text); font-size: 9px; }
  .bar-value:empty { display: none; }
  .sessions { overflow: hidden; }
  .sessions-head { padding: 15px 14px 11px; border-bottom: 1px solid var(--line); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; min-width: 760px; border-collapse: collapse; text-align: left; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-size: 10px; font-weight: 600; text-transform: uppercase; }
  td { font-size: 11px; }
  tbody tr:hover { background: rgba(77,225,213,.04); }
  .session-link { padding: 0; border: 0; color: var(--cyan); background: transparent; font-family: monospace; }
  .table-title { max-width: 230px; overflow: hidden; text-overflow: ellipsis; }
  .pagination { display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 11px 13px; color: var(--muted); font-size: 10px; }
  .page-button { padding: 4px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel-2); }
  .page-button:disabled { cursor: default; opacity: .4; }
  .iteration-note { padding: 11px 13px; color: var(--muted); font-size: 10px; }
  .session { padding: 13px 14px; border-bottom: 1px solid var(--line); }
  .session:last-child { border-bottom: 0; }
  .session-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .session-title { overflow: hidden; color: var(--text); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .session-total { flex: 0 0 auto; color: var(--cyan); font-weight: 700; }
  .session-meta { display: flex; gap: 8px; margin-top: 4px; color: var(--muted); font-size: 10px; }
  details { margin-top: 10px; }
  summary { color: var(--purple); cursor: pointer; font-size: 11px; }
  .breakdown { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; margin-top: 9px; }
  .metric { padding: 8px; border-radius: 9px; background: var(--panel-2); }
  .metric b { display: block; margin-top: 2px; font-size: 12px; }
  .empty { padding: 24px 12px; text-align: center; color: var(--muted); }
  .loading { padding: 34px 12px; text-align: center; color: var(--muted); }
  .progress { position: relative; overflow: hidden; width: 100%; height: 20px; margin: 14px 0 9px; border-radius: 99px; background: #25314a; }
  .progress::after { position: absolute; top: 0; left: -35%; width: 35%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, transparent, var(--cyan), var(--purple)); content: ""; animation: scan 1.1s ease-in-out infinite; }
  .progress.determinate::after { left: 0; width: var(--progress); animation: none; }
  .progress-count { position: relative; z-index: 1; color: var(--text); font-size: 11px; font-weight: 700; line-height: 20px; }
  @keyframes scan { from { left: -35%; } to { left: 100%; } }
  .error { margin-bottom: 15px; padding: 11px 12px; border: 1px solid #7b4659; border-radius: 11px; color: #ffb8cc; background: #321d2b; }
  .footer { margin-top: 15px; color: var(--muted); font-size: 10px; text-align: center; }
  @media (min-width: 430px) { body { padding-inline: 24px; } .cards { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); } .breakdown { grid-template-columns: repeat(4, 1fr); } }
</style>
</head>
<body>
<main id="app"><div class="loading"><div id="progress-label">Reading Codex sessions…</div><div id="progress-bar" class="progress" role="progressbar" aria-label="Reading Codex sessions"><span id="progress-count" class="progress-count">0 processed</span></div><small>Scanning transcripts and calculating this UTC week</small></div></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fmt = (value) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
  const full = (value) => new Intl.NumberFormat('en-US').format(value || 0);
  const date = (value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = (value) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const usd = (value) => value == null ? '—' : '$' + value.toFixed(value < .01 ? 4 : 2);
  const credits = (value) => value == null ? '—' : value.toFixed(value < .01 ? 4 : 2);
  const metric = (label, value, note, color) => '<div class="card"><div class="card-label"><span>' + label + '</span><span class="dot" style="background:' + color + ';box-shadow:0 0 10px ' + color + '"></span></div><div class="card-value">' + (typeof value === 'string' ? value : fmt(value)) + '</div><div class="card-note">' + note + '</div></div>';
  const freshInput = (usage) => Math.max(0, usage.input_tokens - usage.cached_tokens);
  const PAGE_SIZE = 10;
  let activeTab = 'overview';
  let currentData;
  let sessionPage = 0;
  let selectedSessionId;
  let chartCurrency = 'credits';
  function selectTab(tab) {
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
    document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
  }
  function render(data) {
    currentData = data;
    const total = data.week.total;
    const max = Math.max(Number.EPSILON, ...data.week.daily.map((item) => item.cost?.[chartCurrency] || 0));
    const pageCount = Math.max(1, Math.ceil(data.week.sessions.length / PAGE_SIZE));
    sessionPage = Math.min(sessionPage, pageCount - 1);
    const pageSessions = data.week.sessions.slice(sessionPage * PAGE_SIZE, (sessionPage + 1) * PAGE_SIZE);
    if (!data.week.sessions.some((session) => session.id === selectedSessionId)) selectedSessionId = data.week.sessions[0]?.id;
    const selected = data.week.sessions.find((session) => session.id === selectedSessionId);
    const selection = data.week.selection;
    let rangeFields;
    if (selection.mode === 'month') rangeFields = '<label class="range-control">Month<input id="range-month" type="month" value="' + escapeHtml(selection.month) + '"></label>';
    else if (selection.mode === 'custom') rangeFields = '<label class="range-control">Start<input id="range-start" type="date" value="' + escapeHtml(selection.start) + '"></label><label class="range-control">End<input id="range-end" type="date" value="' + escapeHtml(selection.end) + '"></label>';
    else rangeFields = '<button class="range-button" data-week-shift="-7" title="Previous week">←</button><label class="range-control">Week containing<input id="range-anchor" type="date" value="' + escapeHtml(selection.anchor) + '"></label><button class="range-button" data-week-shift="7" title="Next week">→</button>';
    const rangeControls = '<div class="range-toolbar"><label class="range-control">Range<select id="range-mode"><option value="week"' + (selection.mode === 'week' ? ' selected' : '') + '>Week</option><option value="month"' + (selection.mode === 'month' ? ' selected' : '') + '>Month</option><option value="custom"' + (selection.mode === 'custom' ? ' selected' : '') + '>Custom</option></select></label>' + rangeFields + '<button class="range-button primary" data-apply-range>Apply</button></div>';
    const sessionRows = pageSessions.map((session) => {
      const usage = session.usage;
      return '<tr><td><button class="session-link" data-session="' + escapeHtml(session.id) + '" title="Open iterations for ' + escapeHtml(session.id) + '">' + escapeHtml(session.id.slice(0, 8)) + '…</button></td><td class="table-title" title="' + escapeHtml(session.title) + '">' + escapeHtml(session.title) + '</td><td>' + escapeHtml(session.model) + '</td><td>' + full(freshInput(usage)) + '</td><td>' + full(usage.cached_tokens) + '</td><td>' + full(usage.output_tokens) + '</td><td>' + full(usage.input_tokens + usage.output_tokens) + '</td><td>' + credits(session.cost?.credits) + '</td><td>' + usd(session.cost?.usd) + '</td><td>' + date(session.timestamp) + ' ' + time(session.timestamp) + '</td></tr>';
    }).join('');
    const iterationRows = (selected?.iterations || []).map((iteration) => {
      const usage = iteration.usage;
      return '<tr><td>' + iteration.index + '</td><td>' + escapeHtml(iteration.trigger) + '</td><td class="table-title" title="' + escapeHtml(iteration.label) + '">' + escapeHtml(iteration.label) + '</td><td>' + escapeHtml(iteration.model) + '</td><td>' + full(freshInput(usage)) + '</td><td>' + full(usage.cached_tokens) + '</td><td>' + full(usage.output_tokens) + '</td><td>' + full(usage.reasoning_tokens) + '</td><td>' + full(usage.input_tokens + usage.output_tokens) + '</td><td>' + credits(iteration.cost?.credits) + '</td><td>' + usd(iteration.cost?.usd) + '</td><td>' + time(iteration.timestamp) + '</td></tr>';
    }).join('');
    const today = new Date().toISOString().slice(0, 10);
    const chart = data.week.daily.map((item) => { const value = item.cost?.[chartCurrency] || 0; const shown = chartCurrency === 'usd' ? usd(value) : credits(value); const height = Math.max(value ? 5 : 2, Math.round(value / max * 100)); const end = item.end || item.date; return '<div class="bar-column ' + (item.date <= today && today <= end ? 'today' : '') + '" title="' + item.date + (end === item.date ? '' : ' – ' + end) + ' · ' + shown + (chartCurrency === 'credits' ? ' credits' : '') + '"><div class="bar-wrap"><div class="bar-measure" style="height:' + height + '%"><span class="bar-value">' + (value ? shown : '') + '</span><div class="bar"></div></div></div><span class="bar-label">' + item.label + '</span></div>'; }).join('');
    const sessionTable = sessionRows ? '<div class="table-wrap"><table><thead><tr><th>Session ID</th><th>Title</th><th>Model</th><th>Fresh</th><th>Cached</th><th>Output</th><th>Total</th><th>Credits</th><th>USD</th><th>Last activity</th></tr></thead><tbody>' + sessionRows + '</tbody></table></div><div class="pagination"><button class="page-button" data-page="' + (sessionPage - 1) + '"' + (sessionPage === 0 ? ' disabled' : '') + '>Previous</button><span>Page ' + (sessionPage + 1) + ' of ' + pageCount + '</span><button class="page-button" data-page="' + (sessionPage + 1) + '"' + (sessionPage + 1 >= pageCount ? ' disabled' : '') + '>Next</button></div>' : '<div class="empty">No token usage recorded in this range.</div>';
    const iterationTable = iterationRows ? '<div class="table-wrap"><table><thead><tr><th>#</th><th>Triggered by</th><th>Context</th><th>Model</th><th>Fresh</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Credits</th><th>USD</th><th>Time</th></tr></thead><tbody>' + iterationRows + '</tbody></table></div><div class="iteration-note">One row per Codex <code>last_token_usage</code> event. User/tool context is inferred from transcript order.</div>' : '<div class="empty">' + (selected ? 'No per-call usage was recorded for this session.' : 'Select a session first.') + '</div>';
    app.innerHTML = '<header class="top"><div><div class="eyebrow">Local telemetry</div><h1>Codex usage</h1><div class="subtle">Your token pulse, without the noise.</div></div><button class="icon-button" aria-label="Refresh usage" title="Refresh" onclick="vscode.postMessage({type:\\'refresh\\'})">↻</button></header><nav class="tabs" role="tablist" aria-label="Usage views"><button class="tab" role="tab" data-tab="overview">Overview</button><button class="tab" role="tab" data-tab="sessions">Sessions (' + data.meta.sessionCount + ')</button><button class="tab" role="tab" data-tab="iterations">Iterations</button></nav>' + rangeControls + '<div class="range">' + date(data.week.start) + ' – ' + date(data.week.end) + ' <span class="muted">· UTC</span></div><div class="tab-panel" data-panel="overview" role="tabpanel"><section class="cards">' + metric('Fresh input', freshInput(total), 'input not served from cache', '#4de1d5') + metric('Output', total.output_tokens, 'assistant tokens', '#a88bff') + metric('Cached input', total.cached_tokens, 'provider cache hits', '#ef8dca') + metric('Reasoning', total.reasoning_tokens, 'inside output', '#ffbd72') + metric('Credits', credits(data.pricing.credits), 'official Codex token rates', '#7ed7ff') + metric('USD', usd(data.pricing.usd), 'standard API rates', '#8fe388') + '</section><section class="chart"><div class="section-title"><span>Activity</span><span class="muted">' + fmt(total.input_tokens + total.output_tokens) + ' total</span></div><div class="chart-scroll"><div class="chart-grid" style="grid-template-columns:repeat(' + data.week.daily.length + ',minmax(28px,1fr))">' + chart + '</div></div></section></div><div class="tab-panel" data-panel="sessions" role="tabpanel"><section class="sessions"><div class="sessions-head section-title"><span>Sessions</span><span class="muted">' + data.meta.sessionCount + '</span></div>' + sessionTable + '</section></div><div class="tab-panel" data-panel="iterations" role="tabpanel"><section class="sessions"><div class="sessions-head section-title"><span>Iterations' + (selected ? ' · ' + escapeHtml(selected.title) : '') + '</span><span class="muted">' + (selected?.iterations?.length || 0) + ' model calls</span></div>' + iterationTable + '</section></div><div class="footer">' + escapeHtml(data.meta.codexHome) + (data.pricing.missingModels.length ? ' · Pricing unavailable for: ' + escapeHtml(data.pricing.missingModels.join(', ')) : '') + (data.meta.malformedFiles ? ' · Some incomplete transcript lines were skipped.' : '') + '</div>';
    app.querySelector('.chart-grid').style.gridTemplateColumns = 'repeat(' + data.week.daily.length + ', minmax(0, 1fr))';
    app.querySelector('.chart .section-title .muted').outerHTML = '<div class="chart-toggle" aria-label="Chart currency"><button data-chart-currency="credits" aria-pressed="' + (chartCurrency === 'credits') + '">Credits</button><button data-chart-currency="usd" aria-pressed="' + (chartCurrency === 'usd') + '">USD</button></div>';
    app.querySelector('.footer').remove();
    selectTab(activeTab);
  }
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) selectTab(tab.dataset.tab);
    const currency = event.target.closest('[data-chart-currency]');
    if (currency) { chartCurrency = currency.dataset.chartCurrency; render(currentData); }
    const weekShift = event.target.closest('[data-week-shift]');
    if (weekShift) {
      const anchor = new Date(document.getElementById('range-anchor').value + 'T00:00:00Z');
      anchor.setUTCDate(anchor.getUTCDate() + Number(weekShift.dataset.weekShift));
      vscode.postMessage({ type: 'range', range: { mode: 'week', anchor: anchor.toISOString().slice(0, 10) } });
    }
    if (event.target.closest('[data-apply-range]')) {
      const mode = document.getElementById('range-mode').value;
      const range = mode === 'month' ? { mode, month: document.getElementById('range-month').value } : mode === 'custom' ? { mode, start: document.getElementById('range-start').value, end: document.getElementById('range-end').value } : { mode, anchor: document.getElementById('range-anchor').value };
      vscode.postMessage({ type: 'range', range });
    }
    const session = event.target.closest('[data-session]');
    if (session) { selectedSessionId = session.dataset.session; activeTab = 'iterations'; render(currentData); }
    const page = event.target.closest('[data-page]');
    if (page && !page.disabled) { sessionPage = Number(page.dataset.page); render(currentData); }
  });
  document.addEventListener('change', (event) => {
    if (event.target.id !== 'range-mode') return;
    const mode = event.target.value;
    currentData.week.selection = mode === 'month' ? { mode, month: currentData.week.start.slice(0, 7) } : mode === 'custom' ? { mode, start: currentData.week.start, end: currentData.week.end } : { mode, anchor: currentData.week.start };
    render(currentData);
  });
  window.addEventListener('message', (event) => { if (event.data.type === 'progress' && event.data.total) { const percent = Math.round(event.data.completed / event.data.total * 100); const remaining = event.data.total - event.data.completed; document.getElementById('progress-label').textContent = 'Processed ' + event.data.completed + ' · Remaining ' + remaining + ' · Total ' + event.data.total; document.getElementById('progress-count').textContent = event.data.completed + ' / ' + event.data.total + ' (' + percent + '%)'; const bar = document.getElementById('progress-bar'); bar.classList.add('determinate'); bar.style.setProperty('--progress', percent + '%'); bar.setAttribute('aria-valuenow', percent); bar.setAttribute('aria-valuetext', event.data.completed + ' of ' + event.data.total + ' sessions processed'); } if (event.data.type === 'data') render(event.data.data); if (event.data.type === 'error') app.innerHTML = '<div class="error">Could not read Codex usage: ' + escapeHtml(event.data.message) + '</div>'; });
  vscode.postMessage({type: 'ready'});
</script>
</body>
</html>`;
}

module.exports = { activate };
