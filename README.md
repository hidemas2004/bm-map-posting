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
- 境界データは `public/data/boundary.geojson`。現状は大和市3,094地域（基本単位区単位、
  約2.0MB）のみを収録。e-Stat（令和2年国勢調査 小地域(基本単位区)境界データ）由来の正式データで、
  `area_id` はe-Stat標準地域コード（KEY_CODE。桁数は区画により異なる）、世帯数も概算ではなく
  国勢調査の実数。基本単位区は丁目よりさらに細かい街区相当の区画（大和市の場合1区画平均約38世帯）
  で、同一丁目内に複数ある場合は区別用に`block`列（本システム独自の表示用連番。詳細は下記
  「行政区域データの追加・基本単位区単位への格上げ手順」参照）を付与している。他市区町村を
  追加する場合は同手順を参照。基本単位区単位への格上げ前は丁目単位（136地域）だったため、
  どの丁目に属するかが見た目でも分かるよう、旧丁目境界を`public/data/boundary_chome.geojson`
  として保持し、地図上に表示専用（太め・紺色・クリック不可）の補助レイヤーとして重ね描きしている
  （`public/config.js`の`CHOME_BOUNDARY_*`定数、`app.js`の`loadChomeBoundary()`）。
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

```bash
npm install
npx wrangler dev      # ローカル確認。.dev.vars.example を参考に .dev.vars を作成しておく
npx wrangler deploy   # 本番デプロイ（要 Cloudflare 認証・D1本番データベース作成）
```

### ローカルD1の初期化

```bash
npx wrangler d1 execute bm-posting-db --local --file=migrations/0001_init.sql
npx wrangler d1 execute bm-posting-db --local --file=migrations/0002_areas_block_level.sql
npx wrangler d1 execute bm-posting-db --local --file=migrations/0003_area_manager.sql
npx wrangler d1 execute bm-posting-db --local --file=migrations/0004_chome_area_id.sql
npx wrangler d1 execute bm-posting-db --local --file=seed/areas_yamato.sql
npx wrangler d1 execute bm-posting-db --local --file=seed/users.sql
```

`seed/areas_yamato.sql`は`chome_area_id`列を含む形で生成済みのため、上記の順序（0004適用後に投入）
であれば`migrations/0005_backfill_chome_area_id_yamato.sql`は不要（新規まっさらなDBのみを対象とする
場合）。**既にデータが入っている既存DB**（本番等）に`chome_area_id`を反映する場合は、`seed/areas_yamato.sql`
を再投入せず、0004適用後に`migrations/0005_backfill_chome_area_id_yamato.sql`を実行すること
（`area_id`等は変更せず`chome_area_id`列のみを更新するUPDATE文のため、`area_manager_id`等の
既存運用データを壊さない）。

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
   - `chome_area_id`（区画が属する「エリア」のID）→ 本スクリプトは基本単位区データしか
     取得しないため、暫定的に自分自身の`area_id`を設定する（1区画=1エリア扱い）。
4. **投入**: 整形したデータを `POST /api/areas/import` へPOST（本APIの仕様は下記参照）。
   併せて `seed/areas_<市区町村名>.sql` としてSQLも保存しておくと、DBを作り直しても
   再現できる。
5. **境界GeoJSONへのマージ**: 抽出したfeatureを `public/data/boundary.geojson` の
   `features` 配列に追記する（`area_id` の重複がないことを確認）。

**今後の課題（issue#12関連）**: 上記手順では`chome_area_id`が暫定的に自分自身の`area_id`に
なる（1区画=1エリア扱い）ため、大和市のように「エリア」を町丁・字等単位でまとめる運用はできない。
大和市の`boundary_chome.geojson`は格上げ前データの遺物として例外的に存在するだけで、他市区町村を
追加する現行フローには町丁・字等境界データ（`dlserveyId=A002005212020`、都道府県単位ダウンロード）
の取得手順が無い。同じ「エリア」概念を他市区町村でも使う場合は、この取得手順と
`scripts/lib/geo.mjs`（空間結合）を`scripts/lib/estat-boundary.mjs`/`new-region.mjs`に
組み込む対応が別途必要（大和市データの`chome_area_id`算出は`scripts/backfill-chome-area-id.mjs`
参照）。

上記1〜3は `scripts/lib/estat-boundary.mjs` としてスクリプト化済み。単体実行する場合は

```bash
npm run fetch-boundary-data -- --region 202704-hiratsuka --city 平塚市 --cityCode 14206
# 政令指定都市の区の場合: --city 横浜市鶴見区 --cityCode 14101
```

`--cityCode` は総務省「全国地方公共団体コード」で確認できる5桁市区町村コード。
`regions/<地域ID>/areas.sql` と `boundary.geojson` が生成される（下記「複数地域の並行運用」参照）。

## 複数地域の並行運用

大和市とは別に、平塚市・藤沢市など複数の市区町村を**並行して**稼働させる場合、地域ごとに
独立したCloudflare Worker・D1データベースを持つ「[named environment]
(https://developers.cloudflare.com/workers/wrangler/environments/)」として追加する。
`wrangler.jsonc` のトップレベル（大和市の本番設定）は変更せず、`env.<地域ID>` ブロックとして
追記される。ロジック（`worker/*.ts`・`public/app.js`等）は全地域で共通のまま。

### 対話スクリプトで新しい地域を追加する

```bash
npx wrangler login   # 初回のみ。Cloudflareアカウントへの認証が必要
npm run new-region
```

対話形式で以下を順に行う（`Ctrl+C`で中断しても、地域IDを指定して再実行すれば完了済みの
ステップはスキップして続きから再開できる）:

1. 地域ID（例: `202704-hiratsuka`）・表示名・e-StatのCITY_NAME・5桁市区町村コードを入力
2. 境界データ・地域マスタの収集（e-Statから自動取得 or 手動で`regions/<id>/`に用意）
3. 境界データのbboxから地図初期座標を自動算出（上書き可）・`regions/<id>/config.js`を生成
4. 初期管理者ユーザーを1名だけ登録（以降の担当者追加はデプロイ後に`/users.html`のCSV
   インポートで行う）
5. D1データベースを新規作成し、`wrangler.jsonc`に`env.<id>`ブロックを追記
6. マイグレーション・地域マスタ・管理者ユーザーを新D1へ投入
7. `SESSION_SECRET`・`AREAS_IMPORT_TOKEN`を自動生成し`wrangler secret put`で設定
   （値は画面に表示されない）
8. **ここまでの入力内容を一覧表示し、「この内容でデプロイしてよいか」を確認**
9. 確認後、`public/config.js`・`public/data/boundary.geojson`を該当地域の内容に切り替えて
   `wrangler deploy --env <id>`を実行

- 各地域の設定は `regions/<地域ID>/`（`meta.json`・`config.js`・`boundary.geojson`・
  `areas.sql`）にまとめて保存される。**合言葉などの秘密情報はここには保存されない**
  （OS一時ディレクトリ経由でD1に投入後、即削除する設計）。
- デプロイ後、ローカルの`public/`には直前にデプロイした地域の内容が残る（`npm run dev`で
  ローカル確認する際はどの地域を見ているか注意。別地域を扱う際は改めてこのスクリプトを
  実行すれば自動的に切り替わる）。
- スクリプト本体は `scripts/new-region.mjs`（オーケストレーション）、
  `scripts/lib/estat-boundary.mjs`（境界データ取得・整形）、
  `scripts/lib/wrangler-jsonc.mjs`（`wrangler.jsonc`への安全な追記）、
  `scripts/lib/config-template.mjs`（`config.js`生成・bbox中心計算）に分かれている。
- e-Statの自動取得には`www.e-stat.go.jp`へのネットワーク到達性が必要。到達できない環境
  （一部のサンドボックス等）では対話中に「手動で用意してください」と案内されるので、
  上記「行政区域データの追加・基本単位区単位への格上げ手順」に沿って別環境で用意したファイルを
  `regions/<id>/`に置いてから再開する。

## 既知の制約・今後の作業

- **`npm run new-region` は実際のCloudflare操作（D1作成・Secrets設定・deploy）を伴う箇所を
  実機（Cloudflare認証情報がある環境）で検証できていない**。境界データの変換ロジック
  （漢数字丁目のパース・複数ポリゴンのマージ・世帯数合算）と`wrangler.jsonc`への追記処理は
  単体テスト済みだが、初めて新しい地域を追加する際は各ステップの出力（特に`wrangler d1 create`
  の`database_id`抽出）を確認しながら進めること。想定外のwrangler出力形式で`database_id`の
  自動抽出に失敗した場合は、出力を貼り付けて手動入力できるようにしてある。
- **対象地域は大和市のみ**: 横浜市の区単位プレースホルダデータは削除済み（世帯数が概算で
  正式なものではなかったため）。他市区町村を追加する場合は上記「行政区域データの追加・
  基本単位区単位への格上げ手順」に沿って、大和市と同様にe-Stat由来の基本単位区単位の
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
- **本番の合言葉が初期シードのまま**: 2026-08-05時点、本番D1には`seed/users.sql`のテスト用
  合言葉（`admin-pass`等）がそのまま入っている。ユーザー管理画面（`/users.html`、管理者限定）
  から早めに変更すること。

## 本番環境

- URL: `https://bm-map-posting.blackdog-yokohama-japan.workers.dev`（2026-08-05にデプロイ済み）
- D1データベース: `bm-posting-db`（`wrangler.jsonc`の`database_id`参照）
- `SESSION_SECRET` / `AREAS_IMPORT_TOKEN` は`wrangler secret put`で設定済み
  （値はCloudflareダッシュボード側でのみ保持。再発行する場合は`POST /api/areas/import`を
  使う外部スクリプト側の設定も合わせて更新すること）

### 再デプロイ・DB更新の手順

```bash
npx wrangler d1 execute bm-posting-db --remote --file=<マイグレーション/シードファイル>
npx wrangler deploy
```

### 基本単位区への切替え（2026-08、参考: 同様の全面データ入れ替えを再度行う場合の手順）

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

### chome_area_id列の追加・バックフィル（issue#12対応、2026-08）

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

### 初回構築時の手順（参考。再構築が必要になった場合用）

1. `npx wrangler login` でCloudflareアカウントに認証する
2. `npx wrangler d1 create bm-posting-db` で本番D1データベースを作成し、`wrangler.jsonc` の
   `database_id` を実際のIDに置き換える
3. 本番D1へマイグレーション・シードを適用する
   （`npx wrangler d1 execute bm-posting-db --remote --file=migrations/0001_init.sql`、
   `migrations/0002_areas_block_level.sql`、`migrations/0003_area_manager.sql`、
   `migrations/0004_chome_area_id.sql`、`seed/areas_yamato.sql`、`seed/users.sql` の順に
   `--remote` フラグを付けて適用。`seed/areas_yamato.sql`は`chome_area_id`列を含む形で生成済み
   のため`migrations/0005_...`は不要）
4. `wrangler secret put SESSION_SECRET` / `wrangler secret put AREAS_IMPORT_TOKEN` を設定する
5. `npx wrangler deploy` で本番デプロイする
6. ユーザー管理画面（`/users.html`）から`seed/users.sql`のテスト用合言葉を変更する
