import './style.css';
import { historyError, type History } from '../../src/core/types';
import { City3D } from './city3d';
import { CityModel, type ColorMode, type HeightMode } from './model';
import { Treemap2D } from './treemap2d';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SPEEDS = [1, 3, 10, 30, 100, 300, 1000];

const el = {
  stage: $('stage'),
  repo: $('repo-name'),
  stats: $('stats'),
  commit: $('commit-panel'),
  legend: $('legend'),
  file: $('file-panel'),
  scrubber: $<HTMLInputElement>('scrubber'),
  activity: $<HTMLCanvasElement>('activity'),
  timeLabel: $('time-label'),
  play: $<HTMLButtonElement>('play'),
  speed: $<HTMLSelectElement>('speed'),
  heightMode: $<HTMLSelectElement>('height-mode'),
  tooltip: $('tooltip'),
  drop: $('drop-overlay'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  fileInput: $<HTMLInputElement>('file-input'),
};

let model: CityModel | null = null;
let view: '3d' | '2d' = '3d';
let playing = false;
let playhead = 0;
let speed = 10;
let shownVersion = -1;
let shownSelection = -2;

const select = (file: number) => {
  if (!model) return;
  model.selected = file;
  shownSelection = -2;
};
const hover = (file: number, x: number, y: number) => {
  if (!model || file < 0) {
    el.tooltip.classList.add('hidden');
    return;
  }
  const r = model.replayer;
  el.tooltip.innerHTML = `${esc(model.history.files[file])}<br><span class="muted">${r.binary[file] ? 'binary' : `${fmt(r.lines[file])} lines`}</span>`;
  el.tooltip.style.left = `${Math.min(x + 14, window.innerWidth - 300)}px`;
  el.tooltip.style.top = `${y + 14}px`;
  el.tooltip.classList.remove('hidden');
};

const city = createCity();
const treemap = new Treemap2D(el.stage, { onSelect: select, onHover: hover });

function createCity(): City3D | null {
  try {
    return new City3D(el.stage, { onSelect: select, onHover: hover });
  } catch (err) {
    console.warn('WebGL unavailable, falling back to 2D', err);
    return null;
  }
}

// ---------- helpers ----------

/** How many commits the "recently changed" glow lasts: roughly 0.6s of playback. */
function glowDecayFor(commitsPerSecond: number): number {
  return Math.min(80, Math.max(4, commitsPerSecond * 0.6));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtDate(ts: number, withTime = true): string {
  const d = new Date(ts * 1000);
  const date = d.toISOString().slice(0, 10);
  return withTime ? `${date} ${d.toTimeString().slice(0, 5)}` : date;
}

function dot(color: string): string {
  return `<span class="dot" style="background:${color};color:${color}"></span>`;
}

// ---------- loading ----------

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const src = params.get('data') ?? 'demo.json';
  try {
    el.loadingText.textContent = `Loading ${src}…`;
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${src}`);
    const data: unknown = await res.json();
    setHistory(checkHistory(data, src));
    applyParams(params);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

/** Deep-link options: ?view=2d&color=author&height=log&commit=120&file=src/app.ts&speed=30&play=1 */
function applyParams(params: URLSearchParams): void {
  if (!model) return;
  const v = params.get('view');
  if (v === '2d' || v === '3d') setView(v);
  const c = params.get('color');
  if (c === 'ext' || c === 'author') setColorMode(c);
  const h = params.get('height');
  if (h === 'linear' || h === 'sqrt' || h === 'log') {
    el.heightMode.value = h;
    model.setHeightMode(h);
  }
  const at = params.get('commit');
  if (at !== null && at !== '') {
    const n = Number(at);
    const byHash = model.history.commits.findIndex((cm) => at.length >= 4 && cm[3].startsWith(at));
    seek(byHash >= 0 ? byHash : Number.isFinite(n) ? n - 1 : model.index);
  }
  const file = params.get('file');
  if (file) {
    const idx = model.history.files.indexOf(file);
    if (idx >= 0) select(idx);
  }
  const sp = Number(params.get('speed'));
  if (SPEEDS.includes(sp)) {
    speed = sp;
    el.speed.value = String(sp);
    model.glowDecay = glowDecayFor(sp);
  }
  if (params.get('play') === '1') togglePlay();
}

function showError(msg: string): void {
  el.loading.classList.remove('hidden');
  el.loading.classList.add('error');
  el.loading.innerHTML = `<div>⚠ ${esc(msg)}</div><div class="muted">Generate data with <code>git-cityscape extract &lt;repo&gt; -o history.json</code>, then open <code>?data=history.json</code> or drop the file here.</div>`;
}

/** Validate loaded data before it can replace the active model. */
function checkHistory(data: unknown, name: string): History {
  const err = historyError(data);
  if (err) throw new Error(`${name} is not a valid git-cityscape history file (${err})`);
  return data as History;
}

function setHistory(history: History): void {
  el.loadingText.textContent = 'Raising the skyline…';
  const next = new CityModel(history);
  playing = false;
  model = next;
  const n = history.commits.length;
  speed = SPEEDS.reduce((best, s) => (Math.abs(s - n / 40) < Math.abs(best - n / 40) ? s : best), SPEEDS[0]);
  el.speed.value = String(speed);
  model.glowDecay = glowDecayFor(speed);
  model.setColorMode(currentColorMode);
  model.setHeightMode(el.heightMode.value as HeightMode);
  city?.setModel(model);
  treemap.setModel(model);
  el.scrubber.min = '-1';
  el.scrubber.max = String(Math.max(-1, n - 1));
  el.repo.textContent = history.repo + (history.baseline ? ' (windowed)' : '');
  document.title = `${history.repo} · git-cityscape`;
  model.seek(n - 1);
  playhead = n - 1;
  shownVersion = -1;
  shownSelection = -2;
  drawActivity();
  renderLegend();
  el.loading.classList.add('hidden');
  el.loading.classList.remove('error');
}

// ---------- panels ----------

function renderStats(): void {
  if (!model) return;
  const t = model.replayer.totals();
  const authors = new Set<number>();
  const n = model.index + 1;
  const commits = model.history.commits;
  for (let i = 0; i < n; i++) authors.add(commits[i][1]);
  el.stats.innerHTML = `<b>${fmt(t.files)}</b> files · <b>${fmt(t.lines)}</b> lines · <b>${fmt(authors.size)}</b> authors`;
}


function renderCommit(): void {
  if (!model) return;
  const i = model.index;
  const { history } = model;
  if (i < 0) {
    el.commit.innerHTML = `<h2>Commit</h2><div class="muted">Empty lot. Press ▶ to build the city.</div>`;
    return;
  }
  const [ts, a, msg, hash, changes] = history.commits[i];
  let add = 0;
  let del = 0;
  for (const c of changes) {
    if (c[1] > 0) add += c[1];
    if (c[2] > 0) del += c[2];
  }
  const shown = changes.slice(0, 8);
  const items = shown
    .map((c) => {
      const tag = c[3] === -1 ? '<span class="del">deleted</span>' : c[3] !== undefined && c[3] >= 0 ? '<span class="muted">renamed</span>' : '';
      const counts = c[1] < 0 ? '<span class="muted">bin</span>' : `<span class="add">+${c[1]}</span><span class="del">−${c[2]}</span>`;
      return `<li data-file="${c[0]}" title="${esc(history.files[c[0]])}"><span class="path">${esc(history.files[c[0]])}</span>${tag}${counts}</li>`;
    })
    .join('');
  const more = changes.length > shown.length ? `<li class="muted">… ${changes.length - shown.length} more</li>` : '';
  el.commit.innerHTML = `
    <h2>Commit ${fmt(i + 1)} / ${fmt(history.commits.length)}</h2>
    <div class="commit-head">
      <span class="hash">${esc(hash)}</span>
      <span class="author">${dot(model.authorColors[a])}${esc(history.authors[a])}</span>
      <span class="date">${fmtDate(ts)}</span>
    </div>
    <div class="msg">${esc(msg)}</div>
    <div class="muted">${changes.length} file${changes.length === 1 ? '' : 's'} · <span class="add">+${fmt(add)}</span> <span class="del">−${fmt(del)}</span></div>
    <ul class="changes">${items}${more}</ul>`;
}

function renderLegend(): void {
  if (!model) return;
  const current = model.index >= 0 ? model.history.commits[model.index][1] : -1;
  const authors = model.authorLegend
    .slice(0, 14)
    .map((e) => `<li class="${e.key === current ? 'current' : ''}">${dot(e.color)}<span class="label" title="${esc(e.label)}">${esc(e.label)}</span><span class="count">${fmt(e.count)}</span></li>`)
    .join('');
  const extra = model.authorLegend.length > 14 ? `<li class="muted">+ ${model.authorLegend.length - 14} more</li>` : '';
  const types = model.extLegend
    .slice(0, 12)
    .map((e) => `<li>${dot(e.color)}<span class="label">${esc(e.label)}</span><span class="count">${fmt(e.count)}</span></li>`)
    .join('');
  const typeBlock = `<h2>File types</h2><ul>${types}</ul>`;
  const authorBlock = `<h2>Authors</h2><ul>${authors}${extra}</ul>`;
  el.legend.innerHTML = model.colorMode === 'ext' ? typeBlock + authorBlock : authorBlock + typeBlock;
}

function renderFile(): void {
  if (!model) return;
  const f = model.selected;
  if (f < 0) {
    el.file.classList.add('hidden');
    el.legend.classList.remove('hidden');
    return;
  }
  const { history, replayer } = model;
  const path = history.files[f];
  const ext = model.exts[f];
  const exists = replayer.exists[f] === 1;
  const hist = replayer.historyOf(f);
  const authors = [...replayer.authorsOf(f).entries()].sort((x, y) => y[1] - x[1]);
  const maxA = authors.length ? authors[0][1] : 1;
  const authorRows = authors
    .slice(0, 8)
    .map(
      ([a, n]) =>
        `<li>${dot(model!.authorColors[a])}<span class="label">${esc(history.authors[a])}<div class="bar" style="width:${(n / maxA) * 100}%;background:${model!.authorColors[a]};color:${model!.authorColors[a]}"></div></span><span class="count">${n}</span></li>`,
    )
    .join('');
  const recent = model.recentCommits(f)
    .map((ci) => {
      const [ts, a, msg, hash, changes] = history.commits[ci];
      const ch = changes.find((c) => c[0] === f || c[3] === f);
      const counts = ch ? (ch[1] < 0 ? '<span class="muted">bin</span>' : `<span class="add">+${ch[1]}</span><span class="del">−${ch[2]}</span>`) : '';
      return `<li data-commit="${ci}" title="${esc(msg)}">${dot(model!.authorColors[a])}<span class="hash">${esc(hash.slice(0, 7))}</span><span class="path" style="direction:ltr">${esc(msg)}</span>${counts}<span class="muted">${fmtDate(ts, false)}</span></li>`;
    })
    .join('');
  el.file.innerHTML = `
    <button class="close" title="Close (Esc)">✕</button>
    <h2>Building</h2>
    <div class="file-path">${esc(path)}</div>
    <dl class="kv">
      <dt>Status</dt><dd>${exists ? 'standing' : hist.length ? '<span class="del">demolished</span>' : '<span class="muted">not built yet</span>'}</dd>
      <dt>Lines</dt><dd>${replayer.binary[f] ? 'binary' : fmt(replayer.lines[f])} <span class="muted">(peak ${fmt(replayer.peakLines[f])})</span></dd>
      <dt>Type</dt><dd>${dot(model.extColors.get(ext) ?? '#888')} .${esc(ext)}</dd>
      <dt>Commits</dt><dd>${fmt(hist.length)}${hist.length ? ` <span class="muted">since ${fmtDate(history.commits[hist[0]][0], false)}</span>` : ''}</dd>
    </dl>
    <h2>Authors</h2>
    <ul class="changes" style="list-style:none">${authorRows || '<li class="muted">none yet</li>'}</ul>
    <h2 style="margin-top:12px">Recent commits</h2>
    <ul class="changes">${recent || '<li class="muted">none yet</li>'}</ul>
    <div class="actions">${city && view === '3d' ? '<button data-action="focus">Fly to building</button>' : ''}</div>`;
  el.file.classList.remove('hidden');
  el.legend.classList.add('hidden');
}

function renderTime(): void {
  if (!model) return;
  const i = model.index;
  const n = model.history.commits.length;
  el.scrubber.value = String(i);
  const date = i >= 0 ? fmtDate(model.history.commits[i][0], false) : '—';
  el.timeLabel.innerHTML = `<b>${date}</b><br>${fmt(i + 1)} / ${fmt(n)} commits`;
  el.play.textContent = playing ? '❚❚' : '▶';
}

function drawActivity(): void {
  if (!model) return;
  const c = el.activity;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth || 600;
  const h = c.clientHeight || 32;
  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const commits = model.history.commits;
  const buckets = Math.max(1, Math.min(Math.floor(w / 3), commits.length));
  const vals = new Float64Array(buckets);
  commits.forEach((cm, i) => {
    let churn = 0;
    for (const ch of cm[4]) churn += Math.max(0, ch[1]) + Math.max(0, ch[2]);
    vals[Math.min(buckets - 1, Math.floor((i / commits.length) * buckets))] += Math.log1p(churn);
  });
  const max = Math.max(1e-6, ...vals);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgba(185, 103, 255, 0.35)');
  grad.addColorStop(1, 'rgba(5, 217, 232, 0.95)');
  ctx.fillStyle = grad;
  const bw = w / buckets;
  for (let b = 0; b < buckets; b++) {
    const bh = (vals[b] / max) * (h - 2);
    ctx.fillRect(b * bw, h - bh, Math.max(1, bw - 1), bh);
  }
}

// ---------- controls ----------

let currentColorMode: ColorMode = 'ext';

function setView(v: '3d' | '2d'): void {
  if (!city) v = '2d';
  view = v;
  city?.setVisible(v === '3d');
  treemap.setVisible(v === '2d');
  $('view-3d').classList.toggle('active', v === '3d');
  $('view-2d').classList.toggle('active', v === '2d');
  shownSelection = -2;
}

function setColorMode(m: ColorMode): void {
  currentColorMode = m;
  $('color-ext').classList.toggle('active', m === 'ext');
  $('color-author').classList.toggle('active', m === 'author');
  if (model) {
    model.setColorMode(m);
    renderLegend();
  }
}

function seek(i: number): void {
  if (!model) return;
  model.seek(i);
  playhead = model.index;
}

function togglePlay(): void {
  if (!model) return;
  const last = model.history.commits.length - 1;
  if (!playing && model.index >= last) seek(-1);
  playing = !playing;
  playhead = model.index;
  renderTime();
}

for (const s of SPEEDS) el.speed.add(new Option(`${s}/s`, String(s)));
el.speed.addEventListener('change', () => {
  speed = Number(el.speed.value);
  if (model) model.glowDecay = glowDecayFor(speed);
});
el.heightMode.addEventListener('change', () => model?.setHeightMode(el.heightMode.value as HeightMode));
el.scrubber.addEventListener('input', () => {
  playing = false;
  seek(Number(el.scrubber.value));
});
el.play.addEventListener('click', togglePlay);
$('step-back').addEventListener('click', () => ((playing = false), seek((model?.index ?? 0) - 1)));
$('step-fwd').addEventListener('click', () => ((playing = false), seek((model?.index ?? 0) + 1)));
$('to-start').addEventListener('click', () => ((playing = false), seek(-1)));
$('to-end').addEventListener('click', () => ((playing = false), seek(Infinity)));
$('view-3d').addEventListener('click', () => setView('3d'));
$('view-2d').addEventListener('click', () => setView('2d'));
$('color-ext').addEventListener('click', () => setColorMode('ext'));
$('color-author').addEventListener('click', () => setColorMode('author'));
$('rotate').addEventListener('click', () => {
  if (!city) return;
  city.autoRotate = !city.autoRotate;
  $('rotate').classList.toggle('active', city.autoRotate);
});
$('reset-view').addEventListener('click', () => (view === '3d' ? city?.resetView() : treemap.resetView()));
$('load-file').addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files?.[0];
  if (file) void loadFile(file);
  el.fileInput.value = '';
});

el.commit.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-file]');
  if (li) select(Number(li.dataset.file));
});
el.file.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('.close')) return select(-1);
  if (t.closest('[data-action="focus"]') && model) return city?.focus(model.selected);
  const li = t.closest<HTMLElement>('li[data-commit]');
  if (li) {
    playing = false;
    seek(Number(li.dataset.commit));
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea') && e.key !== ' ') return;
  if (!model) return;
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      playing = false;
      seek(model.index - step);
      break;
    case 'ArrowRight':
      playing = false;
      seek(model.index + step);
      break;
    case 'Home':
      playing = false;
      seek(-1);
      break;
    case 'End':
      playing = false;
      seek(Infinity);
      break;
    case 't':
    case 'T':
      setView(view === '3d' ? '2d' : '3d');
      break;
    case 'c':
    case 'C':
      setColorMode(currentColorMode === 'ext' ? 'author' : 'ext');
      break;
    case 'r':
    case 'R':
      $('rotate').click();
      break;
    case 'Escape':
      select(-1);
      break;
  }
});

// Drag & drop JSON
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  el.drop.classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.drop.classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.classList.add('hidden');
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

async function loadFile(file: File): Promise<void> {
  try {
    el.loading.classList.remove('hidden', 'error');
    el.loading.innerHTML = `<div class="spinner"></div><div>Loading ${esc(file.name)}…</div>`;
    const data: unknown = JSON.parse(await file.text());
    const checked = checkHistory(data, file.name);
    select(-1);
    setHistory(checked);
    const url = new URL(location.href);
    url.searchParams.delete('data');
    history.replaceState(null, '', url);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

window.addEventListener('resize', () => {
  city?.resize();
  treemap.resize();
  drawActivity();
});

// ---------- main loop ----------

let last = performance.now();
let reportedFrameError = false;
function frame(now: number): void {
  // Schedule first so an exception while rendering cannot stop the loop.
  requestAnimationFrame(frame);
  try {
    step(now);
  } catch (err) {
    if (!reportedFrameError) console.error('[cityscape] frame failed', err);
    reportedFrameError = true;
  }
}

function step(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const time = now / 1000;
  if (model && playing) {
    const lastIdx = model.history.commits.length - 1;
    playhead = Math.min(lastIdx, playhead + dt * speed);
    model.seek(Math.floor(playhead));
    if (playhead >= lastIdx) playing = false;
  }
  if (model && (model.version !== shownVersion || model.selected !== shownSelection)) {
    const commitChanged = model.version !== shownVersion;
    shownVersion = model.version;
    shownSelection = model.selected;
    renderTime();
    if (commitChanged) {
      renderCommit();
      renderStats();
      renderLegend();
    }
    renderFile();
  }
  city?.update(dt, time);
  treemap.render(time);
}

if (!city) setView('2d');
requestAnimationFrame(frame);
void boot();
