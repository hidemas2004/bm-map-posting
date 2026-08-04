// 見た目・地域設定の調整値。地域を入れ替える際はこのファイルを書き換えるだけでよい。

// 対象地域表示名・地図初期中心座標・初期ズームレベル（汎用化設計）
const REGION_DISPLAY_NAME = '横浜市';
const MAP_INITIAL_CENTER = [35.4437, 139.638]; // 横浜市庁舎付近
const MAP_INITIAL_ZOOM = 12;

// 境界GeoJSONの配置パス（地域を入れ替える際はファイルを差し替えるだけでよい）
const BOUNDARY_GEOJSON_PATH = '/data/boundary.geojson';

// 未担当エリアの表示（塗りつぶしなし・境界線のみ）
const UNASSIGNED_BOUNDARY_COLOR = '#9ca3af';
const UNASSIGNED_BOUNDARY_WEIGHT = 1.5;
const UNASSIGNED_DASH_ARRAY = '4 4';

// 担当者ありエリアの塗りつぶし（青系グラデーション）
// opacity = min(distribution_rate / RATE_FOR_MAX_OPACITY, 1.0) * MAX_FILL_OPACITY
const ASSIGNED_FILL_COLOR = '#2563eb';
const ASSIGNED_BOUNDARY_COLOR = '#1d4ed8';
const RATE_FOR_MAX_OPACITY = 90; // この配布率(%)以上で最高濃度
const MAX_FILL_OPACITY = 0.85;

// GPS現在地マーカー
const GPS_DOT_COLOR = '#2563eb';
const GPS_DOT_RADIUS_PX = 8;
