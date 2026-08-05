-- 「エリア担当」列を追加する。エリア担当が設定されているエリア(town+chome単位)を
-- 「予定配布エリア」とみなす（独立した配布対象フラグは持たない）。
-- area_manager_id/area_manager_name は同一エリア内の全区画に同じ値が複製される。
ALTER TABLE areas ADD COLUMN area_manager_id TEXT REFERENCES users(user_id);
ALTER TABLE areas ADD COLUMN area_manager_name TEXT DEFAULT '';
