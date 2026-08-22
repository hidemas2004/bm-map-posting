-- GPS移動軌跡の記録・照会機能。track（記録セッション）とpoint（座標点）を分割する。
-- pointは大量行になり得るため（数十秒間隔×数時間の記録で数百〜千行/track）、
-- track一覧・期間絞り込みをpoint込みでGROUP BYせず軽量に扱えるようにする。
-- comments/polling_stationsと同様、term/areaに紐付かない独立データとして全ターム共通で扱う。
CREATE TABLE gps_tracks (
  track_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL,
  user_name      TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  point_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_gps_tracks_user_started ON gps_tracks (user_id, started_at);

CREATE TABLE gps_track_points (
  point_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL REFERENCES gps_tracks(track_id),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  accuracy    REAL
);

CREATE INDEX idx_gps_track_points_track ON gps_track_points (track_id, recorded_at);
