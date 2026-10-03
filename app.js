(() => {
  'use strict';

  const STORAGE_KEY = 'enst-event-calc-v1';

  // ゲーム仕様の初期値（あんスタ!!Music）
  const SPEC_DEFAULTS = {
    bpMax: 10,          // BP上限
    bpRecoverMin: 30,   // 1BP回復にかかる分数
    diaPerRefill: 20,   // ダイヤ回復1回のダイヤ数
    bpPerRefill: 10,    // ダイヤ回復1回で回復するBP
    minPerSong: 3,      // 1曲あたりの所要時間（分）
  };

  const INPUT_DEFAULTS = {
    localEventType: 'unit',
    liveScore: '',
    liveBonus: '0',
    tourScore4: '',
    tourBonus4: '0',
    tourFever: '100',
    eventScore: '',
    eventBonus: '0',
    endAt: '',
    nowAt: '',
    targetPt: '',
    currentPt: 0,
    ptPerSong: '',
    bpPerSong: 10,
    currentBp: 0,
    ownedDia: 0,
    extraBp: 0,
    idleHours: 7,
  };

  const FIELDS = [...Object.keys(INPUT_DEFAULTS), ...Object.keys(SPEC_DEFAULTS)];
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString('ja-JP');
  const fmtPt = (n) => Number.isInteger(n) ? fmt(n) : n.toLocaleString('ja-JP', { maximumFractionDigits: 2 });

  let nowIsLive = true; // 現在日時を手入力していない間は自動で今の時刻を使う

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatDuration(minutes) {
    if (!isFinite(minutes) || minutes <= 0) return '0分';
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = Math.floor(minutes % 60);
    return [d && `${d}日`, h && `${h}時間`, (m || (!d && !h)) && `${m}分`].filter(Boolean).join('');
  }

  function num(id) {
    const v = parseFloat($(id).value);
    return isFinite(v) ? v : 0;
  }

  // 1BPあたりのイベントptを概算する。音楽ゲームの基本式にPASS消費分も加える。
  function estimatePtPerBp() {
    const score13 = num('liveScore');
    const eventScore = num('eventScore');
    if (!score13) return null;
    const bonus13 = Math.max(0, num('liveBonus')) / 100;
    const base13 = 2500 + Math.floor(score13 * 2);
    let liveRate;
    if ($('localEventType').value === 'tour') {
      const score4 = num('tourScore4');
      if (!score4) return null;
      const bonus4 = Math.max(0, num('tourBonus4')) / 100;
      const fever = Math.max(50, Math.min(110, num('tourFever') || 100)) / 100;
      const base4 = 2250 + Math.floor(score4 * 2);
      liveRate = (3 * base13 * (1 + bonus13) + base4 * (1 + bonus4) * fever) / 4;
    } else {
      liveRate = (2000 + Math.floor(score13 * 2)) * (1 + bonus13);
    }
    // 1BPでおよそ10PASSを得る。イベント曲は100PASS単位で計算。
    const eventRate = eventScore
      ? (10000 + Math.floor(eventScore * 2)) * (1 + Math.max(0, num('eventBonus')) / 100) / 10
      : 0;
    return liveRate + eventRate;
  }

  function updateFormulaPreview() {
    document.querySelectorAll('.tour-field').forEach((el) => {
      el.hidden = $('localEventType').value !== 'tour';
    });
    const rate = estimatePtPerBp();
    $('formulaPreview').textContent = rate
      ? `試算：約${fmtPt(rate)}pt/BP（イベント曲のPASS分を含む）。選んだBPでの1曲ptは約${fmtPt(rate * Math.max(1, num('bpPerSong')))}ptです。`
      : '通常ライブのスコアを入力すると、獲得ptを試算します。';
  }

  function futureRewardBp(currentPt, reachedPt, eventType) {
    const whistleRewards = [
      [6000, 3], [40000, 3], [90000, 3], [140000, 3], [260000, 3],
      [360000, 5], [420000, 5], [540000, 5],
    ];
    let bp = whistleRewards.reduce((sum, [at, count]) =>
      sum + (at > currentPt && at <= reachedPt ? count : 0), 0);
    const lastMegaphoneAt = eventType === 'tour' ? 2955000 : 3000000;
    for (const at of [1050000, 2550000, lastMegaphoneAt]) {
      if (at > currentPt && at <= reachedPt) bp += 10;
    }
    return bp;
  }

  // ---- 保存・復元 ----
  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (_) { /* 保存領域が使えない環境では初期値で動かす */ }
    const values = { ...INPUT_DEFAULTS, ...SPEC_DEFAULTS, ...saved };
    nowIsLive = !saved.nowAt;
    FIELDS.forEach((key) => { $(key).value = values[key]; });
    if (nowIsLive) $('nowAt').value = toLocalInput(new Date());
  }

  function save() {
    const data = {};
    FIELDS.forEach((key) => { data[key] = $(key).value; });
    if (nowIsLive) data.nowAt = '';
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) { /* 保存できなくても計算は続ける */ }
  }

  function buildBpOptions() {
    const select = $('bpPerSong');
    const current = parseInt(select.value, 10) || INPUT_DEFAULTS.bpPerSong;
    const max = Math.max(1, Math.floor(num('bpMax')) || SPEC_DEFAULTS.bpMax);
    select.innerHTML = '';
    for (let b = 1; b <= max; b++) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = `${b} BP（×${b}）`;
      select.appendChild(opt);
    }
    select.value = Math.min(current, max);
  }

  // ---- 計算 ----

  // イベント終了までに自然回復するBP。放置時間中に上限まで溜まった分は取りこぼす。
  function naturalBp(minutesLeft, spec, idleHours) {
    if (minutesLeft <= 0) return 0;
    const gross = minutesLeft / spec.bpRecoverMin;
    const fillMin = spec.bpMax * spec.bpRecoverMin;
    const lostPerDay = Math.max(0, idleHours * 60 - fillMin) / spec.bpRecoverMin;
    return Math.max(0, Math.floor(gross - lostPerDay * (minutesLeft / 1440)));
  }

  function plan(remainPt, ptPerSong, bpPerSong, availableBp, spec) {
    const songs = Math.ceil(remainPt / ptPerSong);
    const needBp = songs * bpPerSong;
    const shortBp = Math.max(0, needBp - availableBp);
    const refills = Math.ceil(shortBp / spec.bpPerRefill);
    return {
      songs,
      needBp,
      shortBp,
      refills,
      dia: refills * spec.diaPerRefill,
      playMin: songs * spec.minPerSong,
    };
  }

  function calculate() {
    updateFormulaPreview();
    const spec = {
      bpMax: Math.max(1, num('bpMax')),
      bpRecoverMin: Math.max(1, num('bpRecoverMin')),
      diaPerRefill: Math.max(1, num('diaPerRefill')),
      bpPerRefill: Math.max(1, num('bpPerRefill')),
      minPerSong: Math.max(0, num('minPerSong')),
    };

    const end = $('endAt').value ? new Date($('endAt').value) : null;
    const now = $('nowAt').value ? new Date($('nowAt').value) : new Date();
    const minutesLeft = end ? Math.max(0, (end - now) / 60000) : 0;

    $('remainText').textContent = end
      ? (minutesLeft > 0 ? `イベント終了まで残り ${formatDuration(minutesLeft)}` : 'イベントは終了しています')
      : '終了日時を入れると、自然回復するBPも計算に含めます。';

    const target = num('targetPt');
    const current = num('currentPt');
    const ptPerSong = num('ptPerSong');
    const bpPerSong = Math.max(1, num('bpPerSong'));
    const ownedDia = num('ownedDia');
    const remainPt = Math.max(0, target - current);

    const natural = naturalBp(minutesLeft, spec, num('idleHours'));
    const baseAvailableBp = num('currentBp') + natural + num('extraBp');
    let rewardBp = 0;
    let availableBp = baseAvailableBp;
    const pointRate = ptPerSong && bpPerSong ? ptPerSong / bpPerSong : 0;
    // 目標までに届く報酬だけを加え、報酬BPで次の境界へ届く場合も順に含める。
    for (let i = 0; i < 12 && pointRate; i++) {
      const reach = current + Math.floor(availableBp * pointRate);
      const next = futureRewardBp(current, Math.min(target || reach, reach), $('localEventType').value);
      if (next <= rewardBp) break;
      rewardBp = next;
      availableBp = baseAvailableBp + rewardBp;
    }

    renderResult({ spec, target, remainPt, ptPerSong, bpPerSong, ownedDia, natural, rewardBp, availableBp, minutesLeft });
    renderCompare({ spec, remainPt, ptPerSong, bpPerSong, availableBp, minutesLeft });
    save();
  }

  function stat(label, value, sub = '', cls = '') {
    return `<div class="stat ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
  }

  function renderResult(c) {
    const el = $('result');
    if (!c.target || !c.ptPerSong) {
      el.innerHTML = '<p class="hint">目標ptと1曲あたりの獲得ptを入力してください。</p>';
      return;
    }
    if (c.remainPt <= 0) {
      el.innerHTML = '<p class="done">目標ptに到達しています 🎉</p>';
      return;
    }

    const p = plan(c.remainPt, c.ptPerSong, c.bpPerSong, c.availableBp, c.spec);
    const diaLeft = c.ownedDia - p.dia;
    const days = c.minutesLeft / 1440;

    // 所持ダイヤを全部BPに変えた場合に届くpt
    const maxRefills = Math.floor(c.ownedDia / c.spec.diaPerRefill);
    const maxBp = c.availableBp + maxRefills * c.spec.bpPerRefill;
    const reachPt = Math.floor(maxBp / c.bpPerSong) * c.ptPerSong;
    const reachTotal = c.target - c.remainPt + reachPt;

    let html = '<div class="stats">';
    html += stat('残りpt', fmt(c.remainPt));
    html += stat('残り曲数', `${fmt(p.songs)}曲`, days >= 1 ? `1日あたり 約${(p.songs / days).toFixed(1)}曲` : '');
    html += stat('必要BP', fmt(p.needBp), `手持ち＋自然回復＋その他 ${fmt(c.availableBp)}`);
    html += stat('必要ダイヤ', fmt(p.dia), p.refills ? `BP回復 ${fmt(p.refills)}回` : 'ダイヤ回復なしで到達可能', 'accent');
    html += stat('プレイ後の残りダイヤ', fmt(diaLeft), diaLeft < 0 ? `${fmt(-diaLeft)}ダイヤ不足` : '', diaLeft < 0 ? 'warn' : '');
    html += stat('プレイ時間の目安', formatDuration(p.playMin), `1曲 ${c.spec.minPerSong}分で計算`);
    html += '</div>';

    html += '<ul class="notes">';
    if (c.minutesLeft > 0) {
      html += `<li>終了までの自然回復BP: <b>${fmt(c.natural)}</b>（放置中の取りこぼしを除く）</li>`;
      if (p.playMin > c.minutesLeft) {
        html += `<li class="warn-text">プレイ時間が残り時間を超えています。消費BPを増やすことを検討してください。</li>`;
      }
    }
    if (c.rewardBp) html += `<li>到達見込みのイベント報酬: <b>+${fmt(c.rewardBp)}BP</b>（ホイッスル・メガホン）</li>`;
    if ($('localEventType').value === 'unit') {
      html += '<li>楽曲イベントのメガホン3個目は3,000,000ptとして仮置きしています。</li>';
    }
    html += `<li>所持ダイヤをすべてBP回復に使うと、最終 <b>${fmt(reachTotal)}pt</b> まで到達見込み`
      + (reachTotal >= c.target ? '（目標達成可能）' : `（目標まで ${fmt(c.target - reachTotal)}pt 不足）`) + '</li>';
    html += '</ul>';

    el.innerHTML = html;
  }

  function renderCompare(c) {
    const tbody = $('compare').querySelector('tbody');
    tbody.innerHTML = '';
    if (!c.ptPerSong || c.remainPt <= 0) return;
    const ptPerBp = c.ptPerSong / c.bpPerSong;
    for (let b = 1; b <= c.spec.bpMax; b++) {
      const pt = Math.round(ptPerBp * b);
      const p = plan(c.remainPt, pt, b, c.availableBp, c.spec);
      const tr = document.createElement('tr');
      if (b === c.bpPerSong) tr.className = 'current';
      const overTime = c.minutesLeft > 0 && p.playMin > c.minutesLeft;
      tr.innerHTML = `<td>${b}</td><td>${fmt(pt)}</td><td>${fmt(p.songs)}</td><td>${fmt(p.dia)}</td>`
        + `<td class="${overTime ? 'warn-text' : ''}">${formatDuration(p.playMin)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ---- イベント ----
  function init() {
    buildBpOptions();
    load();
    buildBpOptions();

    document.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', () => {
        if (el.id === 'nowAt') nowIsLive = false;
        if (el.id === 'bpMax') buildBpOptions();
        calculate();
      });
    });

    $('nowBtn').addEventListener('click', () => {
      nowIsLive = true;
      $('nowAt').value = toLocalInput(new Date());
      calculate();
    });

    $('resetSpec').addEventListener('click', () => {
      Object.entries(SPEC_DEFAULTS).forEach(([k, v]) => { $(k).value = v; });
      buildBpOptions();
      calculate();
    });

    $('clearAll').addEventListener('click', () => {
      if (!confirm('入力内容をすべて初期値に戻しますか？')) return;
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* noop */ }
      load();
      buildBpOptions();
      calculate();
    });

    $('useEstimate').addEventListener('click', () => {
      const rate = estimatePtPerBp();
      if (!rate) {
        $('formulaPreview').textContent = '通常ライブのスコア（ツアーは4曲目も）を入力してください。';
        return;
      }
      $('ptPerSong').value = String(Number((rate * Math.max(1, num('bpPerSong'))).toFixed(2)));
      calculate();
    });

    // 現在日時を自動更新（1分ごと）
    setInterval(() => {
      if (!nowIsLive) return;
      $('nowAt').value = toLocalInput(new Date());
      calculate();
    }, 60000);

    calculate();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
