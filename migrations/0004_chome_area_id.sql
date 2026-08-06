-- issue#12対応: town+chomeの文字列一致では、e-Statが同一町名を複数のKEY_CODEに分割した
-- ケース（丁目のない大字等）を区別できず、地図上は別々の境界線（boundary_chome.geojsonの
-- 別フィーチャ）を持つエリアが1つの巨大なエリアとして誤認識される問題があった（下鶴間・
-- 深見・福田・上和田・下和田で確認）。boundary_chome.geojsonの各フィーチャが持つarea_id
-- （e-Stat KEY_CODE）をそのまま転用し、区画がどのチョーム境界ポリゴンに空間的に含まれるかで
-- 「エリア」を識別する。
-- 既存データへの実値投入は migrations/0005_backfill_chome_area_id_yamato.sql で行う
-- （area_id自体は変更しないため term_data/activity_log には影響しない）。
ALTER TABLE areas ADD COLUMN chome_area_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_areas_chome_area_id ON areas(chome_area_id);
