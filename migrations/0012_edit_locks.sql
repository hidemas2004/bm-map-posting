-- 区画編集の排他制御用ロックテーブル。区画(area_id)単位で1行のみ存在し、
-- expires_atを過ぎた行は失効扱い（誰でも上書き取得できる）。TTL失効による自然回復のため
-- 明示的な解放漏れがあっても永久にロックされたままにはならない設計。
CREATE TABLE edit_locks (
  area_id TEXT PRIMARY KEY REFERENCES areas(area_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  user_name TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
