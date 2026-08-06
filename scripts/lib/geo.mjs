/**
 * issue#12対応: 区画（基本単位区）がどのチョーム境界ポリゴン（boundary_chome.geojson相当）に
 * 空間的に含まれるかを判定するための、依存ライブラリ無しの簡易ジオメトリユーティリティ。
 * 座標は経緯度（GeoJSON順序 [lng, lat]）のまま扱う簡易平面近似で十分な精度（同一市区町村内の
 * 区画判定用途のため、投影や測地線計算は行わない）。
 */

import { toPolygonList } from './estat-boundary.mjs';

/** レイキャスティング法。ring: [lng,lat][]。 */
function pointInRing([x, y], ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** 1つのポリゴン（[外周, 穴1, 穴2, ...]）に点が含まれるか。穴の中は含まれない扱い。 */
function pointInPolygonRings(point, rings) {
	if (!pointInRing(point, rings[0])) return false;
	for (let i = 1; i < rings.length; i++) {
		if (pointInRing(point, rings[i])) return false;
	}
	return true;
}

/** Polygon/MultiPolygon geometryに点が含まれるか。 */
export function pointInGeometry(point, geometry) {
	return toPolygonList(geometry).some((rings) => pointInPolygonRings(point, rings));
}

/** シューレース公式によるリング面積（絶対値。単位は度^2相当で大小比較専用）。 */
function ringArea(ring) {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return Math.abs(sum) / 2;
}

/** ringと水平線y=constの交点x座標を昇順で返す。 */
function scanlineIntersections(ring, y) {
	const xs = [];
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (yi === yj) continue;
		if (yi > y !== yj > y) {
			xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
		}
	}
	return xs.sort((a, b) => a - b);
}

/** 昇順のx配列を [start,end] ペアの配列に変換する（レイキャスティングの偶奇規則通り）。 */
function pairsFromSorted(xs) {
	const pairs = [];
	for (let i = 0; i + 1 < xs.length; i += 2) pairs.push([xs[i], xs[i + 1]]);
	return pairs;
}

/** base（ソート済み・非重複の区間集合）から holes を差し引いた残りの区間集合を返す。 */
function subtractIntervals(base, holes) {
	let result = base;
	for (const [hs, he] of holes) {
		const next = [];
		for (const [s, e] of result) {
			if (he <= s || hs >= e) {
				next.push([s, e]);
				continue;
			}
			if (hs > s) next.push([s, hs]);
			if (he < e) next.push([he, e]);
		}
		result = next;
	}
	return result;
}

/**
 * geometry内部の代表点を1つ求める（Polygon/MultiPolygonの、最大面積のポリゴン部分を対象。
 * 穴（ドーナツ状の区画）も考慮する）。外周・穴の全頂点のy座標から得られる「隣接するy値の中点」
 * ごとにスキャンラインを走らせ、外周の区間から穴の区間を差し引いた残り（=ポリゴン内部）の
 * うち最も幅の広い区間の中点を採用する。この方法は多角形の頂点間でトポロジーが変化しない
 * 区間を網羅的に走査するため、面積を持つ限り内部点を確実に見つけられる。
 * 交点が求まらない場合は外周頂点の単純平均へフォールバックし、それでも内部点にならなければ null。
 */
export function representativePoint(geometry) {
	const polygons = toPolygonList(geometry);
	if (polygons.length === 0) return null;

	let best = polygons[0];
	let bestArea = ringArea(polygons[0][0]);
	for (const rings of polygons.slice(1)) {
		const area = ringArea(rings[0]);
		if (area > bestArea) {
			best = rings;
			bestArea = area;
		}
	}

	const [outer, ...holes] = best;
	const ys = new Set();
	for (const ring of best) for (const [, y] of ring) ys.add(y);
	const sortedYs = [...ys].sort((a, b) => a - b);

	let bestPoint = null;
	let bestWidth = 0;
	for (let i = 0; i + 1 < sortedYs.length; i++) {
		const y = (sortedYs[i] + sortedYs[i + 1]) / 2;
		if (y === sortedYs[i] || y === sortedYs[i + 1]) continue; // 数値精度で同一値になるケースを避ける
		const outerXs = scanlineIntersections(outer, y);
		if (outerXs.length < 2) continue;
		let freeIntervals = pairsFromSorted(outerXs);
		for (const hole of holes) {
			const holeXs = scanlineIntersections(hole, y);
			if (holeXs.length < 2) continue;
			freeIntervals = subtractIntervals(freeIntervals, pairsFromSorted(holeXs));
		}
		for (const [s, e] of freeIntervals) {
			const width = e - s;
			if (width > bestWidth) {
				bestWidth = width;
				bestPoint = [(s + e) / 2, y];
			}
		}
	}

	if (bestPoint && pointInPolygonRings(bestPoint, best)) return bestPoint;

	let sx = 0;
	let sy = 0;
	for (const [x, y] of outer) {
		sx += x;
		sy += y;
	}
	const centroid = [sx / outer.length, sy / outer.length];
	if (pointInPolygonRings(centroid, best)) return centroid;

	return null;
}

/**
 * 区画（block）ごとに、どのチョーム境界ポリゴンに空間的に含まれるかを判定し、そのフィーチャの
 * area_id（e-Stat KEY_CODE）を返す。0件一致・複数件一致・代表点計算失敗のいずれの場合も、
 * 区画自身のarea_idにフォールバックし warnings に理由を記録する（chome_area_idが空文字や
 * 誤ったグループになり、別々の区画が誤って同一エリア扱いになる事故を防ぐため）。
 * @param {Array<{properties:{area_id:string},geometry:object}>} blockFeatures 区画（基本単位区）
 * @param {Array<{properties:{area_id:string},geometry:object}>} chomeFeatures チョーム境界
 */
export function assignChomeAreaIds(blockFeatures, chomeFeatures) {
	const chomeAreaIdByAreaId = new Map();
	const warnings = [];

	for (const block of blockFeatures) {
		const areaId = block.properties.area_id;
		const point = representativePoint(block.geometry);
		if (!point) {
			warnings.push(`area_id=${areaId}: 代表点を計算できませんでした（自分自身のarea_idにフォールバック）`);
			chomeAreaIdByAreaId.set(areaId, areaId);
			continue;
		}

		const hits = chomeFeatures.filter((f) => pointInGeometry(point, f.geometry));
		if (hits.length === 0) {
			warnings.push(
				`area_id=${areaId}: 代表点(${point[0].toFixed(6)},${point[1].toFixed(6)})を含むチョーム境界が` +
					'見つかりませんでした（自分自身のarea_idにフォールバック）',
			);
			chomeAreaIdByAreaId.set(areaId, areaId);
		} else if (hits.length > 1) {
			const ids = hits.map((f) => f.properties.area_id).join(', ');
			warnings.push(`area_id=${areaId}: 複数のチョーム境界(${ids})に一致しました（先頭の${hits[0].properties.area_id}を採用）`);
			chomeAreaIdByAreaId.set(areaId, hits[0].properties.area_id);
		} else {
			chomeAreaIdByAreaId.set(areaId, hits[0].properties.area_id);
		}
	}

	return { chomeAreaIdByAreaId, warnings };
}
