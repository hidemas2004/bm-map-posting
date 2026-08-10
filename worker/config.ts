/**
 * /config.js を地域ごとの env（wrangler.jsonc の vars）から動的生成する。
 * 地域固有の値（表示名・地図初期座標・境界データパス）のみ env から埋め込み、
 * 色・しきい値等の見た目パラメータは全地域共通としてここに一本化する
 * （旧 scripts/lib/config-template.mjs は public/config.js との内容ドリフトが生じていたため廃止）。
 */

export interface ConfigEnv {
	REGION_ID: string;
	REGION_DISPLAY_NAME: string;
	MAP_CENTER_LAT: number;
	MAP_CENTER_LNG: number;
	MAP_ZOOM: number;
	HAS_CHOME_BOUNDARY: boolean;
}

export function buildConfigResponse(env: ConfigEnv): string {
	const boundaryPath = `/data/regions/${env.REGION_ID}/boundary.geojson`;

	const chomeBoundaryBlock = env.HAS_CHOME_BOUNDARY
		? `
// 丁目単位の境界線（基本単位区より1段階粗いグルーピングを視覚的に示す補助レイヤー。
// クリック等の操作対象は基本単位区レイヤーのみで、こちらは表示専用＝太め・別色で重ね描き）
const CHOME_BOUNDARY_GEOJSON_PATH = '/data/regions/${env.REGION_ID}/boundary_chome.geojson';
const CHOME_BOUNDARY_COLOR = '#1e3a8a';
const CHOME_BOUNDARY_WEIGHT = 1.75;
`
		: '';

	return `// 見た目・地域設定の調整値。worker/config.ts が env（wrangler.jsonc の vars）から動的生成する。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（地域ごとに異なる）
const REGION_DISPLAY_NAME = ${JSON.stringify(env.REGION_DISPLAY_NAME)};
const MAP_INITIAL_CENTER = [${env.MAP_CENTER_LAT}, ${env.MAP_CENTER_LNG}];
const MAP_INITIAL_ZOOM = ${env.MAP_ZOOM};

// 境界GeoJSONの配置パス（地域ごとに固有のパスを持つため差し替え不要）
const BOUNDARY_GEOJSON_PATH = ${JSON.stringify(boundaryPath)};
${chomeBoundaryBlock}
// 未担当エリアの表示（塗りつぶしなし・境界線のみ）
const UNASSIGNED_BOUNDARY_COLOR = '#2563eb';
const UNASSIGNED_BOUNDARY_WEIGHT = 0.525;

// 担当者ありエリアの塗りつぶし（青系グラデーション）
// 配布率がRATE_FOR_MIN_OPACITY%以下は常にMIN_FILL_OPACITYの濃さで横ばい、
// そこからRATE_FOR_MAX_OPACITY%まで線形にMAX_FILL_OPACITYまで濃くなる。
// opacity = MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY)
//           * clamp((distribution_rate - RATE_FOR_MIN_OPACITY) / (RATE_FOR_MAX_OPACITY - RATE_FOR_MIN_OPACITY), 0, 1)
const ASSIGNED_FILL_COLOR = '#2563eb';
const ASSIGNED_BOUNDARY_COLOR = '#2563eb';
const ASSIGNED_BOUNDARY_WEIGHT = 0.525;
const MIN_FILL_OPACITY = 0.1; // 配布率0〜RATE_FOR_MIN_OPACITY%の間の濃度（横ばい）
const MAX_FILL_OPACITY = 0.85; // 配布率がRATE_FOR_MAX_OPACITY以上になったときの濃度
const RATE_FOR_MIN_OPACITY = 10; // この配布率(%)以下は濃度を上げない
const RATE_FOR_MAX_OPACITY = 90; // この配布率(%)以上で最高濃度

// 境界線の太さをズームレベルに応じて変える。
// 実際の太さ = 各WEIGHT + (現在のズーム - MAP_INITIAL_ZOOM) * ZOOM_WEIGHT_FACTOR（下限MIN_BOUNDARY_WEIGHT）
const ZOOM_WEIGHT_FACTOR = 0.4;
const MIN_BOUNDARY_WEIGHT = 0.5;

// 担当者フィルタで対象外になったエリアの塗り（エリア担当未設定と同じグレーでマスク）
const MASKED_FILL_COLOR = '#9ca3af';
const MASKED_FILL_OPACITY = 0.7;

// 世帯数0のエリアの恒久的な塗り（担当者設定・配布記録の対象外であることを示す。グレー(濃)）
const ZERO_HOUSEHOLD_FILL_COLOR = '#4b5563';
const ZERO_HOUSEHOLD_FILL_OPACITY = 0.7;

// エリア担当が未設定の区画の塗り（予定配布エリア外であることを示す。グレー(中)。
// 世帯ゼロ(濃)より明るくして区別する）
const NON_TARGET_FILL_COLOR = '#9ca3af';
const NON_TARGET_FILL_OPACITY = 0.7;

// GPS現在地マーカー
const GPS_DOT_COLOR = '#2563eb';
const GPS_DOT_RADIUS_PX = 8;

// 投票所ピン（しずく型・紺色。丁目境界と同じ色でエリア外の重要地点であることを示す）
const POLLING_STATION_PIN_COLOR = '#1e3a8a';
`;
}
