-- 藤沢市（14205-fujisawa）専用。同じ名前のエリアを、番号付きの名前で区別できるようにする（issue#42）。
--
-- 丁目のない大字（大庭・遠藤など）では、e-Statが1つの大字を複数のKEY_CODE（エリア）に分けているのに、
-- 名前（S_NAME）には大字名しか入っていないため、ポップアップ・地域マスタ・履歴・CSVで区別できなかった。
-- 同じ地域内で town+chome が同じエリアのすべてについて、そのエリアに属する全区画の areas.town を
-- `大字名（chome_area_idの末尾3桁）` に変える。番号はe-Statの字・丁目コードで、地名としての意味はない。
-- 規則は scripts/lib/estat-boundary.mjs の disambiguateDuplicateTownNames、本文は
-- scripts/disambiguate-town-names.mjs --region 14205-fujisawa --apply の出力を転記したもの。
--
-- 変更するのは areas.town だけ。area_id・chome_area_id・chome・term_data・activity_log は変更しない
-- （term_data を触らないので rev の更新も不要。履歴・CSVは areas.town をその都度参照するため自動で反映される）。
-- 他の地域のDBに適用しても chome_area_id が一致しないため何も変わらないが、適用の必要はない。
-- 新しい地域は npm run new-region が生成する chome_area_id.sql に同じ更新が含まれるため不要。
-- 境界データ（boundary_chome.geojson）側の名前は同じコミットで変更済み（デプロイで反映）。
--
-- 適用前後の確認（同じ結果になること）:
--   SELECT COUNT(*), SUM(rev), SUM(distributed_total) FROM term_data;
--   SELECT COUNT(*) FROM areas WHERE town IN ('大庭', '遠藤', '亀井野', '長後', '高谷') AND chome = '';
--     → 適用前 731、適用後 0
UPDATE areas SET town = '高谷（000）' WHERE chome_area_id = '14205206000';
UPDATE areas SET town = '高谷（001）' WHERE chome_area_id = '14205206001';
UPDATE areas SET town = '大庭（001）' WHERE chome_area_id = '14205410001';
UPDATE areas SET town = '大庭（002）' WHERE chome_area_id = '14205410002';
UPDATE areas SET town = '大庭（003）' WHERE chome_area_id = '14205410003';
UPDATE areas SET town = '大庭（004）' WHERE chome_area_id = '14205410004';
UPDATE areas SET town = '大庭（005）' WHERE chome_area_id = '14205410005';
UPDATE areas SET town = '大庭（006）' WHERE chome_area_id = '14205410006';
UPDATE areas SET town = '亀井野（010）' WHERE chome_area_id = '14205601010';
UPDATE areas SET town = '亀井野（011）' WHERE chome_area_id = '14205601011';
UPDATE areas SET town = '亀井野（012）' WHERE chome_area_id = '14205601012';
UPDATE areas SET town = '長後（000）' WHERE chome_area_id = '14205801000';
UPDATE areas SET town = '長後（001）' WHERE chome_area_id = '14205801001';
UPDATE areas SET town = '遠藤（001）' WHERE chome_area_id = '14205907001';
UPDATE areas SET town = '遠藤（002）' WHERE chome_area_id = '14205907002';
UPDATE areas SET town = '遠藤（003）' WHERE chome_area_id = '14205907003';
UPDATE areas SET town = '遠藤（004）' WHERE chome_area_id = '14205907004';
