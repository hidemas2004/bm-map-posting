import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokyoDatumToWgs84, haversineDistanceMeters } from './geodetic.ts';

test('haversineDistanceMeters: 同一点は0', () => {
	const p = { lat: 35.4717, lng: 139.4549 };
	assert.equal(haversineDistanceMeters(p, p), 0);
});

test('haversineDistanceMeters: 既知の距離（赤道上経度1度 ≈ 111.19km）', () => {
	const d = haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
	assert.ok(Math.abs(d - 111195) < 100, `expected ~111195m, got ${d}`);
});

test('tokyoDatumToWgs84: 大和市付近でissue報告の平均ズレ量(約460m)・北西方向と整合する', () => {
	// issue#16: 27件の不一致は南東方向(方位角110-166°)に約200-680m(平均約460m)のズレ。
	// つまり生座標(Tokyo Datum)は正しい位置(WGS84)から見て南東側にあり、
	// Tokyo Datum→WGS84変換は北西方向にシフトするはず。
	const raw = { lat: 35.4717, lng: 139.4549 };
	const converted = tokyoDatumToWgs84(raw);

	const shiftLat = converted.lat - raw.lat;
	const shiftLng = converted.lng - raw.lng;
	assert.ok(shiftLat > 0, '緯度は北方向(プラス)にシフトするはず');
	assert.ok(shiftLng < 0, '経度は西方向(マイナス)にシフトするはず');

	const dist = haversineDistanceMeters(raw, converted);
	assert.ok(dist > 400 && dist < 520, `expected ~460m shift, got ${dist}`);
});
