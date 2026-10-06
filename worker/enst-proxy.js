// enst-lab 入力アシスト用の中継サーバー（Cloudflare Workers）
//
// enst-lab の計算結果ページはブラウザから直接読み取れない（他サイトからの読み取りを許可していない）ため、
// このワーカーが代わりに enst-lab へ送信し、結果ページの HTML をそのままアプリへ返す。
// 送信先は enst-lab の2つの結果ページだけに限定している。
//
// 使い方は README の「結果をアプリ内に表示する（中継サーバー）」を参照。

const TARGETS = {
  unit: { action: 'https://enst-lab.com/event_result.php', page: 'https://enst-lab.com/event.php' },
  tour: { action: 'https://enst-lab.com/event_sp_result.php', page: 'https://enst-lab.com/event_sp.php' },
};

// アプリを置いている場所（自分の GitHub Pages）。ほかのサイトからは使えないようにする
const ALLOWED_ORIGINS = [
  'https://kage893-hub.github.io',
];

const MAX_BODY = 4096;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isAllowed(origin) {
  return ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (!isAllowed(origin)) return new Response('forbidden', { status: 403 });
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });

    const target = TARGETS[new URL(request.url).searchParams.get('type')];
    if (!target) return new Response('unknown type', { status: 400, headers: cors });

    const body = await request.text();
    if (body.length > MAX_BODY) return new Response('too large', { status: 413, headers: cors });

    // enst-lab の入力ページから送ったのと同じ形で送る（結果ページへのリダイレクトはそのままたどる）
    const res = await fetch(target.action, {
      method: 'POST',
      body,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: target.page,
        'User-Agent': 'Mozilla/5.0 (compatible; enst-assist-proxy)',
      },
    });

    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
