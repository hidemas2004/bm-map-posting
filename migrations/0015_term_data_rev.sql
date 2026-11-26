-- 区画データ（term_data）に「変更番号」と「最終更新者」を持たせる。
--   rev:             同じターム内で一意に増える変更番号。担当・エリア担当・実績を更新するたびに
--                    「そのタームの最大値＋1」を付ける（エリア担当の一括更新では対象区画すべてに同じ番号）。
--                    用途は2つ:
--                      1) 画面同期: 画面は受け取った最大の rev を覚えておき、区画を開くときなどに
--                         「それより新しい行」だけを取得して反映する（GET /api/term-data/changes）。
--                      2) 楽観的排他制御: 保存時に画面が持っている rev を送り、サーバー側で一致する
--                         場合だけ更新する。一致しなければ「他の人が先に更新した」として 409 を返す。
--   updated_by_name: 最後に担当・エリア担当・実績を変更した人の名前（競合時の表示用）。
-- 既存行は rev=0 で始まる（全件取得時に受け取るので同期上の問題はない）。
--
-- 番号について: 0013_edit_locks.sql・0014_edit_locks_client_id.sql は本番の全地域（0014は藤沢のみ）に
-- 適用されたあと、編集ロック機能ごと取り消された（ファイルはリポジトリに無い）。番号の重複を避けるため
-- 本マイグレーションは 0015 とする。edit_locks テーブルは現在のコードからは参照されない。
--
-- 適用順の注意: この列を読むコードをデプロイする前に、必ず本マイグレーションを適用すること。
ALTER TABLE term_data ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE term_data ADD COLUMN updated_by_name TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_term_data_term_rev ON term_data (term_id, rev);
