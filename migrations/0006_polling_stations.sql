-- issue#13対応: 投票所の位置をCSVアップロードで管理し、地図上にピン表示するためのテーブル。
-- areas/users のような自然キーがCSV側に存在しないため、アップロードのたびに全件洗い替え
-- （DELETE→INSERT）で更新する運用とする（worker/polling_stations.ts の importPollingStations）。
CREATE TABLE polling_stations (
  station_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  lat         REAL NOT NULL,
  lng         REAL NOT NULL
);
