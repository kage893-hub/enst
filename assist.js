// enst-lab 入力アシスト
// 入力内容を enst-lab のイベントダイヤ計算機（ユニット新曲イベント用）へ POST して結果ページを開く。
// 画像読み取りは「端末内OCR（Tesseract.js・無料）」が標準。Claude API は任意で使える高精度モード。

const ENST_ACTION = 'https://enst-lab.com/event_result.php';
// event.php 側の `event_new_next` が false のとき 'sp' が送られる（2026/10 時点）
const ENST_EVENT_FLG = 'sp';

const STORAGE_KEY = 'enst-assist-v1';
const PREFS_KEY = 'enst-assist-prefs';
const API_KEY_KEY = 'enst-assist-apikey';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

// enst-lab の初期値に合わせる
const DEFAULTS = {
  goal_point: '',
  evepoint_now: '',
  pass_now: '0',
  whistle: '0',
  megaphone: '0',
  whistle100: '0',
  bonus_nomal: '0',
  bonus_event: '0',
  nomal_score: '',
  event_score: '',
  bp_normal: '10',
  work_type: 'event',
  now_bp: '10',
  now_ticket: '8',
  lost_bp: '8',
  user_rank: '',
  sololiveflg: '0',
  office_LV: 'lv8',
};
const FIELDS = Object.keys(DEFAULTS);
const PROGRESS_FIELDS = ['evepoint_now', 'pass_now', 'whistle', 'megaphone'];

const RANGES = { now_bp: [0, 20], now_ticket: [0, 24], lost_bp: [0, 30], megaphone: [0, 3] };

const LABELS = {
  goal_point: '目標（万pt）',
  evepoint_now: '現在イベントpt',
  pass_now: '所持PASS',
  whistle: '所持ホイッスル',
  megaphone: '所持メガホン',
  now_bp: '現在BP',
  now_ticket: 'お仕事チケット',
  bonus_nomal: '通常曲 特効%',
  bonus_event: 'イベ曲 特効%',
  nomal_score: '通常曲スコア',
  event_score: 'イベ曲スコア',
  user_rank: 'RANK',
};

const OFFICE_LEVELS = [
  ['lv1', 'Lv.1〈最大3枚・60分〉', 3],
  ['lv2', 'Lv.2, Lv.3〈最大3枚・56分〉', 3],
  ['lv4', 'Lv.4〈最大3枚・53分〉', 3],
  ['lv5', 'Lv.5, Lv.6〈最大5枚・53分〉', 5],
  ['lv7', 'Lv.7〈最大5枚・50分〉', 5],
  ['lv8', 'Lv.8〈最大8枚・50分〉', 8],
  ['lv9', 'Lv.9〈最大8枚・45分〉', 8],
  ['lv10', 'Lv.10〈最大10枚・45分〉', 10],
  ['lv11', 'Lv.11〈最大10枚・43分〉', 10],
  ['lv12', 'Lv.12〈最大11枚・43分〉', 11],
  ['lv13', 'Lv.13〈最大11枚・40分〉', 11],
  ['lv14', 'Lv.14〈最大12枚・40分〉', 12],
  ['lv15', 'Lv.15〈最大12枚・35分〉', 12],
];

const $ = (id) => document.getElementById(id);
const haptic = () => navigator.vibrate?.(8);

// ---- イベント期間（enst-lab の判定ロジックと同じ） ----
// ユニット新曲イベントは 月末15:00〜8日21:59 / 15日15:00〜23日21:59
function isStartDay(d) {
  const day = d.getDate();
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return day === 15 || day === lastDay;
}

function isEventFirstDay(d = new Date()) {
  return isStartDay(d) && d.getHours() >= 15;
}

function isEventTerm(d = new Date()) {
  const day = d.getDate();
  if (isStartDay(d)) return d.getHours() >= 15;
  if (day === 8 || day === 23) return d.getHours() < 22;
  return (day >= 1 && day <= 7) || (day >= 16 && day <= 22);
}

// enst-lab と同じ単位で「どのイベントの入力か」を表すキー
function eventKey(d = new Date()) {
  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  let slot;
  if (d.getDate() <= 8) slot = 'first';
  else if (d.getDate() <= 23) slot = 'second';
  else { m += 1; slot = 'first'; }
  if (m > 12) { m = 1; y += 1; }
  return `${y}${String(m).padStart(2, '0')}-${slot}`;
}

// ---- 状態 ----
let mode = 'now'; // 'now' | 'start'
let images = [];  // { name, mediaType, data(base64), url, width, height }
let prefs = { tab: 'input', engine: 'local', model: 'claude-opus-5-5' };

function storage(fn) {
  try { return fn(); } catch (_) { return null; }
}

// 全角数字・カンマ・空白を取り除いて半角数字だけにする
function normalizeNumber(v) {
  return String(v ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, '');
}

function getValues() {
  const v = {};
  FIELDS.forEach((k) => { v[k] = $(k).value; });
  return v;
}

function setValue(key, value) {
  const el = $(key);
  el.value = value;
  if (el.type === 'hidden') syncChips(key);
}

function save() {
  const data = { values: getValues(), eventKey: eventKey(), mode };
  storage(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(data)));
}

function savePrefs() {
  storage(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)));
}

function load() {
  const saved = storage(() => JSON.parse(localStorage.getItem(STORAGE_KEY))) || {};
  const values = { ...DEFAULTS, ...(saved.values || {}) };

  // イベントが変わっていたら進捗系はリセット（目標や自分用設定は残す）
  if (saved.eventKey && saved.eventKey !== eventKey()) resetProgress(values);
  FIELDS.forEach((k) => setValue(k, values[k]));

  mode = isEventTerm() ? (saved.eventKey === eventKey() && saved.mode) || 'now' : 'start';

  prefs = { ...prefs, ...(storage(() => JSON.parse(localStorage.getItem(PREFS_KEY))) || {}) };
  $('apiKey').value = storage(() => localStorage.getItem(API_KEY_KEY)) || '';
  $('model').value = prefs.model;
  $('engine').value = prefs.engine;
}

function resetProgress(values) {
  PROGRESS_FIELDS.forEach((k) => { values[k] = DEFAULTS[k]; });
  values.now_bp = DEFAULTS.now_bp;
  values.now_ticket = String(ticketMax(values.office_LV));
  values.whistle100 = DEFAULTS.whistle100;
  return values;
}

function ticketMax(office) {
  return (OFFICE_LEVELS.find(([v]) => v === office) || [, , 8])[2];
}

// ---- UI 部品 ----
function buildChips() {
  document.querySelectorAll('.chips').forEach((box) => {
    const key = box.dataset.for;
    const values = box.dataset.values.split(',');
    const labels = box.dataset.labels ? box.dataset.labels.split(',') : values;
    values.forEach((val, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = labels[i];
      b.dataset.value = val;
      b.addEventListener('click', () => {
        haptic();
        setValue(key, val);
        onChange();
      });
      box.appendChild(b);
    });
  });
}

function syncChips(key) {
  const box = document.querySelector(`.chips[data-for="${key}"]`);
  if (!box) return;
  const val = $(key).value;
  box.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.value === val);
    b.setAttribute('aria-pressed', b.dataset.value === val);
  });
}

function buildOffice() {
  const sel = $('office_LV');
  OFFICE_LEVELS.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  });
}

function clamp(key, n) {
  const [min, max] = RANGES[key];
  return Math.min(max, Math.max(min, n));
}

function bindSteppers() {
  document.querySelectorAll('[data-step]').forEach((b) => {
    b.addEventListener('click', () => {
      haptic();
      const key = b.dataset.target;
      const cur = parseInt(normalizeNumber($(key).value), 10) || 0;
      setValue(key, String(clamp(key, cur + Number(b.dataset.step))));
      onChange();
    });
  });
}

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

function flash(key) {
  const field = $(key).closest('.field');
  if (!field) return;
  field.classList.remove('filled');
  void field.offsetWidth; // アニメーションを再生し直す
  field.classList.add('filled');
}

// ---- タブ ----
function setTab(tab) {
  prefs.tab = tab;
  savePrefs();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === tab));
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const showCta = tab === 'input';
  $('cta').classList.toggle('hide', !showCta);
  document.body.classList.toggle('has-cta', showCta);
  window.scrollTo({ top: 0 });
}

function applyMode() {
  const term = isEventTerm();
  const seg = document.querySelector('.segmented');
  seg.dataset.mode = mode;
  seg.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
    b.disabled = b.dataset.mode === 'now' && !term;
  });
  document.querySelectorAll('[data-show="now"]').forEach((el) => { el.hidden = mode !== 'now'; });

  // ログボホイッスルは「開始から」か、イベ初日のみ
  $('whistleCard').hidden = !(mode === 'start' || isEventFirstDay());

  $('bpLabel').textContent = mode === 'now' ? '現在残りBP' : 'イベ開始時BP';
  $('ticketLabel').textContent = mode === 'now' ? '残りお仕事チケット' : '開始時お仕事チケット';
  $('termText').textContent = term ? 'イベント開催中' : 'イベント期間外（開始からで計算）';
}

// ---- 入力チェック（enst-lab のフォーム制約に合わせる） ----
function validate(v) {
  const errors = [];
  const need = (key, ok, msg) => { if (!ok) errors.push([key, msg]); };
  const int = (s) => /^\d+$/.test(s);
  const pos = (s) => /^[1-9]\d*$/.test(s);

  need('goal_point', pos(v.goal_point) && v.goal_point.length <= 5, '目標ポイント（万pt）を入れてください');
  need('bonus_nomal', int(v.bonus_nomal) && v.bonus_nomal.length <= 3, '通常曲の特効（%）を入れてください');
  need('bonus_event', int(v.bonus_event) && v.bonus_event.length <= 3, 'イベ曲の特効（%）を入れてください');
  need('nomal_score', pos(v.nomal_score) && v.nomal_score.length <= 3, '通常曲スコア（万）を入れてください');
  need('event_score', pos(v.event_score) && v.event_score.length <= 3, 'イベ曲スコア（万）を入れてください');
  if (mode === 'now') {
    need('evepoint_now', int(v.evepoint_now) && v.evepoint_now.length <= 9, '現在のイベントptを入れてください');
    need('pass_now', int(v.pass_now) && v.pass_now.length <= 6, '所持PASSを入れてください（なければ0）');
    need('whistle', v.whistle === '' || (int(v.whistle) && v.whistle.length <= 3), '所持ホイッスルは数字で入れてください');
  }
  need('user_rank', v.user_rank === '' || (pos(v.user_rank) && v.user_rank.length <= 4), 'RANKは数字で入れてください');
  return errors;
}

// 進み具合リングに数える必須項目
function requiredKeys() {
  const keys = ['goal_point', 'bonus_nomal', 'bonus_event', 'nomal_score', 'event_score'];
  return mode === 'now' ? [...keys, 'evepoint_now', 'pass_now'] : keys;
}

function buildPayload(v) {
  const p = { ...v };
  p.calc_time = mode === 'now' || !isEventTerm() ? '0' : '1';
  if (mode === 'start') {
    p.evepoint_now = '';
    p.pass_now = '';
    p.whistle = '';
    p.megaphone = '0';
  } else {
    if (p.whistle === '') p.whistle = '0';
    if (!isEventFirstDay()) p.whistle100 = '0';
  }
  p.event_flg = ENST_EVENT_FLG;
  p.reset_flg = '';
  return p;
}

function onChange() {
  // 数字欄は全角やカンマを自動で直す
  FIELDS.forEach((k) => {
    const el = $(k);
    if (el.inputMode === 'numeric') {
      const n = normalizeNumber(el.value);
      if (n !== el.value) el.value = n;
    }
  });
  Object.keys(RANGES).forEach((k) => {
    if ($(k).value !== '') setValue(k, String(clamp(k, parseInt($(k).value, 10) || 0)));
  });
  applyMode();
  updateStatus();
  save();
}

function updateStatus() {
  const errors = validate(getValues());
  document.querySelectorAll('.field.error').forEach((el) => el.classList.remove('error'));

  const req = requiredKeys();
  const bad = new Set(errors.map(([k]) => k));
  const done = req.filter((k) => !bad.has(k)).length;
  $('ringText').textContent = `${done}/${req.length}`;
  $('ringMeter').style.strokeDashoffset = String(97.4 * (1 - done / req.length));
  $('ring').classList.toggle('done', done === req.length);
  $('ring').setAttribute('aria-label', `必須 ${req.length} 項目中 ${done} 項目入力済み`);
  $('badge').textContent = errors.length ? String(errors.length) : '';

  $('dockMsg').textContent = errors.length ? `あと ${errors.length} 項目 ・ ${errors[0][1]}` : '準備OK！';
  $('dockMsg').classList.toggle('ok', !errors.length);
}

function submit() {
  const v = getValues();
  const errors = validate(v);
  if (errors.length) {
    errors.forEach(([key]) => $(key).closest('.field')?.classList.add('error'));
    const first = $(errors[0][0]);
    const view = first.closest('.view');
    if (view && !view.classList.contains('active')) setTab(view.dataset.view);
    first.closest('.field').scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (first.type !== 'hidden') first.focus({ preventScroll: true });
    navigator.vibrate?.([20, 40, 20]);
    toast(errors[0][1]);
    return;
  }
  haptic();
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = ENST_ACTION;
  form.target = '_blank';
  Object.entries(buildPayload(v)).forEach(([name, value]) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

// 読み取った数値をフィールドに入れる（単位変換・範囲調整つき）
function assign(key, n) {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return false;
  let v = Math.floor(n);
  if (key === 'nomal_score' || key === 'event_score') v = v >= 10000 ? Math.floor(v / 10000) : v; // 万単位
  if (key === 'goal_point') v = v >= 100000 ? Math.floor(v / 10000) : v; // 万単位
  if (RANGES[key]) v = clamp(key, v);
  setValue(key, String(v));
  flash(key);
  return true;
}

// ---- 画像 ----
const MAX_EDGE = 1600;

async function toJpeg(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const url = canvas.toDataURL('image/jpeg', 0.9);
  return { name: file.name, mediaType: 'image/jpeg', data: url.split(',')[1], url, width: canvas.width, height: canvas.height };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  setStatus('画像を準備中…');
  for (const f of files) {
    try {
      images.push(await toJpeg(f));
    } catch (_) {
      toast(`${f.name} は読み込めませんでした`);
    }
  }
  renderThumbs();
  setStatus('');
  toast(`${images.length}枚の画像があります`);
}

function renderThumbs() {
  const box = $('thumbs');
  box.innerHTML = '';
  images.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const el = document.createElement('img');
    el.src = img.url;
    el.alt = img.name;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', '削除');
    del.addEventListener('click', () => {
      images.splice(i, 1);
      renderThumbs();
    });
    wrap.append(el, del);
    box.appendChild(wrap);
  });
  $('readBtn').disabled = !images.length;
  $('clearImgBtn').disabled = !images.length;
}

function setStatus(text, cls = '') {
  const el = $('ocrStatus');
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function readImages() {
  const btn = $('readBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  $('ocrResults').innerHTML = '';
  try {
    if (prefs.engine === 'claude') await readWithClaude();
    else await readLocally();
  } finally {
    btn.classList.remove('loading');
    btn.disabled = !images.length;
  }
}

// ==== 端末内OCR（Tesseract.js・無料） ====
let tesseractWorker = null;
let ocrProgress = () => {};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('読み取りエンジンを読み込めませんでした（通信を確認してください）'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  tesseractWorker ??= await window.Tesseract.createWorker('jpn+eng', 1, {
    logger: (m) => ocrProgress(m),
  });
  return tesseractWorker;
}

// 文字を読みやすくするため、グレースケール＋コントラスト強調した画像を作る
function preprocess(img) {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => {
      const scale = Math.max(1, 1400 / el.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(el.width * scale);
      canvas.height = Math.round(el.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
        const c = Math.max(0, Math.min(255, (g - 128) * 1.5 + 128));
        p[i] = p[i + 1] = p[i + 2] = c;
      }
      ctx.putImageData(d, 0, 0);
      resolve({ canvas, scale });
    };
    el.onerror = reject;
    el.src = img.url;
  });
}

const toHalf = (s) => s
  .replace(/[０-９％／，．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0')
  .replace(/(?<=\d)[lI|](?=\d)/g, '1');

// 1行の単語から「数字のかたまり」を取り出す（"1," "234," "567" のように分かれていても1つにまとめる）
function numbersInLine(line, scale) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const digits = cur.text.replace(/[,.]/g, '');
    const m = digits.match(/^(\d{1,9})(%?)$/);
    if (m) out.push({ value: Number(m[1]), pct: !!m[2], text: cur.text, bbox: cur.bbox });
    cur = null;
  };
  for (const w of line.words) {
    const t = toHalf(w.text.trim());
    const b = { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale };
    // "8/10" のような表示は左側だけ使う
    const frac = t.match(/^(\d{1,3})\/(\d{1,3})$/);
    if (frac) { flush(); out.push({ value: Number(frac[1]), pct: false, text: t, bbox: b }); continue; }
    if (/^[\d,.]+%?$/.test(t)) {
      const gap = cur ? b.x0 - cur.bbox.x1 : 0;
      if (cur && gap < (b.y1 - b.y0) * 0.8 && !cur.text.endsWith('%')) {
        cur.text += t;
        cur.bbox = { x0: cur.bbox.x0, y0: Math.min(cur.bbox.y0, b.y0), x1: b.x1, y1: Math.max(cur.bbox.y1, b.y1) };
      } else {
        flush();
        cur = { text: t, bbox: b };
      }
    } else {
      flush();
    }
  }
  flush();
  return out;
}

// 項目名が近くにある数字だけ自動で入れる（迷うものは入れず、タップで選んでもらう）
const AUTO_RULES = [
  { key: 'pass_now', re: /PASS|パス/i, now: true },
  { key: 'whistle', re: /ホイッスル/, now: true },
  { key: 'megaphone', re: /メガホン/, now: true },
  { key: 'evepoint_now', re: /イベント?(pt|ポイント)|累計/i, now: true, min: 100 },
  { key: 'user_rank', re: /RANK|ランク/i },
  { key: 'now_ticket', re: /チケット/ },
];

function autoAssign(lines) {
  const done = new Set();
  lines.forEach((line, i) => {
    const text = toHalf(line.text.replace(/\s/g, ''));
    for (const rule of AUTO_RULES) {
      if (done.has(rule.key) || (rule.now && mode !== 'now') || !rule.re.test(text)) continue;
      const pick = (nums) => nums.find((n) => !n.pct && n.value >= (rule.min || 0));
      const hit = pick(line.nums) || pick(lines[i + 1]?.nums || []);
      if (hit && assign(rule.key, hit.value)) {
        done.add(rule.key);
        hit.assigned = rule.key;
      }
    }
  });
  return [...done];
}

async function readLocally() {
  setStatus('読み取りエンジンを準備中…（初回は少し時間がかかります）', 'busy');
  let current = 0;
  ocrProgress = (m) => {
    if (m.status === 'recognizing text') {
      setStatus(`読み取り中… ${current + 1}/${images.length}枚目 ${Math.round(m.progress * 100)}%`, 'busy');
    }
  };
  try {
    const worker = await getWorker();
    const results = [];
    const autoFilled = new Set();
    for (current = 0; current < images.length; current++) {
      const img = images[current];
      const { canvas, scale } = await preprocess(img);
      const { data } = await worker.recognize(canvas);
      const lines = (data.lines || []).map((l) => ({ text: l.text, nums: numbersInLine(l, scale) }));
      autoAssign(lines).forEach((k) => autoFilled.add(k));
      results.push({ img, nums: lines.flatMap((l) => l.nums) });
    }
    renderOcrResults(results);
    onChange();
    const count = results.reduce((s, r) => s + r.nums.length, 0);
    const auto = [...autoFilled].map((k) => LABELS[k]).join('・');
    setStatus(count
      ? `${auto ? `自動で入れました：${auto}\n` : ''}画像の上の数字をタップすると、どの項目か選んで入力できます。`
      : '数字が見つかりませんでした。数字がはっきり写ったスクショで試すか、設定で「Claude API」を選んでください。',
    count ? 'ok' : 'warn');
  } catch (err) {
    console.error(err);
    setStatus(`読み取りに失敗しました：${err?.message || err}`, 'warn');
  }
}

// 画像の上に、読み取った数字をタップできるボタンとして重ねる
function renderOcrResults(results) {
  const box = $('ocrResults');
  box.innerHTML = '';
  results.forEach(({ img, nums }) => {
    if (!nums.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'ocr-image';
    const el = document.createElement('img');
    el.src = img.url;
    el.alt = img.name;
    wrap.appendChild(el);
    nums.forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ocr-num';
      b.style.left = `${(n.bbox.x0 / img.width) * 100}%`;
      b.style.top = `${(n.bbox.y0 / img.height) * 100}%`;
      b.style.width = `${((n.bbox.x1 - n.bbox.x0) / img.width) * 100}%`;
      b.style.height = `${((n.bbox.y1 - n.bbox.y0) / img.height) * 100}%`;
      b.setAttribute('aria-label', `${n.text} を入力する`);
      if (n.assigned) markAssigned(b, n.assigned);
      b.addEventListener('click', () => openSheet(n, b));
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
  });
}

function markAssigned(btn, key) {
  btn.classList.add('assigned');
  btn.dataset.label = LABELS[key];
}

// ---- 項目選択シート ----
let sheetTarget = null;

function openSheet(num, btn) {
  haptic();
  sheetTarget = { num, btn };
  $('sheetValue').textContent = num.text;
  const list = $('sheetList');
  list.innerHTML = '';
  Object.entries(LABELS).forEach(([key, label]) => {
    if (PROGRESS_FIELDS.includes(key) && mode !== 'now') return;
    if (num.pct && !key.startsWith('bonus')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-item';
    b.innerHTML = `<span></span><b></b>`;
    b.querySelector('span').textContent = label;
    b.querySelector('b').textContent = $(key).value || '—';
    b.addEventListener('click', () => {
      if (assign(key, num.value)) {
        markAssigned(btn, key);
        onChange();
        toast(`${label} に ${$(key).value} を入れました`);
      }
      closeSheet();
    });
    list.appendChild(b);
  });
  $('sheet').classList.add('open');
  $('sheet').setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  $('sheet').classList.remove('open');
  $('sheet').setAttribute('aria-hidden', 'true');
  sheetTarget = null;
}

// ==== Claude API（任意・高精度） ====
const NUM = (description) => ({ type: ['integer', 'null'], description });
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    evepoint_now: NUM('現在のイベントポイント（累計pt）'),
    pass_now: NUM('所持しているイベントPASSの枚数'),
    whistle: NUM('所持している応援ホイッスルの個数'),
    megaphone: NUM('所持しているメガホンの個数'),
    now_bp: NUM('現在のBP（ライブに使うポイント）。「8/10」のような表示なら左側の数'),
    now_ticket: NUM('現在のお仕事チケット枚数。「5/8」のような表示なら左側の数'),
    user_rank: NUM('プレイヤーRANK'),
    bonus_nomal: NUM('通常曲で使う編成のイベント特効ボーナス（%の数字だけ）'),
    bonus_event: NUM('イベント曲で使う編成のイベント特効ボーナス（%の数字だけ）'),
    nomal_score: NUM('通常曲のライブスコア（画面に出ている数値そのまま、例: 3123456）'),
    event_score: NUM('イベント曲のライブスコア（画面に出ている数値そのまま）'),
    notes: { type: 'string', description: '読み取れなかったもの・自信がないものの短いメモ（日本語）' },
  },
  required: [
    'evepoint_now', 'pass_now', 'whistle', 'megaphone', 'now_bp', 'now_ticket', 'user_rank',
    'bonus_nomal', 'bonus_event', 'nomal_score', 'event_score', 'notes',
  ],
  additionalProperties: false,
};

const EXTRACT_PROMPT = `これは「あんさんぶるスターズ!!Music」のゲーム画面のスクリーンショットです。
イベントダイヤ計算機に入力するための数値を読み取ってください。

- 画面にはっきり表示されている数値だけを入れ、見えないもの・推測になるものは null にしてください。
- 数値はカンマを除いた整数にしてください。
- 特効ボーナスやスコアが「通常曲」用か「イベント曲」用か画面から判別できない場合は、両方に同じ値を入れず、どちらか分かる方だけ入れて notes に書いてください。
- 複数の画像がある場合は、すべての画像の情報をまとめてください。`;

let sdkPromise = null;
function loadSdk() {
  sdkPromise ??= import(SDK_URL).then((m) => m.default);
  return sdkPromise;
}

async function readWithClaude() {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    setTab('settings');
    $('apiKey').focus();
    toast('Claude API を使うには APIキーが必要です');
    return;
  }
  const model = prefs.model;
  setStatus('Claude が読み取り中…（10〜30秒ほど）', 'busy');

  try {
    const Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content = [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      })),
      { type: 'text', text: EXTRACT_PROMPT },
    ];
    const params = {
      model,
      max_tokens: 16000,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
    };

    let response;
    if (model === 'claude-haiku-4-5') {
      response = await client.messages.create(params);
    } else {
      // 安全判定で断られた場合はサーバー側で別モデルに切り替えてもらう
      params.output_config.effort = 'medium';
      response = await client.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    }

    if (response.stop_reason === 'refusal') throw new Error('この画像は読み取りを断られました');
    if (response.stop_reason === 'max_tokens') throw new Error('応答が途中で切れました。画像を減らして試してください');
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('読み取り結果が空でした');
    applyExtracted(JSON.parse(text));
  } catch (err) {
    console.error(err);
    const status = err?.status;
    const msg = status === 401 ? 'APIキーが正しくないようです'
      : status === 429 ? '混み合っています。少し待ってからもう一度押してください'
      : err?.message || String(err);
    setStatus(`読み取りに失敗しました：${msg}`, 'warn');
  }
}

function applyExtracted(r) {
  const keys = ['now_bp', 'now_ticket', 'user_rank', 'bonus_nomal', 'bonus_event', 'nomal_score', 'event_score'];
  if (mode === 'now') keys.unshift(...PROGRESS_FIELDS);
  const filled = keys.filter((k) => assign(k, r[k])).map((k) => LABELS[k]);

  onChange();
  const note = r.notes ? `\nメモ：${r.notes}` : '';
  setStatus(filled.length
    ? `入力しました：${filled.join('・')}\n数字が合っているか「入力」タブで確認してください。${note}`
    : `入力できる数字が見つかりませんでした。${note}`, filled.length ? 'ok' : 'warn');
  if (filled.length) toast(`${filled.length}項目を入力しました`);
}

// ---- 起動 ----
function init() {
  buildChips();
  buildOffice();
  bindSteppers();
  load();
  applyMode();
  updateStatus();
  setTab(prefs.tab);

  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.addEventListener('click', () => { haptic(); setTab(b.dataset.tab); });
  });
  document.querySelectorAll('.segmented button').forEach((b) => {
    b.addEventListener('click', () => {
      haptic();
      mode = b.dataset.mode;
      onChange();
    });
  });

  // 入力・設定タブの項目はどちらもここで拾う
  const onFieldEvent = (e) => { if (FIELDS.includes(e.target.id)) onChange(); };
  document.addEventListener('input', onFieldEvent);
  document.addEventListener('change', onFieldEvent);
  $('form').addEventListener('submit', (e) => e.preventDefault()); // Enterキーでページが再読み込みされないように
  $('goBtn').addEventListener('click', submit);

  $('apiKey').addEventListener('change', () => storage(() => localStorage.setItem(API_KEY_KEY, $('apiKey').value.trim())));
  $('model').addEventListener('change', () => { prefs.model = $('model').value; savePrefs(); });
  $('engine').addEventListener('change', () => { prefs.engine = $('engine').value; savePrefs(); });

  $('resetBtn').addEventListener('click', () => {
    if (!confirm('現在pt・PASS・ホイッスル・メガホン・BP・チケットを初期値に戻しますか？')) return;
    const values = resetProgress(getValues());
    FIELDS.forEach((k) => setValue(k, values[k]));
    onChange();
    toast('進捗の入力をリセットしました');
  });

  $('files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      setTab('scan');
      addFiles(files);
    }
  });
  $('readBtn').addEventListener('click', readImages);
  $('clearImgBtn').addEventListener('click', () => {
    images = [];
    renderThumbs();
    $('ocrResults').innerHTML = '';
    setStatus('');
  });

  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  $('sheetClose').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
