-- 初期動作確認用シード：ユーザーマスタ（管理者1名＋一般3名）
-- 合言葉は動作確認用の平文サンプル。本運用前に必ず変更すること。
INSERT INTO users (user_id, name, passphrase, role, active) VALUES
  ('admin', '管理者', 'admin-pass', '管理者', 1),
  ('yamada', '山田太郎', 'yamada-pass', '一般', 1),
  ('suzuki', '鈴木花子', 'suzuki-pass', '一般', 1),
  ('sato', '佐藤次郎', 'sato-pass', '一般', 1);
