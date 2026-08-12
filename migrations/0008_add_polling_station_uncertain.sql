-- 直近のインポート時点で、住所とCSV座標の整合性をジオコーディングで確認できなかった行に1が立つ
-- （scripts/upload-polling-stations.mjsが算出する。Web直接アップロードでは判定を行わない）。
ALTER TABLE polling_stations ADD COLUMN location_uncertain INTEGER NOT NULL DEFAULT 0;
