-- ポスティング管理システム 初期スキーマ

CREATE TABLE areas (
  area_id      TEXT PRIMARY KEY,   -- e-Stat 標準地域コード（11桁）
  city         TEXT NOT NULL,       -- 例: 横浜市
  ward         TEXT NOT NULL,       -- 例: 鶴見区
  town         TEXT DEFAULT '',     -- 例: 鶴見中央（空可）
  chome        TEXT DEFAULT '',     -- 例: 1（空可）
  num_households INTEGER NOT NULL  -- 世帯数（配布率の分母）
);

CREATE TABLE terms (
  term_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  term_name    TEXT NOT NULL,       -- 例: 2025秋_第1タームA
  start_date   TEXT NOT NULL,       -- ISO日付。作成時に自動設定
  end_date     TEXT,                -- 完了時に自動設定。進行中はNULL
  status       TEXT NOT NULL DEFAULT '進行中',  -- '進行中' | '完了'
  memo         TEXT DEFAULT ''
);

CREATE TABLE term_data (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id            INTEGER NOT NULL REFERENCES terms(term_id),
  area_id            TEXT NOT NULL REFERENCES areas(area_id),
  assignee_id        TEXT REFERENCES users(user_id),  -- NULL=未担当（塗りつぶしなし）
  assignee_name      TEXT DEFAULT '',                  -- users から複製（表示高速化用）
  distributed_total  INTEGER NOT NULL DEFAULT 0,        -- 当ターム累計配布枚数
  distribution_rate  REAL NOT NULL DEFAULT 0,           -- distributed_total/num_households*100
  last_updated_at    TEXT,                              -- 当ターム内の最終入力日時。NULL可
  UNIQUE(term_id, area_id)
);
CREATE INDEX idx_term_data_term ON term_data(term_id);

CREATE TABLE activity_log (
  log_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id      INTEGER NOT NULL REFERENCES terms(term_id),
  area_id      TEXT NOT NULL REFERENCES areas(area_id),
  updated_at   TEXT NOT NULL,        -- ISO日時。自動記録
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  user_name    TEXT NOT NULL,        -- users から複製（スナップショット）
  delta        INTEGER NOT NULL      -- 正数=加算、負数=減算
);
CREATE INDEX idx_activity_log_term_area ON activity_log(term_id, area_id);

CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,     -- 例: yamada
  name         TEXT NOT NULL,        -- 表示名。例: 山田太郎
  passphrase   TEXT NOT NULL,        -- 合言葉（平文）
  role         TEXT NOT NULL DEFAULT '一般',  -- '管理者' | '一般'
  active       INTEGER NOT NULL DEFAULT 1     -- 0=ログイン不可
);
