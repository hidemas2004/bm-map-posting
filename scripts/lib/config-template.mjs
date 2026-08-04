/**
 * public/config.js のうち地域非依存の調整値（色・しきい値等）。大和市デプロイ時に調整された
 * 実運用値をそのままテンプレートとして流用する。新しい地域固有の値（表示名・中心座標・ズーム）だけ
 * 差し替えて regions/<id>/config.js を生成する。
 */
export function buildConfigJs({ displayName, center, zoom }) {
	return `// 見た目・地域設定の調整値。地域を入れ替える際はこのファイルを書き換えるだけでよい。
// scripts/new-region.mjs により自動生成（地域固有部分のみ）。色・しきい値は共通テンプレート。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（汎用化設計）
const REGION_DISPLAY_NAME = '${displayName}';
const MAP_INITIAL_CENTER = [${center[0]}, ${center[1]}]; // ${displayName}の境界データ全体のbbox中心
const MAP_INITIAL_ZOOM = ${zoom};

// 境界GeoJSONの配置パス（地域を入れ替える際はファイルを差し替えるだけでよい）
const BOUNDARY_GEOJSON_PATH = '/data/boundary.geojson';

// 未担当エリアの表示（塗りつぶしなし・境界線のみ）
const UNASSIGNED_BOUNDARY_COLOR = '#000000';
const UNASSIGNED_BOUNDARY_WEIGHT = 2.1;
const UNASSIGNED_DASH_ARRAY = '4 4';

// 担当者ありエリアの塗りつぶし（青系グラデーション）
// opacity = MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * min(distribution_rate / RATE_FOR_MAX_OPACITY, 1.0)
// 割り当て直後（配布率0%）でもMIN_FILL_OPACITYの濃さで表示され、未担当（透明）と視覚的に区別できる
const ASSIGNED_FILL_COLOR = '#2563eb';
const ASSIGNED_BOUNDARY_COLOR = '#000000';
const ASSIGNED_BOUNDARY_WEIGHT = 2.1;
const MIN_FILL_OPACITY = 0.1; // 割り当て直後（配布率0%）の濃度
const MAX_FILL_OPACITY = 0.5; // 配布率がRATE_FOR_MAX_OPACITY以上になったときの濃度
const RATE_FOR_MAX_OPACITY = 90; // この配布率(%)以上で最高濃度

// 境界線の太さをズームレベルに応じて変える。
// 実際の太さ = 各WEIGHT + (現在のズーム - MAP_INITIAL_ZOOM) * ZOOM_WEIGHT_FACTOR（下限MIN_BOUNDARY_WEIGHT）
const ZOOM_WEIGHT_FACTOR = 0.8;
const MIN_BOUNDARY_WEIGHT = 1;

// 担当者フィルタで対象外になったエリアの塗り（濃い灰色でマスク）
const MASKED_FILL_COLOR = '#4b5563';
const MASKED_FILL_OPACITY = 0.65;

// 世帯数0のエリアの恒久的な塗り（担当者設定・配布記録の対象外であることを示す）
const ZERO_HOUSEHOLD_FILL_COLOR = '#4b5563';
const ZERO_HOUSEHOLD_FILL_OPACITY = 0.65;

// 担当者フィルタの「担当者未決」選択時の内部値（実在のuser_idと衝突しないダミー値）
const UNASSIGNED_FILTER_VALUE = '__unassigned__';

// GPS現在地マーカー
const GPS_DOT_COLOR = '#2563eb';
const GPS_DOT_RADIUS_PX = 8;
`;
}

/** GeoJSON FeatureCollection（MultiPolygon想定）全体のbboxの中心を [lat, lng] で返す。 */
export function computeCenterFromGeoJson(featureCollection) {
	let minLng = Infinity;
	let maxLng = -Infinity;
	let minLat = Infinity;
	let maxLat = -Infinity;

	const visit = (coords, depth) => {
		if (depth === 0) {
			const [lng, lat] = coords;
			if (lng < minLng) minLng = lng;
			if (lng > maxLng) maxLng = lng;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
			return;
		}
		for (const c of coords) visit(c, depth - 1);
	};

	for (const feature of featureCollection.features) {
		const { type, coordinates } = feature.geometry;
		// Polygon: [ring][point][lng,lat] = depth2, MultiPolygon: [polygon][ring][point][lng,lat] = depth3
		visit(coordinates, type === 'MultiPolygon' ? 3 : 2);
	}

	if (!Number.isFinite(minLng)) throw new Error('GeoJSONから座標を抽出できませんでした');

	const round = (n) => Math.round(n * 10000) / 10000;
	return [round((minLat + maxLat) / 2), round((minLng + maxLng) / 2)];
}
