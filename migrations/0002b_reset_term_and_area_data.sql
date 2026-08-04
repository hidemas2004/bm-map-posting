-- 境界データを丁目単位から基本単位区単位に切り替えるための全面データ入れ替え。
-- 既存のterms/term_data/activity_log/areasは全てダミーデータであることを確認済みのため、
-- 過去タームとの互換性は考慮せず削除する（usersテーブルは対象外）。
-- 外部キー依存順（子→親）で削除する。
DELETE FROM activity_log;
DELETE FROM term_data;
DELETE FROM terms;
DELETE FROM areas;
