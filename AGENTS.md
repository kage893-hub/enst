# AGENTS.md — enst-lab 入力アシスト 引き継ぎメモ

このリポジトリで作業するエージェント向けのメモです。ユーザーへの返答・コードのコメント・コミットメッセージは**日本語**で書いてください。

## プロジェクト概要

「あんさんぶるスターズ!!Music」のイベントダイヤ計算サイト **enst-lab**（非公式ファンツール・個人運営）への入力を代行し、結果をアプリ内に表示する**自分用＋友達用の静的Webアプリ**。

- ユニット新曲：https://enst-lab.com/event.php → 結果 `event_result.php`
- ツアー：https://enst-lab.com/event_sp.php → 結果 `event_sp_result.php`
- 公開URL：https://kage893-hub.github.io/enst/assist.html （GitHub Pages）
- **GitHub Pages は `claude/determined-feynman-f6166p` ブランチの `/ (root)` から配信中**。リポジトリのデフォルトブランチ（`ccr-2478c7de-wgbf8w`）は初期状態のまま。main への統合はまだしていない。
- ビルド不要（素の HTML / CSS / ES Modules）。外部ライブラリは CDN から読み込む。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `assist.html` / `assist.js` / `assist.css` | 本体アプリ（PWA）。下部タブ：スキャン／入力／結果／設定 |
| `sw.js` | Service Worker（ネットワーク優先・HTTPキャッシュを使わない） |
| `manifest.webmanifest`, `icon*.png`, `icon.svg` | PWA 用 |
| `worker/enst-proxy.js` | 結果受け取り用の中継サーバー（Cloudflare Workers）。ユーザーがデプロイ済み：`https://enst-proxy.kage893.workers.dev` |
| `index.html` / `app.js` / `style.css` | 初期に作ったオフライン簡易計算機（旧版。ほぼ触っていない） |
| `README.md` | 利用者向けの説明 |

## 主な機能と仕組み

### 1. 入力 → enst-lab で計算 → 結果をアプリ内に表示
- `EVENT_TYPES`（unit / tour）ごとに送る項目が違う。共通項目は `COMMON_FIELDS`。
- `buildPayload()` が enst-lab のフォームと同じ項目名で送信内容を作る。`event_flg` は現在 `'sp'`（`ENST_EVENT_FLG`。enst-lab 側の `event_new_next` / `event_sp_next` 由来）。
- enst-lab は CORS で結果を読ませないため、`DEFAULT_PROXY`（Cloudflare Worker）経由で POST し、返ってきた結果 HTML を `parseResult()` で解析（`tbody.member2` が主要結果、`tbody.member3` が詳細、`#score_result` が現在pt）。
- 中継サーバーは `Origin` が `https://kage893-hub.github.io`（と localhost）のときだけ受け付け、送信先は enst-lab の2つの結果ページに限定。
- 「今のイベント」は**開催中の種類でしか計算できない**（enst-lab が `error_event.html?code=2` にリダイレクト）。その場合は結果タブに理由を表示。
- 計算結果は**最新10回分**を `localStorage['enst-assist-history']` に保存し、結果タブ下部の「これまでの結果」から開ける。

### 2. 入力の保存
- 入力値は `localStorage['enst-assist-v1']`、設定は `enst-assist-prefs`。ブラウザを閉じても残る。
- イベント期間判定（`isEventTerm`）と期間キー（`eventKey`）は enst-lab の JS（`js/main3.js` / `js/main4.js`）と同じロジック。イベントが変わったら進捗系（現在pt・PASS・ホイッスル・メガホン・BP・チケット）だけリセット。
- 目標は「350万にする」ボタンでワンタップ入力（`QUICK_GOAL`）。

### 3. スクショ読み取り（無料・端末内 OCR）
- **Claude API などの外部APIは使わない方針**（ユーザーの指示で削除済み。再追加しないこと）。
- Tesseract.js v5（CDN）をブラウザ内で実行。`SCREEN_LAYOUTS` に画面ごとの読み取り位置を定義。
  - **イベントページ**：累計イベントpt（右下・`pt` 付きのときだけ採用）、PASS（左下オレンジボタン）
  - **アイテム倉庫（消費アイテム）**：上部バーの BP「5/10」・WORK「1/12」の左側、一覧の先頭3マスをアイコンの色で判定（オレンジ多＝メガホン、赤多＝ホイッスル）して「×N」を読む。メガホンが一覧に無ければ 0 個。
  - ユニット新曲・ツアーで同じ画面（ユニット新曲のイベントページ実物では未確認）。
- 位置計算（`regionRect`）のモデル：
  - 基準は 2000×900 のスクショ（左右にノッチよけ余白 114 がある端末）。
  - 拡大率 `s = min(W*9/16, H) / 900`（16:9 の枠が収まる大きさ）。
  - 各領域は `ax`（left/right/center）と `ay`（top/bottom/middle）の基準を持つ。
  - 左右の余白は端末ごとに違うので `insetCandidates()` を全部試し、文字が長く・自信度の高い読みを採用（`readByLayout` の `readBest`）。
- 二値化（`binarizeRegion`）は3段階のしきい値を試す。`ink`：`dark`（明るい地に黒文字）／`light`（色地に白文字）／`outline`（縁取りだけの白抜き文字）。
- `outline` は `extractOutlinedFill()` で「縁に囲まれた白い部分（＝文字の中身）」だけを取り出す（影で 5→8 などの誤読を防ぐ）。
- 数字専用ワーカー（`eng`、whitelist `0123456789,/ptx`、PSM 7）。`x` はアイテム数の「×」用で、読み取り後に先頭から除去。
- 決まった画面でなければ、全体を `jpn+eng` で読み、画像上の数字をタップして項目を割り当てる UI にフォールバック。

### 4. 確認済みの端末・画像
- スマホ 2000×900（ノッチ余白あり）、タブレット 2000×1250（余白なし）の実スクショで全項目が正しく読めることを確認。
- 友達の iPhone のスクショ（2000×923、元は 2556×1179 相当）でも全項目を確認。BP/チケットが満タンのとき上の表示が「あと…」ではなく「MAX」になるが、読み取りには影響なし。
- 古い iOS など `createImageBitmap` が使えない端末向けに、`<img>` で読み込む代替処理あり（`decodeImage`）。
- ユーザーの実スクショ（ゲーム画面）は**著作物を含むのでリポジトリにコミットしない**こと。

## 作業ルール（これまでの合意）

- 変更したら**キャッシュ対策を必ず更新**する：
  - `assist.html` の `assist.css?v=...` / `assist.js?v=...` のバージョン文字列を変える
  - `sw.js` の `CACHE` 名の番号を上げる
- enst-lab は個人運営サイトなので、**自動で大量に送信しない**。テストは保存した結果HTMLを返すモック（Playwright の `route`）で行い、実サイトへの送信は最小限に。
- enst-lab の計算式を逆算する件はユーザーに提案中で**未着手**（実行前に回数などをユーザーに確認すること）。
- 検証は Playwright（Chromium）で 390×844 のスマホ幅表示を確認するのが基本。`node --check assist.js` で構文チェック。
- 中継サーバーのコードを変えた場合、ユーザーが Cloudflare のダッシュボードで手動デプロイし直す必要がある（その旨を伝える）。

## 未対応・今後の候補

- ユニット新曲のイベントページ実物での読み取り確認（次のユニット新曲イベントでスクショをもらう）
- iPad（4:3）など別の縦横比での読み取り確認
- 履歴の引き継ぎ（旧 `enst-assist-result` → 履歴1件目）は、計算10回未満のケースを未確認
- 必要なら `claude/determined-feynman-f6166p` を main に統合し、Pages の配信元を切り替える
