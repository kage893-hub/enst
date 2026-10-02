// enst-lab 入力アシスト
// 入力内容を enst-lab のイベントダイヤ計算機（ユニット新曲・ツアー）へ送り、結果を受け取ってアプリ内に表示する。
// enst-lab は他サイトからの結果の読み取りを許可していないため、結果の受け取りには中継サーバー（Cloudflare Workers）を使う。
// 画像読み取りは端末内のOCR（Tesseract.js・無料）で行う。

// enst-lab の各ページの `event_new_next` / `event_sp_next` から送られる値（2026/10 時点）
const ENST_EVENT_FLG = 'sp';

const EVENT_TYPES = {
  unit: {
    name: 'ユニット新曲',
    page: 'https://enst-lab.com/event.php',
    action: 'https://enst-lab.com/event_result.php',
    whistle100: ['0', '100', '200'],
    fields: ['bonus_nomal', 'bonus_event', 'nomal_score', 'event_score', 'bp_normal'],
  },
  tour: {
    name: 'ツアー',
    page: 'https://enst-lab.com/event_sp.php',
    action: 'https://enst-lab.com/event_sp_result.php',
    whistle100: ['0', '50', '100'],
    fields: ['tokkou_1_3', 'tokkou_4', 'bonus_event', 'score1_3', 'score4', 'event_score', 'bp1_3', 'bp4', 'fever'],
  },
};

const STORAGE_KEY = 'enst-assist-v1';
const PREFS_KEY = 'enst-assist-prefs';
const RESULT_KEY = 'enst-assist-result';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

const QUICK_GOAL = '350';

// 標準で使う中継サーバー（設定で自分のURLに変えることもできる）
const DEFAULT_PROXY = 'https://enst-proxy.kage893.workers.dev';
const APP_URL = 'https://kage893-hub.github.io/enst/assist.html';

// enst-lab の初期値に合わせる
const DEFAULTS = {
  goal_point: '',
  evepoint_now: '',
  pass_now: '0',
  whistle: '0',
  megaphone: '0',
  whistle100: '0',
  // ユニット新曲
  bonus_nomal: '0',
  nomal_score: '',
  bp_normal: '10',
  // ツアー
  tokkou_1_3: '0',
  tokkou_4: '0',
  score1_3: '',
  score4: '',
  bp1_3: '10',
  bp4: '10',
  fever: '100',
  // 共通
  bonus_event: '0',
  event_score: '',
  work_type: 'event',
  now_bp: '10',
  now_ticket: '8',
  lost_bp: '8',
  user_rank: '',
  sololiveflg: '0',
  office_LV: 'lv8',
};
const FIELDS = Object.keys(DEFAULTS);
const COMMON_FIELDS = [
  'goal_point', 'evepoint_now', 'pass_now', 'whistle', 'megaphone', 'whistle100', 'work_type',
  'now_bp', 'now_ticket', 'lost_bp', 'user_rank', 'sololiveflg', 'office_LV',
];
const PROGRESS_FIELDS = ['evepoint_now', 'pass_now', 'whistle', 'megaphone'];
const SCORE_FIELDS = ['nomal_score', 'event_score', 'score1_3', 'score4'];

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
  nomal_score: '通常曲スコア',
  tokkou_1_3: '1〜3曲目 特効%',
  tokkou_4: '4曲目 特効%',
  score1_3: '1〜3曲目スコア',
  score4: '4曲目スコア',
  fever: 'FEVERボーナス%',
  bonus_event: 'イベ曲 特効%',
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

// ---- イベント期間（enst-lab の判定ロジックと同じ。ユニット新曲・ツアー共通） ----
// 月末15:00〜8日21:59 / 15日15:00〜23日21:59
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
let mode = 'now';        // 'now' | 'start'
let eventType = 'unit';  // 'unit' | 'tour'
let images = [];         // { name, mediaType, data(base64), url, width, height }
let prefs = { tab: 'input', proxy: '' };

const type = () => EVENT_TYPES[eventType];

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
  const data = { values: getValues(), eventKey: eventKey(), mode, eventType };
  storage(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(data)));
}

function savePrefs() {
  storage(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)));
}

function load() {
  const saved = storage(() => JSON.parse(localStorage.getItem(STORAGE_KEY))) || {};
  const values = { ...DEFAULTS, ...(saved.values || {}) };

  // イベントが変わっていたら進捗系はリセット（目標や編成・自分用設定は残す）
  if (saved.eventKey && saved.eventKey !== eventKey()) resetProgress(values);

  eventType = EVENT_TYPES[saved.eventType] ? saved.eventType : 'unit';
  buildWhistleChips();
  FIELDS.forEach((k) => setValue(k, values[k]));

  mode = isEventTerm() ? (saved.eventKey === eventKey() && saved.mode) || 'now' : 'start';

  prefs = { ...prefs, ...(storage(() => JSON.parse(localStorage.getItem(PREFS_KEY))) || {}) };
  $('proxyUrl').value = prefs.proxy || '';
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

// ブラウザの保存領域を「消さないで」と頼む（対応ブラウザのみ）
async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  const already = await navigator.storage.persisted().catch(() => false);
  const ok = already || await navigator.storage.persist().catch(() => false);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!ok && !standalone) {
    $('storageNote').textContent = '入力した内容はこの端末に保存され、ブラウザを閉じても残ります。'
      + 'iPhone では長期間開かないと消えることがあるので、ホーム画面に追加して使うのがおすすめです。';
  }
}

// ---- UI 部品 ----
function makeChips(box) {
  const key = box.dataset.for;
  const values = box.dataset.values.split(',');
  const labels = box.dataset.labels ? box.dataset.labels.split(',') : values;
  box.innerHTML = '';
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
}

function buildChips() {
  document.querySelectorAll('.chips[data-values]').forEach(makeChips);
}

// ログボホイッスルの選択肢はイベントの種類で違う（新曲 100/200、ツアー 50/100）
function buildWhistleChips() {
  const box = $('whistle100Chips');
  const values = type().whistle100;
  box.dataset.values = values.join(',');
  box.dataset.labels = values.map((v) => (v === '0' ? '配布なし' : `${v}個`)).join(',');
  makeChips(box);
  if (!values.includes($('whistle100').value)) $('whistle100').value = '0';
  syncChips('whistle100');
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
  if (tab === 'result') $('resultDot').classList.remove('on');
  window.scrollTo({ top: 0 });
}

function syncSegmented(group, value, disabled = () => false) {
  const seg = document.querySelector(`.segmented[data-group="${group}"]`);
  seg.dataset.value = value;
  seg.querySelectorAll('button').forEach((b, i) => {
    const on = b.dataset.value === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
    b.disabled = disabled(b.dataset.value);
    if (on) seg.style.setProperty('--seg-index', i);
  });
}

function applyMode() {
  const term = isEventTerm();
  document.body.dataset.type = eventType;
  syncSegmented('type', eventType);
  syncSegmented('mode', mode, (v) => v === 'now' && !term);
  document.querySelectorAll('[data-show="now"]').forEach((el) => { el.hidden = mode !== 'now'; });

  // ログボホイッスルは「開始から」か、イベ初日のみ
  $('whistleCard').hidden = !(mode === 'start' || isEventFirstDay());

  $('bpLabel').textContent = mode === 'now' ? '現在残りBP' : 'イベ開始時BP';
  $('ticketLabel').textContent = mode === 'now' ? '残りお仕事チケット' : '開始時お仕事チケット';
  $('termText').textContent = `${type().name}イベント ・ ${term ? '開催中' : '期間外（開始からで計算）'}`;
  $('enstLink').href = type().page;
  $('quick350').classList.toggle('on', $('goal_point').value === QUICK_GOAL);
}

// ---- 入力チェック（enst-lab のフォーム制約に合わせる） ----
function validate(v) {
  const errors = [];
  const need = (key, ok, msg) => { if (!ok) errors.push([key, msg]); };
  const int = (s, len) => /^\d+$/.test(s) && s.length <= len;
  const pos = (s, len) => /^[1-9]\d*$/.test(s) && s.length <= len;

  need('goal_point', pos(v.goal_point, 5), '目標ポイント（万pt）を入れてください');
  if (eventType === 'unit') {
    need('bonus_nomal', int(v.bonus_nomal, 3), '通常曲の特効（%）を入れてください');
    need('bonus_event', int(v.bonus_event, 3), 'イベ曲の特効（%）を入れてください');
    need('nomal_score', pos(v.nomal_score, 3), '通常曲スコア（万）を入れてください');
    need('event_score', pos(v.event_score, 3), 'イベ曲スコア（万）を入れてください');
  } else {
    need('tokkou_1_3', int(v.tokkou_1_3, 3), '1〜3曲目の特効（%）を入れてください');
    need('tokkou_4', int(v.tokkou_4, 3), '4曲目の特効（%）を入れてください');
    need('bonus_event', int(v.bonus_event, 3), 'イベ曲の特効（%）を入れてください');
    need('score1_3', pos(v.score1_3, 3), '1〜3曲目のスコア（万）を入れてください');
    need('score4', pos(v.score4, 3), '4曲目のスコア（万）を入れてください');
    need('event_score', pos(v.event_score, 3), 'イベ曲スコア（万）を入れてください');
    need('fever', pos(v.fever, 3), 'FEVERボーナス（%）を入れてください');
  }
  if (mode === 'now') {
    need('evepoint_now', int(v.evepoint_now, 9), '現在のイベントptを入れてください');
    need('pass_now', int(v.pass_now, 6), '所持PASSを入れてください（なければ0）');
    need('whistle', v.whistle === '' || int(v.whistle, 3), '所持ホイッスルは数字で入れてください');
  }
  need('user_rank', v.user_rank === '' || pos(v.user_rank, 4), 'RANKは数字で入れてください');
  return errors;
}

// 進み具合リングに数える必須項目
function requiredKeys() {
  const keys = ['goal_point', ...type().fields.filter((k) => !/^bp/.test(k))];
  return mode === 'now' ? [...keys, 'evepoint_now', 'pass_now'] : keys;
}

// enst-lab に送る内容（そのイベントの種類で使う項目だけ）
function buildPayload(v) {
  const p = {};
  [...COMMON_FIELDS, ...type().fields].forEach((k) => { p[k] = v[k]; });
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

  $('dockMsg').textContent = errors.length
    ? `あと ${errors.length} 項目 ・ ${errors[0][1]}`
    : `準備OK！ ${type().name}イベントで計算します`;
  $('dockMsg').classList.toggle('ok', !errors.length);
}

// ---- 計算 ----
function openInEnstLab(payload, eventTypeKey = eventType) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = EVENT_TYPES[eventTypeKey].action;
  form.target = '_blank';
  Object.entries(payload).forEach(([name, value]) => {
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

function showErrors(errors) {
  errors.forEach(([key]) => $(key).closest('.field')?.classList.add('error'));
  const first = $(errors[0][0]);
  const view = first.closest('.view');
  if (view && !view.classList.contains('active')) setTab(view.dataset.view);
  first.closest('.field').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (first.type !== 'hidden') first.focus({ preventScroll: true });
  navigator.vibrate?.([20, 40, 20]);
  toast(errors[0][1]);
}

async function calculate() {
  const v = getValues();
  const errors = validate(v);
  if (errors.length) {
    showErrors(errors);
    return;
  }
  haptic();
  const payload = buildPayload(v);
  const proxy = (prefs.proxy || DEFAULT_PROXY).trim();
  if (!proxy) {
    openInEnstLab(payload);
    toast('結果をアプリ内に出すには、設定で中継サーバーを登録してください', 4000);
    return;
  }

  const btn = $('goBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const url = new URL(proxy);
    url.searchParams.set('type', eventType);
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams(payload) });
    if (!res.ok) throw new Error(`中継サーバーがエラーを返しました（${res.status}）`);
    const parsed = parseResult(await res.text());
    const result = {
      ...parsed,
      eventType,
      mode,
      goal: v.goal_point,
      at: Date.now(),
      payload,
    };
    storage(() => localStorage.setItem(RESULT_KEY, JSON.stringify(result)));
    renderResult(result);
    setTab('result');
    navigator.vibrate?.([10, 30, 10]);
  } catch (err) {
    console.error(err);
    const msg = err instanceof TypeError
      ? '中継サーバーにつながりませんでした。設定のURLと通信を確認してください'
      : err?.message || String(err);
    renderResultError(msg, payload);
    setTab('result');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// enst-lab の結果ページ（HTML）から数値を取り出す
function cellLines(el) {
  const c = el.cloneNode(true);
  // スマホ用の改行（mobile-br）は単語の途中なので詰める
  c.querySelectorAll('br').forEach((br) => br.replaceWith(br.classList.contains('mobile-br') ? '' : '\n'));
  return c.textContent.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function parseResult(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = (sel) => [...doc.querySelectorAll(`${sel} tr`)].map((tr) => {
    const th = tr.querySelector('th');
    const td = tr.querySelector('td');
    if (!th || !td) return null;
    const [label, ...sub] = cellLines(th);
    const [value, ...note] = cellLines(td);
    // 値が入っていない行（"pt" だけ等）は除く
    if (!label || !value || !/\d/.test(value)) return null;
    return { label, sub: sub.join(' '), value, note: note.join(' ') };
  }).filter(Boolean);

  const summary = rows('tbody.member2');
  const detail = rows('tbody.member3');
  if (!summary.length) {
    const text = doc.body?.textContent || '';
    if (text.includes('再計算')) {
      throw new Error('enst-lab で計算できませんでした。「今のイベント」は開催中のイベントの種類でしか計算できません。'
        + 'イベントの種類が合っているか確認するか、「開始から」で計算してください。');
    }
    throw new Error('結果を読み取れませんでした。enst-lab のページの形が変わった可能性があります。');
  }
  const head = doc.querySelector('.text-center.mb-3 .f-15');
  const current = doc.getElementById('score_result');
  return {
    when: head ? cellLines(head).join(' ') : '',
    current: current ? cellLines(current).join(' ') : '',
    summary,
    detail,
  };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function formatAt(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderResult(r) {
  const body = $('resultBody');
  body.innerHTML = '';
  $('resultEmpty').hidden = true;
  body.hidden = false;

  const find = (re) => r.summary.find((row) => re.test(row.label));
  const dia = find(/必要ダイヤ/);
  const remain = find(/目標ptまであと/);
  const progress = Number((remain?.note.match(/([\d.]+)\s*%/) || [])[1]);

  const meta = el('p', 'result-meta', `${EVENT_TYPES[r.eventType]?.name || ''}イベント ・ 目標 ${Number(r.goal).toLocaleString('ja-JP')}万pt ・ ${formatAt(r.at)} 計算`);
  body.appendChild(meta);

  // メイン：必要ダイヤ
  const hero = el('div', 'result-hero');
  hero.appendChild(el('p', 'eyebrow', '必要ダイヤ'));
  const big = el('p', 'result-big');
  const n = (dia?.value || '').match(/[\d,]+/);
  big.append(el('span', '', n ? n[0] : (dia?.value || '—')), el('small', '', '個'));
  hero.appendChild(big);
  if (remain) {
    hero.appendChild(el('p', 'result-sub', `目標まであと ${remain.value}`));
    if (Number.isFinite(progress)) {
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.min(100, progress)}%`;
      bar.appendChild(fill);
      hero.append(bar, el('p', 'result-sub small', `進捗 ${progress}%`));
    }
  }
  body.appendChild(hero);

  // 現在pt
  if (r.current) {
    const now = el('div', 'result-now');
    now.append(el('span', 'eyebrow', r.when ? `現在到達ポイント（${r.when}）` : '現在到達ポイント'), el('b', '', r.current));
    body.appendChild(now);
  }

  // そのほかの主要な数値
  const tiles = el('div', 'tiles');
  r.summary.filter((row) => row !== dia && row !== remain).forEach((row) => {
    const t = el('div', 'tile');
    t.append(el('span', 'tile-label', row.label), el('b', 'tile-value', row.value));
    const sub = [row.sub, row.note].filter(Boolean).join(' ');
    if (sub) t.appendChild(el('span', 'tile-sub', sub));
    tiles.appendChild(t);
  });
  body.appendChild(tiles);

  // 詳細
  if (r.detail.length) {
    const det = el('details', 'list result-detail');
    const sum = el('summary', 'item');
    sum.append(el('span', '', '詳細情報'), el('span', 'chev', '›'));
    det.appendChild(sum);
    r.detail.forEach((row) => {
      const item = el('div', 'item');
      const left = el('span', 'detail-label', row.label);
      if (row.sub) left.appendChild(el('small', '', row.sub));
      item.append(left, el('b', 'detail-value', [row.value, row.note].filter(Boolean).join(' ')));
      det.appendChild(item);
    });
    body.appendChild(det);
  }

  const actions = el('div', 'result-actions');
  const open = el('button', 'btn ghost', 'enst-lab の結果ページで見る ↗');
  open.type = 'button';
  open.addEventListener('click', () => openInEnstLab(r.payload, r.eventType));
  const back = el('button', 'btn ghost', '入力を直して再計算');
  back.type = 'button';
  back.addEventListener('click', () => setTab('input'));
  actions.append(back, open);
  body.appendChild(actions);

  $('resultDot').classList.add('on');
}

function renderResultError(message, payload) {
  const body = $('resultBody');
  body.innerHTML = '';
  $('resultEmpty').hidden = true;
  body.hidden = false;
  const box = el('div', 'result-error');
  box.append(el('p', 'eyebrow', '計算できませんでした'), el('p', '', message));
  const open = el('button', 'btn grad', 'enst-lab の結果ページで見る ↗');
  open.type = 'button';
  open.addEventListener('click', () => openInEnstLab(payload));
  const back = el('button', 'btn ghost', '入力に戻る');
  back.type = 'button';
  back.addEventListener('click', () => setTab('input'));
  box.append(open, back);
  body.appendChild(box);
}

function loadLastResult() {
  const r = storage(() => JSON.parse(localStorage.getItem(RESULT_KEY)));
  if (r?.summary?.length) renderResult(r);
  $('resultDot').classList.remove('on');
}

// 読み取った数値をフィールドに入れる（単位変換・範囲調整つき）
function assign(key, n) {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return false;
  let v = Math.floor(n);
  if (SCORE_FIELDS.includes(key)) v = v >= 10000 ? Math.floor(v / 10000) : v; // 万単位
  if (key === 'goal_point') v = v >= 100000 ? Math.floor(v / 10000) : v; // 万単位
  if (RANGES[key]) v = clamp(key, v);
  setValue(key, String(v));
  flash(key);
  return true;
}

// 今のイベントの種類で読み取り対象になる項目
function scanKeys() {
  const keys = ['now_bp', 'now_ticket', 'user_rank', ...type().fields.filter((k) => !/^bp/.test(k))];
  return mode === 'now' ? [...PROGRESS_FIELDS, ...keys] : keys;
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
  return {
    name: file.name, mediaType: 'image/jpeg', data: url.split(',')[1], url, width: canvas.width, height: canvas.height,
    original: URL.createObjectURL(file), // 決まった位置の数字は、縮小前の元画像から読む
  };
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
    const im = document.createElement('img');
    im.src = img.url;
    im.alt = img.name;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', '削除');
    del.addEventListener('click', () => {
      images.splice(i, 1);
      renderThumbs();
    });
    wrap.append(im, del);
    box.appendChild(wrap);
  });
  $('readBtn').disabled = !images.length;
  $('clearImgBtn').disabled = !images.length;
}

function setStatus(text, cls = '') {
  const s = $('ocrStatus');
  s.textContent = text;
  s.className = `status ${cls}`;
}

async function readImages() {
  const btn = $('readBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  $('ocrResults').innerHTML = '';
  try {
    await readLocally();
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

// ---- 画面の決まった位置から数字を読む（イベント画面・アイテム画面） ----
// 基準にしたスクショ（2000×900・左右にノッチよけの余白 114 がある端末）上の位置。
// ゲームの画面は 16:9 の枠が収まる大きさに拡大縮小され、各パーツは画面の端や中央を基準に置かれる
//   ax: 'left' / 'right' / 'center'（横の基準）  ay: 'top' / 'bottom' / 'middle'（縦の基準）
// 左右の余白（ノッチよけ）は端末ごとに違うので、何通りか試して正しく読めたものを採用する。
//   ink: 'dark' = 明るい地に濃い文字 / 'light' = 色付きの地に白い文字 / 'outline' = 縁取りだけの白抜き文字
//   kind: 'number' = 数字 / 'fraction' = 「4/10」の左側 / 'text' = 日本語の文字
const SCREEN_LAYOUTS = [
  {
    name: 'イベント画面',
    base: { w: 2000, h: 900 },
    regions: [
      // 右下「累計イベントpt」の数字（白地に黒文字）
      { id: 'evepoint_now', ax: 'right', ay: 'bottom', x0: 1595, x1: 1850, y0: 568, y1: 622, ink: 'dark', kind: 'number', suffix: 'pt' },
      // 左下「イベント楽曲ライブ」ボタンのPASS枚数（オレンジ地に白文字）
      { id: 'pass_now', ax: 'left', ay: 'bottom', x0: 300, x1: 460, y0: 788, y1: 842, ink: 'light', kind: 'number' },
    ],
    // 「累計イベントpt」が読めたらこの画面とみなす
    resolve: (v) => (v.evepoint_now ? [v.evepoint_now, v.pass_now].filter(Boolean) : null),
  },
  {
    name: 'アイテム倉庫',
    base: { w: 2000, h: 900 },
    regions: [
      // 上のバー「BP 4/10」「WORK 7/12」（紺地に白文字）
      { id: 'now_bp', ax: 'right', ay: 'top', x0: 1150, x1: 1265, y0: 44, y1: 86, ink: 'light', kind: 'fraction' },
      { id: 'now_ticket', ax: 'right', ay: 'top', x0: 1470, x1: 1575, y0: 44, y1: 86, ink: 'light', kind: 'fraction' },
      // 「消費アイテム」一覧の先頭3マス：アイコンの色でメガホン／ホイッスルを見分け、下の「×32」を読む
      ...[[318, 448], [465, 595], [612, 742]].flatMap(([x0, x1], i) => [
        { id: `cell${i}_icon`, ax: 'center', ay: 'middle', x0: x0 + 5, x1: x1 - 5, y0: 268, y1: 345, kind: 'icon' },
        { id: `cell${i}_count`, ax: 'center', ay: 'middle', x0, x1, y0: 343, y1: 392, ink: 'outline', kind: 'number' },
      ]),
    ],
    resolve: (v) => {
      const out = [v.now_bp, v.now_ticket].filter(Boolean);
      if (!out.length) return null;
      // メガホンは持っているときだけ一覧の先頭に出る。ホイッスルが見つかってメガホンが無ければ0個
      for (const key of ['megaphone', 'whistle']) {
        const i = [0, 1, 2].find((n) => v[`cell${n}_icon`]?.value === key && v[`cell${n}_count`]);
        if (i !== undefined) out.push({ ...v[`cell${i}_count`], key });
      }
      if (out.some((n) => n.key === 'whistle') && !out.some((n) => n.key === 'megaphone')) {
        out.push({ key: 'megaphone', value: 0, text: '0', bbox: null });
      }
      return out;
    },
  },
];

let digitWorker = null;

async function getDigitWorker() {
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  if (!digitWorker) {
    digitWorker = await window.Tesseract.createWorker('eng', 1);
    // 数字・カンマ・スラッシュ・"pt"・"x"（アイテム数の「×」）だけを、1行の文字として読む
    await digitWorker.setParameters({ tessedit_char_whitelist: '0123456789,/ptx', tessedit_pageseg_mode: '7' });
  }
  return digitWorker;
}

const BASE_INSET = 114; // 基準のスクショの左右の余白（ノッチよけ）

// 画面の拡大率：16:9 の枠が画面に収まる大きさ
function layoutScale(layout, W, H) {
  return Math.min(W * 9 / 16, H) / layout.base.h;
}

// 試す左右の余白（基準の単位）。横長の端末ほどノッチよけの余白があることが多い
function insetCandidates(W, H) {
  return W / H > 1.9 ? [BASE_INSET, 0, 70, 150, 40] : [0, BASE_INSET, 70, 40, 150];
}

function regionRect(layout, r, W, H, inset) {
  const s = layoutScale(layout, W, H);
  const { w: BW, h: BH } = layout.base;
  const x = (v) => (r.ax === 'right' ? W - inset * s - (BW - BASE_INSET - v) * s
    : r.ax === 'center' ? W / 2 + (v - BW / 2) * s
    : inset * s + (v - BASE_INSET) * s);
  const y = (v) => (r.ay === 'bottom' ? H - (BH - v) * s
    : r.ay === 'middle' ? H / 2 + (v - BH / 2) * s
    : v * s);
  return { x: x(r.x0), y: y(r.y0), w: x(r.x1) - x(r.x0), h: y(r.y1) - y(r.y0) };
}

// 縁取りだけの白抜き文字から、縁に囲まれた白い部分（＝本来の文字の形）だけを取り出す。
// 外側の白を深さ0とし、縁をまたぐごとに深さを1つ増やして、奇数の深さの白を文字とみなす（「0」の穴などは偶数なので残る）。
// 縁や影は捨てるので、影で「5」が「8」に見えるような読み間違いが起きにくい。
function extractOutlinedFill(p, W, H, rad) {
  const N = W * H;
  const ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = p[i * 4] === 0 ? 1 : 0;
  // 縁の線のかすれ・すき間をふさぐため、少しだけ太らせる
  const tmp = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = Math.max(0, x - rad); k <= Math.min(W - 1, x + rad) && !v; k++) v = ink[y * W + k];
      tmp[y * W + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let k = Math.max(0, y - rad); k <= Math.min(H - 1, y + rad) && !v; k++) v = tmp[k * W + x];
      ink[y * W + x] = v;
    }
  }
  // つながっている部分ごとに番号を振る（白は上下左右、縁は斜めもつながりとみなす）
  const comp = new Int32Array(N).fill(-1);
  const isInk = [];
  const stack = [];
  let n = 0;
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0) continue;
    const t = ink[i];
    comp[i] = n;
    isInk.push(t);
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % W;
      const y = (j / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!t && dx && dy)) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const k = yy * W + xx;
          if (comp[k] < 0 && ink[k] === t) { comp[k] = n; stack.push(k); }
        }
      }
    }
    n++;
  }
  const adj = Array.from({ length: n }, () => new Set());
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = comp[y * W + x];
      if (x + 1 < W) { const b = comp[y * W + x + 1]; if (a !== b) { adj[a].add(b); adj[b].add(a); } }
      if (y + 1 < H) { const b = comp[(y + 1) * W + x]; if (a !== b) { adj[a].add(b); adj[b].add(a); } }
    }
  }
  const depth = new Int32Array(n).fill(-1);
  const queue = [];
  const seed = (i) => { const c = comp[i]; if (!isInk[c] && depth[c] < 0) { depth[c] = 0; queue.push(c); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (const e of adj[c]) {
      if (!isInk[e]) continue;
      for (const w of adj[e]) {
        if (!isInk[w] && depth[w] < 0) { depth[w] = depth[c] + 1; queue.push(w); }
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    const glyph = !isInk[c] && depth[c] % 2 === 1;
    p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = glyph ? 0 : 255;
  }
}

// 切り出して拡大し、文字だけ黒・それ以外を白にする（level が上がるほど判定をゆるくする）
function binarizeRegion(im, rect, ink, level) {
  const k = Math.max(1, 160 / rect.h);
  const c = document.createElement('canvas');
  c.width = Math.round(rect.w * k);
  c.height = Math.round(rect.h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(im, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  const [minLight, maxSat, maxDark, maxOutline] = [[200, 40, 110, 150], [175, 70, 130, 175], [150, 100, 150, 200]][level];
  for (let i = 0; i < p.length; i += 4) {
    const mx = Math.max(p[i], p[i + 1], p[i + 2]);
    const mn = Math.min(p[i], p[i + 1], p[i + 2]);
    const isInk = ink === 'light' ? mn > minLight && mx - mn < maxSat
      : ink === 'outline' ? mx < maxOutline
      : mx < maxDark;
    p[i] = p[i + 1] = p[i + 2] = isInk ? 0 : 255;
  }
  if (ink === 'outline') extractOutlinedFill(p, c.width, c.height, Math.max(1, Math.round(k * 0.5)));
  ctx.putImageData(d, 0, 0);
  // 周りに白い余白をつける（文字が端に接していると読みにくい）
  const out = document.createElement('canvas');
  out.width = c.width + 40;
  out.height = c.height + 40;
  const o = out.getContext('2d');
  o.fillStyle = '#fff';
  o.fillRect(0, 0, out.width, out.height);
  o.drawImage(c, 20, 20);
  return out;
}

function parseRegionText(r, text) {
  if (r.kind === 'fraction') {
    const m = text.match(/^(\d{1,3})\/(\d{1,2})$/);
    return m && Number(m[2]) > 0 ? Number(m[1]) : null;
  }
  const m = text.replace(/^x+/, '').match(/^(\d{1,3}(?:,?\d{3})*)(pt)?$/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

async function readRegion(im, rect, r) {
  if (r.kind === 'icon') return { value: classifyIcon(im, rect), text: '', conf: 100 };
  const worker = await getDigitWorker();
  let best = null;
  for (let level = 0; level < 3; level++) {
    const { data } = await worker.recognize(binarizeRegion(im, rect, r.ink, level));
    const text = data.text.replace(/\s/g, '');
    const cand = { value: parseRegionText(r, text), text, conf: data.confidence };
    if (r.suffix && !text.endsWith(r.suffix)) cand.value = null; // 単位（pt）が無い＝別の画面
    if (cand.value !== null && (!best || cand.conf > best.conf)) best = cand;
    if (cand.value !== null && cand.conf >= 80) break;
  }
  return best;
}

// アイテムのアイコンを色で見分ける：メガホンはオレンジの筒、ホイッスルは赤いホイッスル
function classifyIcon(im, rect) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w));
  c.height = Math.max(1, Math.round(rect.h));
  const g = c.getContext('2d');
  g.drawImage(im, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let orange = 0;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const gr = d[i + 1];
    const b = d[i + 2];
    const mx = Math.max(r, gr, b);
    const mn = Math.min(r, gr, b);
    if (mx < 120 || mx - mn < 80) continue; // 暗い色・くすんだ色は数えない
    let h = mx === r ? ((gr - b) / (mx - mn) + 6) % 6 : mx === gr ? (b - r) / (mx - mn) + 2 : (r - gr) / (mx - mn) + 4;
    h *= 60;
    if (h >= 15 && h <= 40) orange++;
    if (h >= 330 || h < 10) red++;
  }
  const n = d.length / 4;
  if (orange / n >= 0.1) return 'megaphone';
  if (red / n >= 0.1) return 'whistle';
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

// 決まった画面だと分かれば、その位置の数字を返す（分からなければ null）
async function readByLayout(img) {
  const im = await loadImage(img.original || img.url);
  const W = im.naturalWidth;
  const H = im.naturalHeight;
  if (W < H * 1.2) return null; // ゲーム画面は横長
  const f = img.width / W; // 表示用の縮小画像の座標に直す
  const ok = (r, hit) => hit && hit.value !== null && hit.value !== undefined && (r.kind === 'icon' || hit.conf >= 40);
  // 端の余白の候補ごとに読み、欠けずに読めたもの（文字が長く、自信度が高いもの）を選ぶ
  const readBest = async (layout, r) => {
    let best = null;
    for (const inset of r.ax === 'center' ? [0] : insetCandidates(W, H)) {
      const rect = regionRect(layout, r, W, H, inset);
      const hit = await readRegion(im, rect, r);
      if (!ok(r, hit)) continue;
      const score = (hit.text || '').replace(/[^0-9/]/g, '').length * 1000 + hit.conf;
      if (!best || score > best.score) best = { hit, rect, score };
    }
    return best;
  };
  for (const layout of SCREEN_LAYOUTS) {
    // 最初の項目が読めなければ、この画面ではない
    const firstBest = await readBest(layout, layout.regions[0]);
    if (!firstBest) continue;
    const found = {};
    for (const r of layout.regions) {
      const best = r === layout.regions[0] ? firstBest : await readBest(layout, r);
      if (!best) continue;
      const { hit, rect } = best;
      found[r.id] = {
        key: r.id,
        value: hit.value,
        text: hit.text.replace(/pt$/, ''),
        pct: false,
        bbox: { x0: rect.x * f, y0: rect.y * f, x1: (rect.x + rect.w) * f, y1: (rect.y + rect.h) * f },
      };
    }
    const nums = layout.resolve(found);
    if (nums?.length) return { layout, nums };
  }
  return null;
}

// 文字を読みやすくするため、グレースケール＋コントラスト強調した画像を作る
function preprocess(img) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const scale = Math.max(1, 1400 / im.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(im.width * scale);
      canvas.height = Math.round(im.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
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
    im.onerror = reject;
    im.src = img.url;
  });
}

const toHalf = (s) => s
  .replace(/[０-９％／，．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/(\d)[oO]|[oO](?=\d)/g, (m, d) => (d ? `${d}0` : '0'))
  .replace(/(\d)[lI|](?=\d)/g, (m, d) => `${d}1`);

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
  { key: 'fever', re: /FEVER|フィーバー/i, type: 'tour' },
];

function autoAssign(lines) {
  const done = new Set();
  lines.forEach((line, i) => {
    const text = toHalf(line.text.replace(/\s/g, ''));
    for (const rule of AUTO_RULES) {
      if (done.has(rule.key) || (rule.now && mode !== 'now') || (rule.type && rule.type !== eventType)) continue;
      if (!rule.re.test(text)) continue;
      const pick = (nums) => nums.find((n) => n.value >= (rule.min || 0) && (rule.key === 'fever' || !n.pct));
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
    const results = [];
    const autoFilled = new Set();
    for (current = 0; current < images.length; current++) {
      const img = images[current];

      // イベント画面なら、決まった位置の数字を数字専用の読み方で読む（速くて正確）
      setStatus(`画面の種類を確認中… ${current + 1}/${images.length}枚目`, 'busy');
      const known = await readByLayout(img).catch((e) => { console.warn(e); return null; });
      if (known) {
        if (mode !== 'now' && isEventTerm()) {
          mode = 'now';
          applyMode();
          toast(`${known.layout.name}なので「今のイベント」に切り替えました`);
        }
        known.nums.forEach((n) => {
          // 現在pt・PASS・ホイッスル・メガホンは「今のイベント」のときだけ使う
          if (PROGRESS_FIELDS.includes(n.key) && mode !== 'now') return;
          if (assign(n.key, n.value)) {
            n.assigned = n.key;
            autoFilled.add(n.key);
          }
        });
        results.push({ img, nums: known.nums });
        continue;
      }

      const { canvas, scale } = await preprocess(img);
      const worker = await getWorker();
      const { data } = await worker.recognize(canvas);
      const lines = (data.lines || []).map((l) => ({ text: l.text, nums: numbersInLine(l, scale) }));
      autoAssign(lines).forEach((k) => autoFilled.add(k));
      results.push({ img, nums: lines.flatMap((l) => l.nums) });
    }
    renderOcrResults(results);
    onChange();
    const count = results.reduce((s, r) => s + r.nums.length, 0);
    const auto = [...autoFilled].map((k) => `${LABELS[k]} ${Number($(k).value).toLocaleString('ja-JP')}`).join('・');
    setStatus(count
      ? `${auto ? `自動で入れました：${auto}\n` : ''}画像の上の数字をタップすると、どの項目か選んで入力できます。`
      : '数字が見つかりませんでした。イベントページかアイテム倉庫のスクショを、画面全体が写った状態で入れてください。',
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
    const im = document.createElement('img');
    im.src = img.url;
    im.alt = img.name;
    wrap.appendChild(im);
    nums.filter((n) => n.bbox).forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ocr-num';
      b.style.left = `${(n.bbox.x0 / img.width) * 100}%`;
      b.style.top = `${(n.bbox.y0 / img.height) * 100}%`;
      b.style.width = `${((n.bbox.x1 - n.bbox.x0) / img.width) * 100}%`;
      b.style.height = `${((n.bbox.y1 - n.bbox.y0) / img.height) * 100}%`;
      b.setAttribute('aria-label', `${n.text} を入力する`);
      if (n.bbox.x0 > img.width / 2) b.classList.add('right'); // ラベルが画面からはみ出さないように
      if (n.bbox.y0 < img.height * 0.15) b.classList.add('below');
      if (n.assigned) markAssigned(b, n.assigned);
      b.addEventListener('click', () => openSheet(n, b));
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
  });
}

// 画像の上に出すラベルは短く（となりの枠のラベルと重ならないように）
const SHORT_LABELS = {
  evepoint_now: '現在pt', pass_now: 'PASS', whistle: 'ホイッスル', megaphone: 'メガホン', now_bp: 'BP', now_ticket: 'チケット',
};

function markAssigned(btn, key) {
  btn.classList.add('assigned');
  btn.dataset.label = SHORT_LABELS[key] || LABELS[key];
}

// ---- 項目選択シート ----
function openSheet(num, btn) {
  haptic();
  $('sheetValue').textContent = num.text;
  const list = $('sheetList');
  list.innerHTML = '';
  ['goal_point', ...scanKeys()].forEach((key) => {
    const isPct = /bonus|tokkou|fever/.test(key);
    if (num.pct && !isPct) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-item';
    b.append(el('span', '', LABELS[key]), el('b', '', $(key).value || '—'));
    b.addEventListener('click', () => {
      if (assign(key, num.value)) {
        markAssigned(btn, key);
        onChange();
        toast(`${LABELS[key]} に ${$(key).value} を入れました`);
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
}

// ---- 起動 ----
// 予期しないエラーで画面が固まったときに、何が起きたか分かるよう表示する
function showFatal(message) {
  let bar = document.getElementById('fatal');
  if (!bar) {
    bar = el('div', 'fatal');
    bar.id = 'fatal';
    const reload = el('button', '', '再読み込み');
    reload.type = 'button';
    reload.addEventListener('click', () => location.reload());
    bar.append(el('span'), reload);
    document.body.appendChild(bar);
  }
  bar.firstChild.textContent = `エラーが起きました：${message}`;
}
window.addEventListener('error', (e) => showFatal(e.message || 'unknown'));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason?.message || String(e.reason)));

function init() {
  storage(() => localStorage.removeItem('enst-assist-apikey')); // 以前の版で保存していたAPIキーを消す
  buildChips();
  buildOffice();
  bindSteppers();
  load();
  applyMode();
  updateStatus();
  loadLastResult();
  setTab(prefs.tab);
  requestPersistentStorage();

  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.addEventListener('click', () => { haptic(); setTab(b.dataset.tab); });
  });
  document.querySelectorAll('.segmented button').forEach((b) => {
    b.addEventListener('click', () => {
      haptic();
      const group = b.closest('.segmented').dataset.group;
      if (group === 'mode') mode = b.dataset.value;
      if (group === 'type' && eventType !== b.dataset.value) {
        eventType = b.dataset.value;
        buildWhistleChips();
        toast(`${type().name}イベントの計算に切り替えました`);
      }
      onChange();
    });
  });
  $('quick350').addEventListener('click', () => {
    haptic();
    setValue('goal_point', QUICK_GOAL);
    flash('goal_point');
    onChange();
  });

  // 入力・設定タブの項目はどちらもここで拾う
  const onFieldEvent = (e) => { if (FIELDS.includes(e.target.id)) onChange(); };
  document.addEventListener('input', onFieldEvent);
  document.addEventListener('change', onFieldEvent);
  $('form').addEventListener('submit', (e) => e.preventDefault()); // Enterキーでページが再読み込みされないように
  $('goBtn').addEventListener('click', calculate);
  $('toScan').addEventListener('click', () => { haptic(); setTab('scan'); });

  $('proxyUrl').addEventListener('change', () => {
    const v = $('proxyUrl').value.trim();
    if (v && !/^https:\/\/[^\s]+$/.test(v)) {
      toast('URLは https:// から始まる形で入れてください');
      return;
    }
    prefs.proxy = v;
    savePrefs();
    toast(v ? '中継サーバーを登録しました' : '標準の中継サーバーを使います');
  });

  $('shareBtn').addEventListener('click', async () => {
    haptic();
    const data = { title: 'ダイヤ計算アシスト', text: 'あんスタ!!Music のイベントダイヤ計算（enst-lab）をスマホで簡単に入力できるアプリ', url: APP_URL };
    try {
      if (navigator.share) {
        await navigator.share(data);
      } else {
        await navigator.clipboard.writeText(APP_URL);
        toast('アプリのURLをコピーしました');
      }
    } catch (_) { /* 共有をキャンセルしたときなど */ }
  });

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
    images.forEach((img) => img.original && URL.revokeObjectURL(img.original));
    images = [];
    renderThumbs();
    $('ocrResults').innerHTML = '';
    setStatus('');
  });

  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  $('sheetClose').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

init();
