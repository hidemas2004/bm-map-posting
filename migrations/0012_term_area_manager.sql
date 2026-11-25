-- エリア担当をターム単位の情報に変更する。
-- 従来は areas.area_manager_id/area_manager_name（マスタ側・全ターム共通）に1つだけ保持していたが、
-- 区画担当（term_data.assignee_*）と同じくタームごとの計画情報として term_data 側に持たせる。
-- assignee_* と同様に区画行ごとに複製する（同一ターム・同一エリア(chome_area_id)内の全区画に同じ値）。
--
-- 既存データは、移行時点の areas の値を全ターム（完了タームを含む）へコピーする。
-- areas.area_manager_* 列は以後参照・更新しない（外部キー制約付きの列はSQLiteでDROP COLUMNできないため残置）。
--
-- 適用順の注意: この列を読むコードをデプロイする前に、必ず本マイグレーションを適用すること。
ALTER TABLE term_data ADD COLUMN area_manager_id TEXT REFERENCES users(user_id);
ALTER TABLE term_data ADD COLUMN area_manager_name TEXT DEFAULT '';
UPDATE term_data SET
  area_manager_id   = (SELECT area_manager_id FROM areas WHERE areas.area_id = term_data.area_id),
  area_manager_name = COALESCE((SELECT area_manager_name FROM areas WHERE areas.area_id = term_data.area_id), '');
