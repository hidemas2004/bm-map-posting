// 見た目・地域設定の調整値。地域を入れ替える際はこのファイルを書き換えるだけでよい。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（汎用化設計）
const REGION_DISPLAY_NAME = '大和市';
const MAP_INITIAL_CENTER = [35.4717, 139.4549]; // 大和市の境界データ全体のbbox中心
const MAP_INITIAL_ZOOM = 13;

// 境界GeoJSONの配置パス（地域を入れ替える際はファイルを差し替えるだけでよい）
const BOUNDARY_GEOJSON_PATH = '/data/boundary.geojson';

// 丁目単位の境界線（基本単位区より1段階粗いグルーピングを視覚的に示す補助レイヤー。
// クリック等の操作対象は基本単位区レイヤーのみで、こちらは表示専用＝太め・別色で重ね描き）
const CHOME_BOUNDARY_GEOJSON_PATH = '/data/boundary_chome.geojson';
const CHOME_BOUNDARY_COLOR = '#1e3a8a';
const CHOME_BOUNDARY_WEIGHT = 1.75;

// 未担当エリアの表示（塗りつぶしなし・境界線のみ）
const UNASSIGNED_BOUNDARY_COLOR = '#2563eb';
const UNASSIGNED_BOUNDARY_WEIGHT = 0.525;

// 担当者ありエリアの塗りつぶし（青系グラデーション）
// opacity = MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * min(distribution_rate / RATE_FOR_MAX_OPACITY, 1.0)
// 割り当て直後（配布率0%）でもMIN_FILL_OPACITYの濃さで表示され、未担当（透明）と視覚的に区別できる
const ASSIGNED_FILL_COLOR = '#2563eb';
const ASSIGNED_BOUNDARY_COLOR = '#2563eb';
const ASSIGNED_BOUNDARY_WEIGHT = 0.525;
const MIN_FILL_OPACITY = 0.1; // 割り当て直後（配布率0%）の濃度
const MAX_FILL_OPACITY = 0.5; // 配布率がRATE_FOR_MAX_OPACITY以上になったときの濃度
const RATE_FOR_MAX_OPACITY = 90; // この配布率(%)以上で最高濃度

// 境界線の太さをズームレベルに応じて変える。
// 実際の太さ = 各WEIGHT + (現在のズーム - MAP_INITIAL_ZOOM) * ZOOM_WEIGHT_FACTOR（下限MIN_BOUNDARY_WEIGHT）
const ZOOM_WEIGHT_FACTOR = 0.4;
const MIN_BOUNDARY_WEIGHT = 0.5;

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
