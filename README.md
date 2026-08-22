# bm-map-posting

神奈川県内の指定行政区域（基本単位区単位。丁目内の街区相当区画）を対象に、ポスティング活動の予実（配布予定・実績）を
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
- 境界データは地域ごとに `public/data/regions/<地域ID>/boundary.geojson`（大和市は
  `public/data/regions/14213-yamato/boundary.geojson`、約2.0MB・3,094地域）に恒久的に配置され、
  地域を切り替える「差し替え」操作は発生しない（詳細は下記「複数地域の並行運用」）。e-Stat
  （令和2年国勢調査 小地域(基本単位区)境界データ）由来の正式データで、`area_id` はe-Stat標準地域
  コード（KEY_CODE。桁数は区画により異なる）、世帯数も概算ではなく国勢調査の実数。基本単位区は
  丁目よりさらに細かい街区相当の区画（大和市の場合1区画平均約38世帯）で、同一丁目内に複数ある
  場合は区別用に`block`列（本システム独自の表示用連番。詳細は下記「行政区域データの追加・
  基本単位区単位への格上げ手順」参照）を付与している。大和市は基本単位区単位への格上げ前は
  丁目単位（136地域）だったため、どの丁目に属するかが見た目でも分かるよう、旧丁目境界を
  `public/data/regions/14213-yamato/boundary_chome.geojson`として保持し、地図上に表示専用
  （太め・紺色・クリック不可）の補助レイヤーとして重ね描きしている（`worker/config.ts`が
  `env.HAS_CHOME_BOUNDARY`が真の地域でのみ`CHOME_BOUNDARY_*`定数を`/config.js`に出力し、
  `app.js`の`loadChomeBoundary()`が読み込む。この機能は大和市専用データの遺物であり、他地域では
  既定で無効）。
- 「エリア」（エリア担当の設定単位）は`areas.chome_area_id`列（`boundary_chome.geojson`の各境界
  ポリゴンが持つe-Stat KEY_CODEをそのまま転用）で識別する。区画がどの境界ポリゴンに属するかは、
  区画データと`boundary_chome.geojson`の空間結合（点-in-ポリゴン判定、`scripts/lib/geo.mjs`）で
  算出する。旧仕様では`town`+`chome`の文字列一致で識別していたが、e-Statが同一町名を複数の
  KEY_CODEに分割しているケース（丁目のない大字。大和市では下鶴間・深見・福田・上和田・下和田が
  該当）を区別できず、地図上は別々の境界線を持つエリアが1つの巨大なエリアとして誤認識される
  不具合があったため issue#12 で変更した（`migrations/0004_chome_area_id.sql`、
  `scripts/backfill-chome-area-id.mjs`）。
- 地図画面（`public/index.html` / `app.js`）のヘッダは選択タームの全体集計（世帯数・配布数・
  配布率）と担当者フィルタ（`(全体表示)` / `(担当者未決)` / 各担当者）を表示する。担当者フィルタで
  選択中以外のエリアは濃い灰色でマスクされる。世帯数0のエリア（2026-08-05時点で172地域。基本単位区
  レベルでは商業地・工業地等が単独の区画になるケースが増えるため、丁目単位の頃より件数・比率が
  大きい）はゼロ除算を避けるため担当者設定・配布記録の対象外とし、常時グレー表示（フロント・
  バックエンド`worker/records.ts`の両方でガード）。ヘッダはクリック（select/button以外の部分）
  で開閉でき、地図は`flexbox`レイアウトで残り領域を自動的に埋める。

## コマンド

「無名のデフォルト環境」は存在しない設計のため、`dev`/`deploy`は**必ず`--env <地域ID>`を指定する**
（大和市を含む全地域が`env.<地域ID>`の名前付き環境。詳細は下記「複数地域の並行運用」）。

```bash
npm install
npx wrangler dev --env 14213-yamato      # ローカル確認。.dev.vars.example を参考に .dev.vars を作成しておく
npx wrangler deploy --env 14213-yamato   # 本番デプロイ（要 Cloudflare 認証）
```

### ローカルD1の初期化

```bash
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0001_init.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0002_areas_block_level.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0003_area_manager.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0004_chome_area_id.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0006_polling_stations.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0007_comments.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0008_add_polling_station_uncertain.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0009_gps_tracks.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=migrations/0010_gps_tracks_term_id.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=regions/14213-yamato/areas.sql
npx wrangler d1 execute bm-posting-db-14213-yamato --env 14213-yamato --local --file=seed/users.sql
```

`regions/14213-yamato/areas.sql`は`chome_area_id`列を含む形で生成済みのため、上記の順序
（0004適用後に投入）であれば`migrations/0005_backfill_chome_area_id_yamato.sql`は不要（新規
まっさらなDBのみを対象とする場合。`0005`は過去に旧・無名のデフォルト環境で行った一度限りの
バックフィルの記録として残してあるだけで、新規環境では使わない）。

## シークレット・環境変数

`.dev.vars.example` を `.dev.vars` にコピーして値を設定する（`.dev.vars` はgit管理対象外）。
本番はCloudflareの `wrangler secret put <NAME>` で設定する。

| 変数名 | 用途 |
|---|---|
| `SESSION_SECRET` | ログインセッショントークンの署名鍵 |
| `AREAS_IMPORT_TOKEN` | 地域マスタ一括投入API（`POST /api/areas/import`）用の保護トークン |
| `ESTAT_APP_ID` | e-Stat GIS APIのアプリケーションID（境界データ取得用。現状未使用） |

## API: 地域マスタ一括投入（POST /api/areas/import）

外部スクリプト等からの投入を想定した専用API。通常のユーザーログイン（セッション認証）とは
別系統で、`X-Import-Token` ヘッダを `AREAS_IMPORT_TOKEN` と照合して認可する。

```bash
curl -X POST https://<デプロイ先ホスト>/api/areas/import \
  -H "X-Import-Token: <AREAS_IMPORT_TOKENの値>" \
  -H "Content-Type: application/json" \
  -d '{
    "areas": [
      { "area_id": "142131541101", "city": "大和市", "ward": "",
        "town": "中央林間", "chome": "1", "chome_area_id": "14213154101", "block": "1", "num_households": 22 }
    ]
  }'
```

- `area_id` が既存なら上書き（UPSERT）、なければ新規追加。
- 進行中タームがある場合、新規追加された area の `term_data` 行をゼロクリア状態で自動補完する
  （既存 area_id の `term_data`・実績値は変更しない）。
- `area_id` / `city` / `num_households`（数値）は必須。`ward`（区を持たない市区町村では空文字）/
  `town` / `chome` / `block`（同一丁目内で基本単位区が複数に分かれる場合の区別用通し番号）は省略可。
- `chome_area_id`（区画が属する「エリア」のID。`boundary_chome.geojson`のarea_idを想定）も省略可。
  省略時はサーバ側で自身の`area_id`にフォールバックする（空文字にはしない。複数区画が意図せず
  同一エリア扱いになる事故を防ぐため。詳細はissue#12）。

## 履歴・地域マスタの閲覧とCSVエクスポート

配布実績の変更履歴（`activity_log`）と地域マスタ（`areas`）は、それぞれ画面上での一覧表示に加え、
CSVダウンロードに対応している（スプレッドシートでの目視確認・手元バックアップ用途を想定）。

- **`public/history.html`**（メニューの「履歴一覧」）: いつ・誰が・どのエリアで何枚増減したかの
  時系列ログ。タームで絞り込み可能。`GET /api/activity-log?term_id=<id>`（`term_id`省略で全ターム）
  と `GET /api/activity-log/export?term_id=<id>`（同内容のCSV）。
- **`public/areas.html`**（メニューの「地域マスタ一覧」）: `area_id`・市区町村・町丁目・区画・世帯数に加え、
  **直近5タームぶんの配布数・配布率**を横持ちの列として表示（`GET /api/areas/with-terms`）。
  対象タームが増減しても列は自動で追従する。CSVエクスポート（`GET /api/areas/export`）も同じ列構成。
  単純な地域一覧だけが欲しい場合は従来通り `GET /api/areas`（term列なし）も残してある。
- CSVはUTF-8 BOM付き・CRLF改行（Excelでの文字化け対策）。ダウンロードはセッショントークンを
  `Authorization`ヘッダで送る必要があるため、単純な`<a href>`ではなく`fetch`→Blob→
  `URL.createObjectURL`で実装している（`public/history.js` / `public/areas.js`）。
- 上記いずれもセッション認証必須（管理者に限らず全ログインユーザーが閲覧可）。
- **未対応**: データの直接編集・削除（記録の取消のみなら、逆方向deltaを`POST /api/record`で
  追記すれば実質的に補正できるが、それを行うUIはまだ無い）。

## ユーザーマスタの管理（CSVインポート/エクスポート、管理者限定）

`users`テーブル（ログインID・氏名・権限・合言葉・有効フラグ）は、これまでSQLを直接叩く以外に
管理手段が無かったため、`public/users.html`（メニューの「ユーザー管理」。管理者ロールのみ表示）
から一覧確認・CSVでの追加/修正ができるようにしてある。

- `GET /api/users`: 一覧（`user_id`, `name`, `role`, `active`。合言葉は含まない）
- `GET /api/users/export`: 同内容のCSV。**`passphrase`列は常に空欄**で出力する
  （ダウンロードしたファイルに現在の合言葉を平文で載せないため）
- `POST /api/users/import`: CSV（`Content-Type: text/csv`、生テキストをそのままPOST）を読み込み、
  `user_id`が既存ならUPSERT、なければ新規追加。ヘッダは`user_id,name,role,active,passphrase`
  （`user_id`, `name`のみ必須）。
  - `passphrase`列を空欄にすると、既存ユーザーの合言葉は変更しない。新規ユーザーは必須
  - `role`省略時は「一般」、`active`省略時は`1`（ログイン可）として扱う
  - 想定運用: CSVダウンロード→表計算ソフトで編集（変更する合言葉のセルだけ入力）→アップロード
- 上記3つとも`requireAdmin`（管理者ロールのセッション）必須。`POST /api/areas/import`とは異なり
  外部スクリプト向けの専用トークンではなく、ブラウザからの管理者操作を想定した設計。

## 地図コメント機能（issue#24）

地図上の任意地点にコメント（ポスト禁止・ポスター候補・その他）を記録できる。
term/areaに紐付かない独立データ（`comments`テーブル、投票所と同じ思想）で、全ターム共通で
表示・編集される。API本体は`worker/comments.ts`、`GET/POST /api/comments`・
`PUT/DELETE /api/comments/:id`。編集・削除に管理者権限は不要（`requireAuth`のみ。
担当者設定と同じ運用方針）。

画像添付は当初検討したがオーバースペックのため見送り、R2バケットも使用しない
（2026-08時点）。

## GPS移動軌跡の記録・照会機能

配布員が実際にどのルートを歩いたかを記録し、事後的に地図上で確認できる機能。ヘッダの
「🔴」ボタンで記録開始/終了、記録中は地図上にリアルタイムで軌跡線を描画する。ハンバーガー
メニューの「軌跡照会」から日付範囲を指定して過去の軌跡を表示・消去できる。

- API本体は`worker/gps_tracks.ts`。`gps_tracks`（記録セッション単位）と`gps_track_points`
  （座標点単位）にテーブルを分割している（`migrations/0009_gps_tracks.sql`）。
  `POST /api/gps-tracks/start` / `POST /api/gps-tracks/:id/points`（座標点のbatch送信） /
  `POST /api/gps-tracks/:id/stop` / `GET /api/gps-tracks?from=&to=&user_id=`。
- 位置情報取得はブラウザの`watchPosition`に依存するため、**タブがフォアグラウンドでないと
  記録は継続できない**（意図的な制約。バックグラウンド対応はしていない）。記録中は
  `navigator.wakeLock`で画面ロックを防止し、タブが非表示になった場合は記録を自動停止する。
- 座標点はクライアント側で20秒間隔程度でバッファし、まとめてサーバーに送信する
  （`public/app.js`の`flushTrackBuffer`）。STOP時は残りを送信しきってから記録終了を確定する。
- 軌跡照会の閲覧権限: 一般ユーザーは自分の軌跡のみ、管理者は全ユーザー分（またはユーザーを
  選んで）閲覧できる（`worker/gps_tracks.ts`の`queryTracks`でサーバー側が強制する。フロントの
  ユーザー選択欄は管理者にのみ表示するだけで、権限の実体はサーバー側判定）。
- `gps_tracks.term_id`（`migrations/0010_gps_tracks_term_id.sql`）で記録開始時点の進行中タームに
  紐づく。クライアントの選択タームではなく`startTrack`がサーバー側で`status = '進行中'`のタームを
  判定して設定するため、進行中タームが無い状態で記録した場合は`NULL`のまま。タームが（新タームの
  開始で）完了扱いになっただけでは軌跡データは削除されないが、データクリア画面での明示的な
  ターム削除（`worker/reset.ts`の`deleteTerm`）では該当ターム分の軌跡データも削除される。
- 記録終了時刻（`ended_at`）が未確定のまま孤立したtrack（タブを閉じる等でSTOPされなかった場合）
  は、次回同ユーザーがSTARTした際に確定するが、その時刻は「次回start時刻」ではなく
  「そのtrackの最終`recorded_at`」を使う。軌跡照会は各trackの記録時間（`duration_seconds`、
  `ended_at`未確定時は同様に最終`recorded_at`にフォールバックして計算）を返し、フロントは
  選択期間の累計時間をモーダルに表示する（日付・対象ユーザー変更のたびに再計算）。この
  再計算では`GET /api/gps-tracks?...&summary=1`を使い、座標点（`points`）を含まない軽量な
  レスポンスを取得する。長期間・多人数分の座標点を毎回まるごと返すと1タームで数十万点規模に
  なり得るため（想定利用規模での試算では1タームあたり数十MB相当）、座標点が実際に必要な
  「表示」ボタン押下時（`summary`無し）とは経路を分けている。
- データの保持期間は無期限（自動削除の仕組みは無い。上記のデータクリア画面での明示的な
  ターム削除を除く。2026-08時点）。

## 行政区域データの追加・基本単位区単位への格上げ手順

大和市（`seed/areas_yamato.sql`）は以下の手順で追加した（2026-08に丁目単位から基本単位区単位へ
格上げ済み）。新しい市区町村を追加する場合も同じ手順で行える。**基本単位区データは町丁・字等と
異なり市区町村単位でしかダウンロードできない**（都道府県単位でまとめて配布されていないため、
対象市区町村ごとに1回ずつダウンロードが必要）。

1. **境界データのダウンロード**（API key・利用者登録不要。ダウンロードのみなら
   `ESTAT_APP_ID` は不要で、e-Statのページ操作をURLで代替しているだけ）:
   ```bash
   curl -L -o city14213.zip \
     "https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=B002005212020&code=14213&coordSys=1&format=shape&downloadType=5&datum=2011"
   # dlserveyId=B002005212020: 令和2年国勢調査 小地域(基本単位区)境界データ
   #   （町丁・字等は dlserveyId=A002005212020 で都道府県単位ダウンロードだったが、
   #     基本単位区はBから始まるIDで、市区町村単位でしかダウンロードできない）
   # code: 総務省「全国地方公共団体コード」の5桁市区町村コード（大和市=14213。
   #   政令指定都市は区ごとに別コード、例: 横浜市鶴見区=14101）
   unzip city14213.zip -d extracted   # r2kb14213.shp / .dbf / .shx / .prj が展開される
   ```
2. **GeoJSONへ変換**（`npx mapshaper` を使用。ビルド不要、都度npxで取得可能）:
   ```bash
   npx mapshaper -i extracted/r2kb14213.shp -o format=geojson city14213.geojson
   ```
3. **地域データへ整形**（基本単位区は市区町村単位ダウンロードのため、通常は対象市区町村分の
   フィーチャのみ。念のため`CITY_NAME`で取り違え検知は行う）。属性の対応:
   - `KEY_CODE`（桁数は区画により異なる）→ `area_id`（そのまま使える。e-Stat標準地域コード）
   - `S_NAME`（例: `中央林間一丁目`。町丁・字等と同じ形式）→ `town` + `chome` に分割
     （末尾の漢数字+`丁目`を算用数字に変換。政令指定都市（横浜市・川崎市・相模原市）は
     `CITY_NAME` が `川崎市多摩区` のように市区一体で入っているため `city`/`ward` に分割が
     必要。それ以外の市（大和市・平塚市等）は区を持たないため `ward` は空文字でよい）
   - 同一丁目内で基本単位区が複数に分かれる場合、`area_id`をソートした順に `block`
     （1, 2, 3...）を採番する。**e-Statの公式な区画番号ではなく本システム独自の表示用連番**
     （1区画のみの丁目は空欄のまま）。KIHON1〜3等のe-Stat内部コードは列によって桁の意味が
     一貫しないため、区画の一意な識別には使っていない。
   - `SETAI`（世帯数）→ `num_households`（国勢調査の実数。大和市の場合秘匿処理〈`X`等の
     非数値〉は確認されなかった。全区画で数値が入っている）
   - **注意**: 河川・鉄道等で分断された飛び地は同一 `KEY_CODE` で複数ポリゴンに分かれて
     いることがある（大和市では基本単位区レベルで0件だったが、他市区町村では起こりうる）。
     `area_id` はDB側でPRIMARY KEYのため、世帯数を合算し、ジオメトリはMultiPolygonとして
     1レコードにマージする必要がある。
   - `chome_area_id`（区画が属する「エリア」のID）→ `scripts/lib/estat-boundary.mjs`単体では
     暫定的に自分自身の`area_id`を設定する（1区画=1エリア扱い）。`npm run new-region`でエリア境界
     レイヤーを有効にした場合は、この直後に町丁・字等境界データ（後述）との空間結合で自動算出される。
4. **投入**: 整形したデータを `POST /api/areas/import` へPOST（本APIの仕様は下記参照）。
   併せて `regions/<地域ID>/areas.sql` としてSQLも保存しておくと、DBを作り直しても再現できる。
5. **境界GeoJSONの配置**: 抽出したfeatureを `public/data/regions/<地域ID>/boundary.geojson`
   として保存する（`npm run new-region`を使う場合は下記「複数地域の並行運用」の通り自動で
   行われるため、この手順は`scripts/lib/estat-boundary.mjs`を単体実行する場合のみ手動で行う）。

**「エリア」（chome_area_id・area_manager単位）境界データの取得（issue#12対応）**: 「エリア」は
町丁・字等単位の境界データ（`dlserveyId=A002005212020`、**都道府県単位ダウンロード**）から取得する。
基本単位区データとURL構築ロジックは共通で、`dlserveyId`とダウンロード単位（市区町村コード→
都道府県コード）だけが異なる:

```bash
curl -L -o pref14.zip \
  "https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=14&coordSys=1&format=shape&downloadType=5&datum=2011"
# dlserveyId=A002005212020: 令和2年国勢調査 町丁・字等境界データ（都道府県単位ダウンロード）
# code: 都道府県コード2桁（市区町村コードの先頭2桁と同じ。大和市=14213なので神奈川県=14）
unzip pref14.zip -d extracted   # r2ka14.shp 等が展開される（対象都道府県の全市区町村分を含む）
```

抽出・整形ロジック（`CITY_NAME`絞込み・丁目パース・世帯数合算等）は`extractMunicipality`と共通で、
出力プロパティのみ`boundary_chome.geojson`のスキーマ（`area_id`/`city`/`ward`/`town`/`chome`/
`num_households`、`block`列なし）に組み替える（`scripts/lib/estat-boundary.mjs`の
`extractChomeBoundary`/`fetchChomeBoundary`）。区画（基本単位区）とエリア（この境界データ）の
対応付けは`scripts/lib/geo.mjs`の`assignChomeAreaIds`（代表点による空間結合）で行う。

`npm run new-region`はこの一連の流れ（取得→空間結合→`chome_area_id`のUPDATE文生成）を自動で
行う（下記「複数地域の並行運用」参照）。単体で実行・再取得したい場合:

```bash
npm run fetch-boundary-data -- --region 202704-hiratsuka --city 平塚市 --cityCode 14206
# 政令指定都市の区の場合: --city 横浜市鶴見区 --cityCode 14101
# エリア境界（boundary_chome.geojson）だけ再取得したい場合は --chome-only を付ける
npm run fetch-boundary-data -- --region 202704-hiratsuka --city 平塚市 --cityCode 14206 --chome-only
```

`--cityCode` は総務省「全国地方公共団体コード」で確認できる5桁市区町村コード。
`regions/<地域ID>/areas.sql` と `boundary.geojson`（`--chome-only`時は`boundary_chome.geojson`）
が生成される（下記「複数地域の並行運用」参照）。

既にデプロイ済みの地域へ後からエリア機能を追加したい場合は`scripts/backfill-chome-area-id.mjs`
（大和市の`chome_area_id`もこれで算出した）を使う:

```bash
npm run backfill-chome-area-id -- --region 14213-yamato --city 大和市 --cityCode 14213
```

`regions/<地域ID>/areas.sql`（フレッシュDB向け）と`migrations/backfill_chome_area_id_<地域ID>.sql`
（既存DB向けのグループ化UPDATE文。出力後にmigrations/の連番規則に合わせて手動リネームすること）
が生成される。

## 複数地域の並行運用

大和市を含む全ての市区町村が、独立したCloudflare Worker・D1データベースを持つ「[named
environment](https://developers.cloudflare.com/workers/wrangler/environments/)」
（`wrangler.jsonc`の`env.<地域ID>`ブロック）として追加される。**「無名のデフォルト環境」は
存在しない**（`wrangler.jsonc`のトップレベルは`main`/`compatibility_date`/`assets`という
全env共通の土台のみを持ち、`d1_databases`を持たない。`--env`無しで`wrangler dev`/
`wrangler deploy`を実行するとDBバインディングが無く意図的に失敗する）。ロジック
（`worker/*.ts`・`public/app.js`等）は全地域で共通のまま。

**地域IDの命名規則**: 総務省「全国地方公共団体コード」5桁 + `-` + ローマ字市名（例:
`14213-yamato`、`14206-hiratsuka`）。先頭2桁が都道府県コードのため、地域IDを文字列ソート
すると都道府県単位でまとまる。

**地域固有の値は`wrangler.jsonc`の`env.<id>.vars`として持たせ、`/config.js`は
`worker/config.ts`の`buildConfigResponse()`が`env`から動的生成する**（表示名・地図初期座標・
ズーム・チョーム境界レイヤーの有無）。色・しきい値等の見た目パラメータは全地域共通として
`worker/config.ts`に一本化してある。境界GeoJSONも`public/data/regions/<地域ID>/boundary.geojson`
という地域ごとに固有のパスに恒久的に配置され、`public/config.js`のような「地域を切り替えたら
上書きする」可変ファイルは存在しない（誤って`git add -A`しても別地域の内容が混入する事故が
構造的に起こらない）。

### 対話スクリプトで新しい地域を追加する

```bash
npx wrangler login   # 初回のみ。Cloudflareアカウントへの認証が必要
npm run new-region
```

対話形式で以下を順に行う（`Ctrl+C`で中断しても、地域IDを指定して再実行すれば完了済みの
ステップはスキップして続きから再開できる）:

1. 地域ID（例: `14213-yamato`）・表示名・e-StatのCITY_NAME・5桁市区町村コードを入力
2. 境界データ・地域マスタの収集（e-Statから自動取得 or 手動で`regions/<id>/`に用意）し、
   `public/data/regions/<id>/boundary.geojson`へ恒久的に配置
3. 境界データのbboxから地図初期座標を自動算出（上書き可）
4. エリア境界（丁目単位の境界線・area_manager機能の単位）レイヤーをこの地域で有効にするか確認
   （既定は有効。e-Statの町丁・字等境界データから自動取得し、区画〈基本単位区〉との空間結合で
   `chome_area_id`を自動算出する。取得に失敗した場合は`regions/<id>/boundary_chome.geojson`の
   手動配置にフォールバックする）
5. 初期管理者ユーザーを1名だけ登録（以降の担当者追加はデプロイ後に`/users.html`のCSV
   インポートで行う）
6. D1データベースを新規作成し、`wrangler.jsonc`に`env.<id>`ブロック（`vars`込み）を追記
7. マイグレーション・地域マスタ・管理者ユーザーを新D1へ投入
8. `SESSION_SECRET`・`AREAS_IMPORT_TOKEN`を自動生成し`wrangler secret put`で設定
   （値は画面に表示されない）
9. **ここまでの入力内容を一覧表示し、「この内容でデプロイしてよいか」を確認**
10. 確認後`wrangler deploy --env <id>`を実行。`regions/<id>/polling_stations.csv`が
    用意されていれば、デプロイ直後に新規管理者アカウントでログインして
    `POST /api/polling-stations/import`へ自動投入する（測地系自動補正込みの既存ロジックを
    そのまま再利用するため、Node側でCSVを直接SQL化することはしない）。ファイルが無ければ
    投票所データは空のまま（初期値）で、後から`/polling-stations.html`で追加できる。

- 各地域の設定は `regions/<地域ID>/`（`meta.json`・`areas.sql`・任意で`polling_stations.csv`）
  にまとめて保存される。境界GeoJSONは`public/data/regions/<地域ID>/`配下。**合言葉などの秘密情報は
  どちらにも保存されない**（OS一時ディレクトリ経由でD1に投入・ログイン確認後、即メモリから
  破棄する設計）。
- スクリプト本体は `scripts/new-region.mjs`（オーケストレーション）、
  `scripts/lib/estat-boundary.mjs`（境界データ取得・整形。区画・エリア境界の両方）、
  `scripts/lib/geo.mjs`（区画↔エリアの空間結合）、
  `scripts/lib/wrangler-jsonc.mjs`（`wrangler.jsonc`への安全な追記）、
  `scripts/lib/geojson-bbox.mjs`（bbox中心計算）に分かれている。
- e-Statの自動取得には`www.e-stat.go.jp`へのネットワーク到達性が必要。到達できない環境
  （一部のサンドボックス等）では対話中に「手動で用意してください」と案内されるので、
  上記「行政区域データの追加・基本単位区単位への格上げ手順」に沿って別環境で用意したファイルを
  `regions/<id>/`に置いてから再開する。

## 既知の制約・今後の作業

- **`npm run new-region` は実際のCloudflare操作（D1作成・Secrets設定・deploy）を伴う箇所を
  実機（Cloudflare認証情報がある環境）で検証できていない**。境界データの変換ロジック
  （漢数字丁目のパース・複数ポリゴンのマージ・世帯数合算・空間結合）は`npm test`の単体テスト
  （`scripts/lib/*.test.mjs`）でカバーしているが、初めて新しい地域を追加する際は各ステップの
  出力（特に`wrangler d1 create`の`database_id`抽出）を確認しながら進めること。想定外のwrangler
  出力形式で`database_id`の自動抽出に失敗した場合は、出力を貼り付けて手動入力できるようにしてある。
- **エリア境界（chome）データの自動取得は、政令指定都市の区での動作が実データ未検証**。
  基本単位区データと同じ`CITY_NAME`規則（例:「横浜市鶴見区」）が町丁・字等境界データ側でも
  成立する前提でロジックを組んでいるが、実際に横浜市・川崎市・相模原市の区を追加する際は
  取得結果（`regions/<id>/boundary_chome.geojson`の件数・空間結合の警告件数）を確認すること。
  取得や空間結合に失敗しても`npm run new-region`自体は停止せず、手動配置へのフォールバック
  導線に落ちる。
- **現時点の対象地域は大和市のみ**（`env.14213-yamato`）: 横浜市の区単位プレースホルダデータは
  削除済み（世帯数が概算で正式なものではなかったため）。他市区町村を追加する場合は上記
  「複数地域の並行運用」の`npm run new-region`で、大和市と同様にe-Stat由来の基本単位区単位の
  正式データとして追加する。
- **世帯数0の地域がある**: 大和市3,094地域のうち172地域（例: `142130001301` 下鶴間一丁目1区画、
  `1421320031` 福田。商業地・工業地等と思われる）は世帯数が0。基本単位区は丁目よりさらに
  細かいため、丁目単位の頃（2地域）より件数・比率が増えている。配布率計算がゼロ除算になる
  問題があったため、これらの地域は担当者設定・配布記録の対象外とし（`POST /api/assignee` /
  `POST /api/record` をバックエンドで拒否）、地図上も常時グレーで固定表示している
  （`worker/records.ts`、`public/app.js` の `styleForArea`）。
- **e-Stat GIS APIの`ESTAT_APP_ID`は未取得**: 上記の境界データダウンロードは`ESTAT_APP_ID`
  無しで行えたため実質的な支障はないが、プログラムからの動的検索等でe-Stat GIS APIを
  正式に呼び出す場合は別途アプリケーションID登録が必要（登録はe-Stat利用者本人でないと
  行えないため未取得のまま）。
- 境界GeoJSON（大和市3,094地域で約2.0MB。丁目単位〈136地域・約350KB〉から件数・サイズとも
  大幅に増加）は簡易な地図表示には十分だが、対象自治体を増やすとデータ量が線形に増えるため、
  必要に応じてmapshaperの`-simplify`等での簡略化を検討する。
## 本番環境

各地域のデプロイ情報（Worker名・D1データベース名・URL）は`wrangler.jsonc`の`env.<地域ID>`
ブロックを参照。大和市は`env.14213-yamato`（Worker名`bm-map-posting-14213-yamato`、D1名
`bm-posting-db-14213-yamato`）。旧・無名のデフォルト環境（Worker`bm-map-posting`、D1
`bm-posting-db`）はこのリファクタリングに伴い廃止し、`npm run new-region`（地域ID:
`14213-yamato`）による再プロビジョニングに置き換えた（既存データはテスト運用段階だったため
引き継がず、管理者ユーザーも新規作成。詳細は上記「複数地域の並行運用」）。
`SESSION_SECRET` / `AREAS_IMPORT_TOKEN`は地域ごとに`wrangler secret put --env <id>`で
個別設定される（値はCloudflareダッシュボード側でのみ保持。再発行する場合は
`POST /api/areas/import`を使う外部スクリプト側の設定も合わせて更新すること）。

### 再デプロイ・DB更新の手順

```bash
npx wrangler d1 execute bm-posting-db-<地域ID> --env <地域ID> --remote --file=<マイグレーション/シードファイル>
npx wrangler deploy --env <地域ID>
```

### 基本単位区への切替え（2026-08、旧・無名のデフォルト環境で実施した過去の記録）

丁目単位から基本単位区単位への格上げは境界データの`area_id`が全面的に入れ替わるため、
既存の`terms`/`term_data`/`activity_log`（当時は全てダミーデータだったため実施）を
リセットした。同様の全面データ入れ替えが必要になった場合の手順:

```bash
# 事前バックアップ（万一のロールバック用）
npx wrangler d1 export bm-posting-db --remote --output=backup_before_block_level.sql

# 1. スキーマ変更（列追加。既存データに影響なし）
npx wrangler d1 execute bm-posting-db --remote --file=migrations/0002_areas_block_level.sql
# 2. 既存データの全削除（活動履歴・ターム・地域マスタ。usersは対象外）
npx wrangler d1 execute bm-posting-db --remote --file=migrations/0002b_reset_term_and_area_data.sql
# 3. 新しい地域マスタを投入
npx wrangler d1 execute bm-posting-db --remote --file=seed/areas_yamato.sql

npx wrangler deploy   # public/data/boundary.geojson を新データに合わせてデプロイ
```

コードデプロイとDB入れ替え（手順2・3）は同時に行うこと（`boundary.geojson`とD1の`areas`が
食い違う時間帯を作らないため）。`--local`環境で一連の手順をリハーサルしてから本番に適用する。

### chome_area_id列の追加・バックフィル（issue#12対応、2026-08、旧・無名のデフォルト環境で実施した過去の記録）

`areas.chome_area_id`列の追加は、`area_id`自体を変更しない列追加＋既存行のUPDATEのみのため、
上記「基本単位区への切替え」のような全データ削除は不要。

```bash
# 事前バックアップ（万一のロールバック用）
npx wrangler d1 export bm-posting-db --remote --output=backup_before_chome_area_id.sql

# 1. スキーマ変更（列追加。既存データに影響なし）
npx wrangler d1 execute bm-posting-db --remote --file=migrations/0004_chome_area_id.sql
# 2. 実値バックフィル（areas.chome_area_idのみ更新。term_data/activity_logは無関係）
npx wrangler d1 execute bm-posting-db --remote --file=migrations/0005_backfill_chome_area_id_yamato.sql

# 3. コードデプロイ（バックフィル完了後に実施すること）
npx wrangler deploy
```

**手順1・2完了後に手順3を行うこと。** コードを先にデプロイすると、バックフィル未実施の区画は
`chome_area_id=''`のままになり、空文字同士が全区画で1エリア扱いになる（issue#12と同種、
より深刻な）事故につながる。`--local`環境で一連の手順をリハーサルしてから本番に適用する。

デプロイ後、下鶴間・深見・福田・上和田・下和田で修正前に設定されていた「エリア担当」は、
旧グルーピング単位のまま新しく分かれた各エリアに同じ担当者名が残る（データは壊れないが、
実態としては分割後の複数エリアに同じ担当が入ったままになる）。管理者が該当5町のエリア担当設定を
目視確認し、必要に応じて個別に設定し直すこと。

### polling_stationsテーブルの追加（issue#13対応、2026-08、旧・無名のデフォルト環境で実施した過去の記録）

新規テーブルの追加のみ（既存テーブルへの変更・データ移行なし）のため、`chome_area_id`列の
追加時のような順序制約はない。

```bash
npx wrangler d1 execute bm-posting-db --remote --file=migrations/0006_polling_stations.sql
npx wrangler deploy
```

### 新規環境の初回構築手順

新規地域（大和市の再構築を含む）の初回構築は、上記「複数地域の並行運用」の
`npm run new-region`が一気通貫で行う（D1作成・マイグレーション適用・地域マスタ投入・
管理者ユーザー作成・Secrets設定・デプロイ・任意で投票所データ投入）。手動でのコマンド列挙は
不要になったため、個別手順はスクリプトの対話プロンプトを参照。
