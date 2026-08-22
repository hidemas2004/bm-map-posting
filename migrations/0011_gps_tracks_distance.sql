-- 軌跡照会での「移動距離」表示用。座標点受信のたびにHaversine距離を積算して保存する
-- （queryTracksのsummary=1モードが座標点そのものを取得しない軽量パスのため、都度計算ではなく
-- point_countと同様にインクリメンタルに更新する設計にする。worker/gps_tracks.ts参照）。
ALTER TABLE gps_tracks ADD COLUMN distance_meters REAL NOT NULL DEFAULT 0;
