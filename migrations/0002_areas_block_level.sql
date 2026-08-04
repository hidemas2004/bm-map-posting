-- 境界データの粒度を「町丁・字等(丁目)」から「基本単位区」に格上げするためのスキーマ変更。
-- 基本単位区は同一丁目内で複数に分かれることがあるため、区別用の通し番号を持つ列を追加する
-- （区画番号はe-Statの公式なものではなく、scripts/lib/estat-boundary.mjsが採番する表示用連番）。
ALTER TABLE areas ADD COLUMN block TEXT DEFAULT '';
