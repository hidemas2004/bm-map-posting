import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAndCorrectDatum, type DatumCheckRow } from './datum_check.ts';
import { tokyoDatumToWgs84, type LatLng } from './geodetic.ts';
import { GeocodeServiceError } from './geocode.ts';

const BASE: LatLng = { lat: 35.4717, lng: 139.4549 };

function okRow(line: number): DatumCheckRow {
	// 生座標のままジオコーディング結果と一致する行（測地系ズレ無し）。
	return { line, address: `OK-${line}`, lat: BASE.lat, lng: BASE.lng };
}

function candidateRow(line: number): DatumCheckRow {
	// 生座標はTokyo Datum、ジオコーディング結果はWGS84（変換後に一致する）行。
	return { line, address: `CAND-${line}`, lat: BASE.lat, lng: BASE.lng };
}

function unresolvedRow(line: number): DatumCheckRow {
	return { line, address: `BAD-${line}`, lat: BASE.lat, lng: BASE.lng };
}

function failRow(line: number): DatumCheckRow {
	return { line, address: `FAIL-${line}`, lat: BASE.lat, lng: BASE.lng };
}

function noAddressRow(line: number): DatumCheckRow {
	return { line, address: '', lat: BASE.lat, lng: BASE.lng };
}

const FAR_POINT: LatLng = { lat: 43.0642, lng: 141.3469 }; // 札幌（大和市から遠い、明らかに不一致）

async function fakeGeocode(address: string): Promise<LatLng | null> {
	if (address.startsWith('OK-')) return BASE;
	if (address.startsWith('CAND-')) return tokyoDatumToWgs84(BASE);
	if (address.startsWith('BAD-')) return FAR_POINT;
	if (address.startsWith('FAIL-')) throw new GeocodeServiceError('geocode down');
	return null;
}

test('checkAndCorrectDatum: 90%以上一致なら verdict=none、補正なし', async () => {
	const rows = [...Array(9)].map((_, i) => okRow(i + 2)).concat([unresolvedRow(11)]);
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode });
	assert.equal(result.verdict, 'none');
	assert.equal(result.okCount, 9);
	assert.equal(result.unresolvedCount, 1);
	assert.equal(result.correctedCount, 0);
	assert.equal(result.warnings.length, 1);
	assert.equal(result.warnings[0].line, 11);
});

test('checkAndCorrectDatum: 90%以上が変換候補なら verdict=correct_all、全行を補正', async () => {
	const rows = [...Array(9)].map((_, i) => candidateRow(i + 2)).concat([unresolvedRow(11)]);
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode });
	assert.equal(result.verdict, 'correct_all');
	assert.equal(result.candidateCount, 9);
	assert.equal(result.correctedCount, rows.length);
	// 全行(unresolvedだった11行目も含む)が補正される
	assert.equal(result.correctedCoords.size, rows.length);
	const expectedConverted = tokyoDatumToWgs84(BASE);
	assert.deepEqual(result.correctedCoords.get(2), expectedConverted);
	// 変換後もなお不一致な11行目は個別warning
	assert.equal(result.warnings.length, 1);
	assert.equal(result.warnings[0].line, 11);
});

test('checkAndCorrectDatum: 一致率がどちらも閾値未満なら verdict=abort、DB書き込み対象なし', async () => {
	const rows = [okRow(2), okRow(3), candidateRow(4), candidateRow(5), unresolvedRow(6), unresolvedRow(7)];
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode });
	assert.equal(result.verdict, 'abort');
	assert.equal(result.correctedCount, 0);
	assert.equal(result.correctedCoords.size, 0);
	assert.equal(result.rows.length, rows.length);
});

test('checkAndCorrectDatum: ジオコーディングAPI障害が過半数なら verdict=unchecked でインポートを止めない', async () => {
	const rows = [failRow(2), failRow(3), failRow(4), okRow(5)];
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode });
	assert.equal(result.verdict, 'unchecked');
	assert.ok(result.note);
	assert.equal(result.geocodeFailedCount, 3);
});

test('checkAndCorrectDatum: 住所なし行は判定から除外される', async () => {
	const rows = [...Array(9)].map((_, i) => okRow(i + 2)).concat([noAddressRow(11), noAddressRow(12)]);
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode });
	assert.equal(result.verdict, 'none');
	assert.equal(result.noAddressCount, 2);
	assert.equal(result.warnings.length, 0);
});

test('checkAndCorrectDatum: 判定対象行が少なすぎる場合は verdict=unchecked', async () => {
	const rows = [okRow(2), candidateRow(3)];
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode, minJudgeableRows: 3 });
	assert.equal(result.verdict, 'unchecked');
});

test('checkAndCorrectDatum: 住所が1件も無ければ verdict=unchecked', async () => {
	const rows = [noAddressRow(2), noAddressRow(3), noAddressRow(4)];
	const result = await checkAndCorrectDatum(rows, { geocode: fakeGeocode });
	assert.equal(result.verdict, 'unchecked');
});
