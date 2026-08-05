# CLAUDE.md

このリポジトリ（bm-map-posting）固有の指示。

## 用語の定義

システム全体で以下の用語を統一して使用する（issue#1で定義）。

- **エリア**: 町丁目単位の領域。地図上は紺色の境界線で表示される（`public/data/boundary_chome.geojson`、
  表示専用・クリック不可の補助レイヤー）。データ上は `areas` テーブルの `town` + `chome` の組で識別される。
  「エリア担当」（`areas.area_manager_id` / `area_manager_name`）はこの単位で設定する。
- **区画**: エリア内の最小単位の領域（基本単位区）。地図上は青色の境界線で表示され、クリック対象・
  データの実体（`areas` テーブルの1行、`area_id` で識別）となる。「担当者」（`term_data.assignee_id` /
  `assignee_name`）・配布実績（`term_data.distributed_total` 等）はこの単位で記録する。

「エリア担当」と「担当者」は別概念（前者はエリア単位、後者は区画単位）。エリア担当を設定すると、
同一エリア内で担当者未設定の区画に担当者として一括反映される（詳細は `worker/records.ts` の
`setAreaManager` のコメント参照）。
