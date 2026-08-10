import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTownChome, splitCityWard, extractMunicipality, extractChomeBoundary, buildChomeAreaIdUpdateSql } from './estat-boundary.mjs';

function square(x0, y0, x1, y1) {
	return {
		type: 'Polygon',
		coordinates: [
			[
				[x0, y0],
				[x1, y0],
				[x1, y1],
				[x0, y1],
				[x0, y0],
			],
		],
	};
}

function feature({ cityName, keyCode, sName, setai, geometry }) {
	return {
		type: 'Feature',
		properties: { CITY_NAME: cityName, KEY_CODE: keyCode, S_NAME: sName, SETAI: setai },
		geometry: geometry ?? square(0, 0, 1, 1),
	};
}

test('parseTownChome: 漢数字丁目を分解する', () => {
	assert.deepEqual(parseTownChome('中央林間一丁目'), { town: '中央林間', chome: '1' });
	assert.deepEqual(parseTownChome('中央林間二十丁目'), { town: '中央林間', chome: '20' });
});

test('parseTownChome: 丁目が無い地名はそのままtownに入る', () => {
	assert.deepEqual(parseTownChome('つきみ野'), { town: 'つきみ野', chome: '' });
});

test('parseTownChome: 解析できない丁目表記はwarning付きでchome空欄', () => {
	const result = parseTownChome('本町五五丁目');
	assert.equal(result.town, '本町五五丁目');
	assert.equal(result.chome, '');
	assert.equal(result.warning, true);
});

test('splitCityWard: 政令指定都市は区で分割する', () => {
	assert.deepEqual(splitCityWard('横浜市鶴見区'), { city: '横浜市', ward: '鶴見区' });
});

test('splitCityWard: 通常の市はwardが空文字', () => {
	assert.deepEqual(splitCityWard('大和市'), { city: '大和市', ward: '' });
});

test('extractMunicipality: 基本ケースでarea_id/town/chome/num_householdsを整形する', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [
			feature({ cityName: '大和市', keyCode: '14213001001', sName: '中央林間一丁目', setai: '10', geometry: square(0, 0, 1, 1) }),
			feature({ cityName: '大和市', keyCode: '14213001002', sName: '中央林間二丁目', setai: '20', geometry: square(1, 0, 2, 1) }),
		],
	};
	const { areas, geojson, warnings } = extractMunicipality(fc, '大和市');
	assert.equal(areas.length, 2);
	assert.equal(areas[0].area_id, '14213001001');
	assert.equal(areas[0].town, '中央林間');
	assert.equal(areas[0].chome, '1');
	assert.equal(areas[0].num_households, 10);
	// chome_area_idは暫定的に自分自身
	assert.equal(areas[0].chome_area_id, '14213001001');
	assert.equal(geojson.features.length, 2);
	assert.equal(warnings.length, 0);
});

test('extractMunicipality: CITY_NAME不一致は0件でエラー', () => {
	const fc = { type: 'FeatureCollection', features: [feature({ cityName: '大和市', keyCode: '1', sName: 'X', setai: '1' })] };
	assert.throws(() => extractMunicipality(fc, '平塚市'), /CITY_NAME="平塚市"/);
});

test('extractMunicipality: 他市区町村の混在は警告になる', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [
			feature({ cityName: '大和市', keyCode: '1', sName: 'X一丁目', setai: '1' }),
			feature({ cityName: '座間市', keyCode: '2', sName: 'Y一丁目', setai: '1' }),
		],
	};
	const { warnings } = extractMunicipality(fc, '大和市');
	assert.ok(warnings.some((w) => w.includes('混在')));
});

test('extractMunicipality: 同一KEY_CODEの複数ポリゴンはMultiPolygonに統合し世帯数を合算', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [
			feature({ cityName: '大和市', keyCode: '1', sName: 'X一丁目', setai: '3', geometry: square(0, 0, 1, 1) }),
			feature({ cityName: '大和市', keyCode: '1', sName: 'X一丁目', setai: '4', geometry: square(2, 0, 3, 1) }),
		],
	};
	const { areas, geojson, warnings } = extractMunicipality(fc, '大和市');
	assert.equal(areas.length, 1);
	assert.equal(areas[0].num_households, 7);
	assert.equal(geojson.features[0].geometry.type, 'MultiPolygon');
	assert.equal(geojson.features[0].geometry.coordinates.length, 2);
	assert.ok(warnings.some((w) => w.includes('MultiPolygon')));
});

test('extractMunicipality: 世帯数0は警告になる', () => {
	const fc = { type: 'FeatureCollection', features: [feature({ cityName: '大和市', keyCode: '1', sName: 'X一丁目', setai: '0' })] };
	const { warnings } = extractMunicipality(fc, '大和市');
	assert.ok(warnings.some((w) => w.includes('世帯数が0')));
});

test('extractMunicipality: 同一丁目内に複数区画があればblockを採番する', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [
			feature({ cityName: '大和市', keyCode: '14213001001', sName: 'X一丁目', setai: '1', geometry: square(0, 0, 1, 1) }),
			feature({ cityName: '大和市', keyCode: '14213001002', sName: 'X一丁目', setai: '1', geometry: square(1, 0, 2, 1) }),
		],
	};
	const { areas } = extractMunicipality(fc, '大和市');
	assert.equal(areas[0].block, '1');
	assert.equal(areas[1].block, '2');
});

test('extractChomeBoundary: block列を持たずnum_householdsを持つスキーマを返す', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [
			feature({ cityName: '大和市', keyCode: '14213001', sName: '中央林間一丁目', setai: '1408', geometry: square(0, 0, 1, 1) }),
		],
	};
	const { geojson, warnings } = extractChomeBoundary(fc, '大和市');
	assert.equal(geojson.features.length, 1);
	const props = geojson.features[0].properties;
	assert.equal(props.area_id, '14213001');
	assert.equal(props.num_households, 1408);
	assert.equal('block' in props, false);
	assert.equal(warnings.length, 0);
});

test('extractChomeBoundary: 政令指定都市の区はcity/wardに分割される', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [feature({ cityName: '横浜市鶴見区', keyCode: '1', sName: 'X一丁目', setai: '1' })],
	};
	const { geojson } = extractChomeBoundary(fc, '横浜市鶴見区');
	assert.equal(geojson.features[0].properties.city, '横浜市');
	assert.equal(geojson.features[0].properties.ward, '鶴見区');
});

test('extractChomeBoundary: 全エリアの世帯数が0なら集約警告が先頭に付く', () => {
	const fc = {
		type: 'FeatureCollection',
		features: [
			feature({ cityName: '大和市', keyCode: '1', sName: 'X一丁目', setai: '0' }),
			feature({ cityName: '大和市', keyCode: '2', sName: 'Y一丁目', setai: '0' }),
		],
	};
	const { warnings } = extractChomeBoundary(fc, '大和市');
	assert.ok(warnings[0].includes('【要確認】'));
	assert.ok(warnings[0].includes('全2エリア'));
});

test('extractChomeBoundary: CITY_NAME不一致はextractMunicipality同様にエラー', () => {
	const fc = { type: 'FeatureCollection', features: [feature({ cityName: '大和市', keyCode: '1', sName: 'X', setai: '1' })] };
	assert.throws(() => extractChomeBoundary(fc, '平塚市'), /CITY_NAME="平塚市"/);
});

test('buildChomeAreaIdUpdateSql: 同一chome_area_idごとにグループ化したUPDATE文を生成する', () => {
	const map = new Map([
		['b1', 'chomeA'],
		['b2', 'chomeA'],
		['b3', 'chomeB'],
	]);
	const sql = buildChomeAreaIdUpdateSql(map);
	assert.match(sql, /UPDATE areas SET chome_area_id = 'chomeA' WHERE area_id IN \('b1', 'b2'\);/);
	assert.match(sql, /UPDATE areas SET chome_area_id = 'chomeB' WHERE area_id IN \('b3'\);/);
	// chome_area_idの昇順ソート(chomeA<chomeB)であること
	assert.ok(sql.indexOf('chomeA') < sql.indexOf('chomeB'));
});

test('buildChomeAreaIdUpdateSql: 500件を超えるIN句は複数のUPDATE文に分割する', () => {
	const map = new Map();
	for (let i = 0; i < 501; i++) map.set(`b${i}`, 'chomeA');
	const sql = buildChomeAreaIdUpdateSql(map);
	const updateCount = sql.split('\n').filter((line) => line.startsWith('UPDATE ')).length;
	assert.equal(updateCount, 2);
});

test('buildChomeAreaIdUpdateSql: SQLエスケープ・警告コメントの付与', () => {
	const map = new Map([["b'1", "chome'A"]]);
	const sql = buildChomeAreaIdUpdateSql(map, ['注意: テスト警告']);
	assert.match(sql, /'chome''A'/);
	assert.match(sql, /'b''1'/);
	assert.match(sql, /-- {3}注意: テスト警告/);
});
