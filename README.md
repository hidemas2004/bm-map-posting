# bm-map-posting

神奈川県内の指定行政区域（市区町丁目単位）を対象に、ポスティング活動の予実（配布予定・実績）を
地図上で管理するツール。陣営内部限定。既存の内部ツール `bm-map-streetad`（街宣記録の地図可視化）
とは独立した別プロジェクトだが、同一の設計思想（Cloudflare Workers単一エントリポイント・
ビルドレス・認証の差し替え可能設計）を踏襲している。

## 構成

- Cloudflare Workers（`worker/index.ts`）が静的アセット配信とAPIを兼ねる単一エントリポイント。
  ビルドステップは無し（素のHTML/CSS/JS、Leaflet.jsをCDNから読み込み）。
- データはCloudflare D1（`worker/index.ts` の `DB` バインディング）。世帯数・地域構成などの
  静的情報（`areas`）と、ターム（配布期間）ごとに変動する担当者・実績（`term_data`）を分離して
  正規化している。過去タームの `term_data` 行は新タームを開始しても変更・削除されず、そのまま
  参照できる（`worker/terms.ts` の `createNewTerm`）。
- 認証はユーザーマスタ方式（`users` テーブル）。ログインロジックは `worker/auth.ts` に分離してあり、
  将来の認証方式変更や `bm-map-streetad` との統合時もこのファイルの中身を差し替えるだけでよい。
  セッションはHMAC署名付きの自己完結トークンをフロント側の `sessionStorage` に保持し、
  `Authorization: Bearer` ヘッダで送信する（サーバー側にセッションストアを持たない）。
- 境界データは `public/data/boundary.geojson`。横浜市18区分の行政区域境界（`niiyz/JapanCityGeoJson`
  由来、区単位）を同梱している。**e-Stat標準地域コード（丁目単位・11桁）への格上げは未実施**
  （下記「既知の制約」参照）。

## コマンド

```bash
npm install
npx wrangler dev      # ローカル確認。.dev.vars.example を参考に .dev.vars を作成しておく
npx wrangler deploy   # 本番デプロイ（要 Cloudflare 認証・D1本番データベース作成）
```

### ローカルD1の初期化

```bash
npx wrangler d1 execute bm-posting-db --local --file=migrations/0001_init.sql
npx wrangler d1 execute bm-posting-db --local --file=seed/areas_yokohama.sql
npx wrangler d1 execute bm-posting-db --local --file=seed/users.sql
```

## シークレット・環境変数

`.dev.vars.example` を `.dev.vars` にコピーして値を設定する（`.dev.vars` はgit管理対象外）。
本番はCloudflareの `wrangler secret put <NAME>` で設定する。

| 変数名 | 用途 |
|---|---|
| `SESSION_SECRET` | ログインセッショントークンの署名鍵 |
| `AREAS_IMPORT_TOKEN` | 地域マスタ一括投入API（`POST /api/areas/import`、未実装）用の保護トークン |
| `ESTAT_APP_ID` | e-Stat GIS APIのアプリケーションID（丁目単位境界データ取得用。現状未使用） |

## 既知の制約・今後の作業

- **境界データが区単位**: `areas` テーブルおよび `public/data/boundary.geojson` は横浜市18区分
  （区単位）のプレースホルダデータ。世帯数は概算値であり、正式なデータではない。実データは
  ポスティング業者サイト等から正式に入手して差し替える前提（指示書に明記の通り）。
  丁目単位（e-Stat標準地域コード）へ格上げする場合は、`areas` テーブルの再シードと
  `boundary.geojson` の差し替えが必要（`area_id` の桁数・採番方式が変わる点に注意）。
- **e-Stat連携は未実施**: 本リポジトリを構築した開発環境は `e-stat.go.jp` への外部通信が
  ネットワークポリシーにより遮断されており、e-Stat GIS APIの疎通確認自体ができなかった
  （`ESTAT_APP_ID` の有無に関わらず接続不可）。到達可能な環境で `ESTAT_APP_ID` を取得のうえ、
  改めて取得・正規化（同一自治体内の複数ポリゴンが単一Polygonの多重リングとして表現されている
  場合の分割処理を含む）を行う必要がある。
- **`POST /api/areas/import`（地域マスタ一括投入）は未実装**。現状はシードSQLで代用している。
- **本番環境は未構築**: D1本番データベースの作成、Secretsの設定、`wrangler deploy` はいずれも
  実行していない（下記チェックリスト参照）。
- 境界GeoJSON（約860KB）は簡易な地図表示には十分だが、丁目単位に格上げするとデータ量が
  大きく増える見込みのため、必要に応じてmapshaper等での簡略化を検討する。

## デプロイ前チェックリスト

1. `npx wrangler login` でCloudflareアカウントに認証する
2. `npx wrangler d1 create bm-posting-db` で本番D1データベースを作成し、`wrangler.jsonc` の
   `database_id`（現在 `REPLACE_WITH_PRODUCTION_D1_ID`）を実際のIDに置き換える
3. 本番D1へマイグレーション・シードを適用する
   （`npx wrangler d1 execute bm-posting-db --remote --file=migrations/0001_init.sql` 等。
   `seed/users.sql` の合言葉は本運用前に必ず変更すること）
4. `wrangler secret put SESSION_SECRET` 等、上記シークレットをCloudflare側に設定する
5. 実際の地域データ（世帯数・境界GeoJSON）を正式なものに差し替える
6. `npx wrangler deploy` で本番デプロイする
