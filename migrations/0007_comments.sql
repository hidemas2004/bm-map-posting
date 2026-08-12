-- issue#24対応: 地図上の任意地点に記入するコメント（ポスト禁止・ポスター候補・その他）を
-- 管理するテーブル。投票所(polling_stations)と同様、term/areaに紐付かない独立データとして
-- 全ターム共通で表示・編集する。
CREATE TABLE comments (
  comment_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  category            TEXT NOT NULL CHECK (category IN ('no_posting', 'poster_candidate', 'other')),
  pin_color           TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  created_by_id       TEXT NOT NULL,
  created_by_name     TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_by_id       TEXT NOT NULL,
  updated_by_name     TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
