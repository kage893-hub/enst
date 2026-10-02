// enst-lab 入力アシスト
// 入力内容を enst-lab のイベントダイヤ計算機（ユニット新曲イベント用）へ POST して結果ページを開く。
// 画像からの読み取りは Claude API（ブラウザから直接呼び出し）で行う。

const ENST_ACTION = 'https://enst-lab.com/event_result.php';
// event.php 側の `event_new_next` が false のとき 'sp' が送られる（2026/10 時点）
const ENST_EVENT_FLG = 'sp';

const STORAGE_KEY = 'enst-assist-v1';
const API_KEY_KEY = 'enst-assist-apikey';
const MODEL_KEY = 'enst-assist-model';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';

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

const RANGES = { now_bp: [0, 20], now_ticket: [0, 24], lost_bp: [0, 30] };

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
let images = [];  // { name, mediaType, data(base64), url }

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

function load() {
  const saved = storage(() => JSON.parse(localStorage.getItem(STORAGE_KEY))) || {};
  const values = { ...DEFAULTS, ...(saved.values || {}) };

  // イベントが変わっていたら進捗系はリセット（目標や自分用設定は残す）
  if (saved.eventKey && saved.eventKey !== eventKey()) {
    PROGRESS_FIELDS.forEach((k) => { values[k] = DEFAULTS[k]; });
    values.now_bp = DEFAULTS.now_bp;
    values.now_ticket = String(ticketMax(values.office_LV));
    values.whistle100 = DEFAULTS.whistle100;
  }
  FIELDS.forEach((k) => setValue(k, values[k]));

  mode = isEventTerm() ? (saved.eventKey === eventKey() && saved.mode) || 'now' : 'start';

  $('apiKey').value = storage(() => localStorage.getItem(API_KEY_KEY)) || '';
  $('model').value = storage(() => localStorage.getItem(MODEL_KEY)) || 'claude-opus-5-5';
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
      const key = b.dataset.target;
      const cur = parseInt(normalizeNumber($(key).value), 10) || 0;
      setValue(key, String(clamp(key, cur + Number(b.dataset.step))));
      onChange();
    });
  });
}

function applyMode() {
  const term = isEventTerm();
  document.querySelectorAll('.segmented button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
    b.disabled = b.dataset.mode === 'now' && !term;
  });
  document.querySelectorAll('[data-show="now"]').forEach((el) => { el.hidden = mode !== 'now'; });

  // ログボホイッスルは「開始から」か、イベ初日のみ
  const showWhistle = mode === 'start' || isEventFirstDay();
  $('whistleCard').hidden = !showWhistle;

  $('bpLabel').textContent = mode === 'now' ? '現在残りBP' : 'イベ開始時BP';
  $('ticketLabel').textContent = mode === 'now' ? '残りお仕事チケット' : '開始時お仕事チケット';
  $('termText').textContent = term
    ? 'いまはイベント期間中です'
    : 'いまはイベント期間外なので「イベント開始から」で計算します';
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
  updateDock();
  save();
}

function updateDock() {
  const errors = validate(getValues());
  document.querySelectorAll('.field.error').forEach((el) => el.classList.remove('error'));
  $('dockMsg').textContent = errors.length ? `あと ${errors.length} 項目：${errors[0][1]}` : '準備OK！';
  $('dockMsg').classList.toggle('ok', !errors.length);
}

function submit() {
  const v = getValues();
  const errors = validate(v);
  if (errors.length) {
    errors.forEach(([key]) => $(key).closest('.field')?.classList.add('error'));
    const first = $(errors[0][0]);
    first.closest('details')?.setAttribute('open', '');
    first.closest('.field').scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (first.type !== 'hidden') first.focus({ preventScroll: true });
    return;
  }
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
  return { name: file.name, mediaType: 'image/jpeg', data: url.split(',')[1], url };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  setStatus('画像を準備中…');
  for (const f of files) {
    try {
      images.push(await toJpeg(f));
    } catch (_) {
      setStatus(`${f.name} は読み込めませんでした`, 'warn');
    }
  }
  renderThumbs();
  setStatus(`${images.length}枚の画像があります。「読み取る」を押してください。`);
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

async function readImages() {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    $('apiCard').open = true;
    $('apiKey').focus();
    setStatus('画像の読み取りには APIキーの設定が必要です（下の「画像読み取りの設定」）', 'warn');
    return;
  }
  const model = $('model').value;
  $('readBtn').disabled = true;
  setStatus('読み取り中…（10〜30秒ほどかかります）', 'busy');

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
  } finally {
    $('readBtn').disabled = !images.length;
  }
}

const LABELS = {
  evepoint_now: '現在pt', pass_now: 'PASS', whistle: 'ホイッスル', megaphone: 'メガホン',
  now_bp: 'BP', now_ticket: 'チケット', user_rank: 'RANK',
  bonus_nomal: '通常曲特効', bonus_event: 'イベ曲特効', nomal_score: '通常曲スコア', event_score: 'イベ曲スコア',
};

function applyExtracted(r) {
  const filled = [];
  const put = (key, n) => {
    if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return;
    setValue(key, String(Math.floor(n)));
    const field = $(key).closest('.field');
    field?.classList.remove('filled');
    void field?.offsetWidth; // アニメーションを再生し直す
    field?.classList.add('filled');
    filled.push(LABELS[key]);
  };

  // スコアは「万」単位で入力する
  const toMan = (n) => (n == null ? null : n >= 10000 ? Math.floor(n / 10000) : n);

  if (mode === 'now') {
    put('evepoint_now', r.evepoint_now);
    put('pass_now', r.pass_now);
    put('whistle', r.whistle);
    put('megaphone', r.megaphone == null ? null : Math.min(3, r.megaphone));
  }
  put('now_bp', r.now_bp == null ? null : Math.min(20, r.now_bp));
  put('now_ticket', r.now_ticket == null ? null : Math.min(24, r.now_ticket));
  put('user_rank', r.user_rank);
  put('bonus_nomal', r.bonus_nomal);
  put('bonus_event', r.bonus_event);
  put('nomal_score', toMan(r.nomal_score));
  put('event_score', toMan(r.event_score));

  onChange();
  const note = r.notes ? `\nメモ：${r.notes}` : '';
  setStatus(filled.length
    ? `入力しました：${filled.join('・')}。数字が合っているか確認してください。${note}`
    : `入力できる数字が見つかりませんでした。${note}`, filled.length ? 'ok' : 'warn');
}

// ---- 起動 ----
function init() {
  buildChips();
  buildOffice();
  bindSteppers();
  load();
  applyMode();
  updateDock();

  document.querySelectorAll('.segmented button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      onChange();
    });
  });
  $('form').addEventListener('input', onChange);
  $('form').addEventListener('change', onChange);
  $('form').addEventListener('submit', (e) => e.preventDefault()); // Enterキーでページが再読み込みされないように
  $('goBtn').addEventListener('click', submit);

  $('apiKey').addEventListener('change', () => storage(() => localStorage.setItem(API_KEY_KEY, $('apiKey').value.trim())));
  $('model').addEventListener('change', () => storage(() => localStorage.setItem(MODEL_KEY, $('model').value)));

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
    if (files.length) addFiles(files);
  });
  $('readBtn').addEventListener('click', readImages);
  $('clearImgBtn').addEventListener('click', () => {
    images = [];
    renderThumbs();
    setStatus('');
  });
}

init();
