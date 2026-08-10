import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInGeometry, representativePoint, assignChomeAreaIds } from './geo.mjs';

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

/** 外周に穴を持つポリゴン（ドーナツ状）。 */
function squareWithHole(outer, hole) {
	const ring = (x0, y0, x1, y1) => [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
		[x0, y0],
	];
	return { type: 'Polygon', coordinates: [ring(...outer), ring(...hole)] };
}

function feature(areaId, geometry) {
	return { type: 'Feature', properties: { area_id: areaId }, geometry };
}

test('pointInGeometry: 単純な正方形ポリゴンの内外判定', () => {
	const geom = square(0, 0, 10, 10);
	assert.equal(pointInGeometry([5, 5], geom), true);
	assert.equal(pointInGeometry([50, 50], geom), false);
});

test('pointInGeometry: 穴の中は含まれない', () => {
	const geom = squareWithHole([0, 0, 10, 10], [3, 3, 7, 7]);
	assert.equal(pointInGeometry([1, 1], geom), true); // 外周内・穴の外
	assert.equal(pointInGeometry([5, 5], geom), false); // 穴の中
});

test('pointInGeometry: MultiPolygonのいずれかに含まれればtrue', () => {
	const geom = { type: 'MultiPolygon', coordinates: [square(0, 0, 1, 1).coordinates, square(10, 10, 11, 11).coordinates] };
	assert.equal(pointInGeometry([0.5, 0.5], geom), true);
	assert.equal(pointInGeometry([10.5, 10.5], geom), true);
	assert.equal(pointInGeometry([5, 5], geom), false);
});

test('representativePoint: 正方形ポリゴンの内部点を返す', () => {
	const p = representativePoint(square(0, 0, 10, 10));
	assert.ok(p);
	assert.equal(pointInGeometry(p, square(0, 0, 10, 10)), true);
});

test('representativePoint: 穴ありポリゴンでも穴の外の内部点を返す', () => {
	const geom = squareWithHole([0, 0, 10, 10], [3, 3, 7, 7]);
	const p = representativePoint(geom);
	assert.ok(p);
	assert.equal(pointInGeometry(p, geom), true);
});

test('representativePoint: 面積0の退化ポリゴンはnullを返す', () => {
	const degenerate = { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] };
	assert.equal(representativePoint(degenerate), null);
});

test('assignChomeAreaIds: 1対1で一致する区画は対応するチョーム境界のarea_idを採用する', () => {
	const chomeFeatures = [feature('chomeA', square(0, 0, 10, 10)), feature('chomeB', square(20, 0, 30, 10))];
	const blockFeatures = [feature('block1', square(1, 1, 2, 2)), feature('block2', square(21, 1, 22, 2))];
	const { chomeAreaIdByAreaId, warnings } = assignChomeAreaIds(blockFeatures, chomeFeatures);
	assert.equal(chomeAreaIdByAreaId.get('block1'), 'chomeA');
	assert.equal(chomeAreaIdByAreaId.get('block2'), 'chomeB');
	assert.equal(warnings.length, 0);
});

test('assignChomeAreaIds: 0件一致は自分自身のarea_idにフォールバックし警告を記録する', () => {
	const chomeFeatures = [feature('chomeA', square(0, 0, 10, 10))];
	const blockFeatures = [feature('outside', square(100, 100, 101, 101))];
	const { chomeAreaIdByAreaId, warnings } = assignChomeAreaIds(blockFeatures, chomeFeatures);
	assert.equal(chomeAreaIdByAreaId.get('outside'), 'outside');
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes('outside'));
});

test('assignChomeAreaIds: 複数件一致は先頭のチョーム境界を採用し警告を記録する', () => {
	const chomeFeatures = [feature('chomeC1', square(0, 0, 10, 10)), feature('chomeC2', square(5, 5, 15, 15))];
	const blockFeatures = [feature('overlap', square(6, 6, 7, 7))];
	const { chomeAreaIdByAreaId, warnings } = assignChomeAreaIds(blockFeatures, chomeFeatures);
	assert.equal(chomeAreaIdByAreaId.get('overlap'), 'chomeC1');
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes('chomeC1'));
	assert.ok(warnings[0].includes('chomeC2'));
});

test('assignChomeAreaIds: 代表点計算失敗時も自分自身のarea_idにフォールバックする', () => {
	const chomeFeatures = [feature('chomeA', square(0, 0, 10, 10))];
	const degenerate = { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] };
	const blockFeatures = [feature('degenerate', degenerate)];
	const { chomeAreaIdByAreaId, warnings } = assignChomeAreaIds(blockFeatures, chomeFeatures);
	assert.equal(chomeAreaIdByAreaId.get('degenerate'), 'degenerate');
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes('代表点を計算できませんでした'));
});
