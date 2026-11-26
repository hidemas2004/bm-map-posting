# CLAUDE.md

このリポジトリ（bm-map-posting）固有の指示。

## 用語の定義

システム全体で以下の用語を統一して使用する（issue#1で定義）。

- **エリア**: 町丁目単位の領域。地図上は紺色の境界線で表示される（`public/data/regions/<地域ID>/boundary_chome.geojson`、
  表示専用・クリック不可の補助レイヤー。`wrangler.jsonc`の`env.<id>.vars.HAS_CHOME_BOUNDARY`が真の
  地域のみ存在する）。`npm run new-region`のエリア境界レイヤー有効化ステップでe-Statの町丁・字等
  境界データから自動取得できる（`scripts/lib/estat-boundary.mjs`の`fetchChomeBoundary`。既存地域への
  後付けは`scripts/backfill-chome-area-id.mjs`）。大和市分のみ、基本単位区への格上げ前データの遺物
  として例外的に存在する。データ上は `areas` テーブルの
  `chome_area_id`（`boundary_chome.geojson`の各境界ポリゴンが持つe-Stat KEY_CODEをそのまま転用したもの）
  で識別される。区画がどの境界ポリゴンに
  属するかは空間結合（`scripts/lib/geo.mjs`）で算出する。「エリア担当」（`term_data.area_manager_id` /
  `area_manager_name`。ターム単位で、同一エリア内の全区画行に同じ値を複製して持つ）はこの単位で設定する。
  （旧仕様では`areas.area_manager_*`に全ターム共通で1つだけ持っていた。`migrations/0012_term_area_manager.sql`
  で移行済みで、`areas`側の列は参照しない残置列）
  （旧仕様: `town` + `chome` の文字列組で識別していたが、e-Statが同一町名を複数KEY_CODEに分割している
  ケース（丁目のない大字等）を区別できず、別々の境界線を持つエリアが1つに誤認識される不具合があった
  ため issue#12 で変更。詳細は `migrations/0004_chome_area_id.sql` 参照）
- **区画**: エリア内の最小単位の領域（基本単位区）。地図上は青色の境界線で表示され、クリック対象・
  データの実体（`areas` テーブルの1行、`area_id` で識別）となる。「担当者」（`term_data.assignee_id` /
  `assignee_name`）・配布実績（`term_data.distributed_total` 等）はこの単位で記録する。

「エリア担当」と「担当者」（区画担当）は別概念（前者はエリア単位、後者は区画単位。どちらもターム単位）。
- エリア担当を設定すると、同一エリア内の区画（世帯数0を除く）の区画担当が一律でその人に置き換わり、
  未設定にすると区画担当も未設定になる（既存の区画担当設定も上書きする）。ただし配布実績が1以上の
  区画は、どちらの場合も区画担当・実績を残す（詳細は `worker/records.ts` の `setAreaManager` のコメント参照）。
- 配布計画の対象（予定配布エリア）は「区画担当が設定済みの区画」。区画担当が未設定なら、エリア担当が
  いても配布記録不可・集計対象外（地図上はグレー）。
- 「配布実績が1以上の区画には必ず区画担当がいる」ことをサーバー側で保証している（実績のある区画は
  未担当にできない）。この前提を崩す変更をしないこと。
- `term_data` の担当・エリア担当・実績を更新する処理を追加・変更するときは、必ず `rev`（変更番号。
  そのタームの最大値＋1）と `updated_by_name` も更新すること。画面同期（他の人の更新の反映）と楽観的
  排他制御（保存時の競合検出）がこの番号に依存している（`migrations/0015_term_data_rev.sql`、
  `worker/records.ts` の `NEXT_REV`、READMEの「画面同期と楽観的排他制御」参照）。
- 利用者向けの説明は `public/help.html`（メニューの「使い方」）。仕様を変えたら合わせて更新すること。

## 地域設定・境界データ（`/config.js`）

`public/config.js`という静的ファイルは存在しない。`/config.js`へのリクエストは
`worker/index.ts`が`worker/config.ts`の`buildConfigResponse(env)`を呼んで動的に生成する
（地域固有の表示名・地図初期座標・ズーム・チョーム境界レイヤー有無は`wrangler.jsonc`の
`env.<地域ID>.vars`から、色・しきい値等の共通見た目パラメータは`worker/config.ts`にハード
コードされたもの）。境界GeoJSONも地域ごとに`public/data/regions/<地域ID>/boundary.geojson`
という固有パスに恒久的に配置されており、「地域を切り替えるとファイルが差し替わる」という
可変状態は存在しない（過去そのような設計だった際の事故リスクを踏まえて撤廃した）。
新しい地域の追加は`npm run new-region`（`scripts/new-region.mjs`）を参照。

## CSS上の注意（`public/style.css`）

`#header` に `overflow-x: hidden` 等を付けないこと。CSSの仕様上 `overflow-y` も連動して
クリップ対象になり、`#header` の子要素として `top: 100%`（親の下端の外側）に絶対配置される
`#menu-panel`（ハンバーガーメニュー）が丸ごと非表示になる（issue#7対応時に混入し、クリックは
効くが何も表示されない不具合として発生・修正済み）。横方向のはみ出し防止が必要な場合は
`#menu-panel` を持たない `.header-row` 側に付ける。
