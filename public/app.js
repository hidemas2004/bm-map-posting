const SESSION_KEY = 'bm_posting_session';
const MAP_VIEW_FILTER = '__map_view__'; // 担当者フィルタの特殊値。選択時は全区画を境界線のみ（塗りつぶしなし）で表示する。

const sessionRaw = sessionStorage.getItem(SESSION_KEY);
if (!sessionRaw) {
	location.href = '/login.html';
	throw new Error('not authenticated');
}
const session = JSON.parse(sessionRaw);

// ヘッダのチェックボックス（投票所・コメントフィルタ）・現在地ボタンの表示状態は、
// バーガーメニュー内リンク（履歴一覧等）へ遷移して戻ってきた際もページがリロードされ
// JSの状態が失われるため、sessionStorageに保存して復元する。
const UI_STATE_KEY = 'bm_posting_ui_state';
function loadSavedUiState() {
	try {
		const raw = sessionStorage.getItem(UI_STATE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}
const savedUiState = loadSavedUiState();

const state = {
	terms: [],
	currentTermId: null,
	viewOnly: false,
	termDataByAreaId: new Map(),
	activeUsers: [],
	watchId: null,
	gpsMarker: null,
	assigneeFilter: '', // ''=全体表示、それ以外はuser_id
	pollingStations: [], // 検索用（loadPollingStationsで取得した生データ）
	comments: new Map(), // comment_id -> comment（issue#24。全ターム共通データなのでterm切替の影響を受けない）
	// 表示中のカテゴリ集合（空＝表示しない）。デフォルトは全カテゴリ表示、保存済み状態があればそれを復元する。
	commentFilterCategories: new Set(savedUiState?.commentFilterCategories ?? COMMENT_CATEGORIES.map((c) => c.value)),
	trackId: null, // 記録中のtrack_id（nullなら未記録）
	trackWatchId: null,
	trackBuffer: [], // サーバー未送信の座標点
	trackFlushTimer: null,
	trackPolyline: null, // 記録中にリアルタイム描画するpolyline
	wakeLock: null,
};

function escapeHtml(str) {
	return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function apiFetch(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: {
			...(options.headers || {}),
			Authorization: `Bearer ${session.token}`,
		},
	});
	if (res.status === 401) {
		sessionStorage.removeItem(SESSION_KEY);
		location.href = '/login.html';
		throw new Error('unauthorized');
	}
	return res;
}

function currentTerm() {
	return state.terms.find((t) => t.term_id === state.currentTermId) ?? null;
}

/** rowと同じエリア（chome_area_id）に属する全区画の世帯数合計 */
function areaHouseholdsFor(row) {
	let total = 0;
	for (const r of state.termDataByAreaId.values()) {
		if (r.chome_area_id === row.chome_area_id) total += r.num_households;
	}
	return total;
}

/** rowと同じエリア（chome_area_id）に属する全区画の累計配布世帯数合計 */
function areaDistributedFor(row) {
	let total = 0;
	for (const r of state.termDataByAreaId.values()) {
		if (r.chome_area_id === row.chome_area_id) total += r.distributed_total;
	}
	return total;
}

function areaTitle(row) {
	let title = row.city;
	if (row.ward) title += ` ${row.ward}`;
	if (row.town) title += ` ${row.town}`;
	if (row.chome) title += `${row.chome}丁目`;
	if (row.block) title += ` ${row.block}区画`;
	return title;
}

// ---- 地図初期化 ----

// バーガーメニュー内リンク（別ページ）から戻った場合、保存済みのズーム・中心位置があれば
// それを初期表示に使う（無ければ地域設定のデフォルト）。
const map = L.map('map').setView(savedUiState?.mapCenter ?? MAP_INITIAL_CENTER, savedUiState?.mapZoom ?? MAP_INITIAL_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
map.on('moveend', () => saveUiState());

let geoLayer = null;
let chomeLayer = null;
let pollingStationLayer = null;
const commentLayerGroup = L.layerGroup();
const trackQueryLayerGroup = L.layerGroup();
// 記録終了直後、地図に残しておく直描きpolyline置き場。記録中はmapに直接addToし、
// STOP時にここへ移し替える（軌跡照会の「消去」でまとめて消せるようにするため）。
const liveTrackLayerGroup = L.layerGroup();

function weightForZoom(baseWeight) {
	const zoomDiff = map.getZoom() - MAP_INITIAL_ZOOM;
	return Math.max(MIN_BOUNDARY_WEIGHT, baseWeight + zoomDiff * ZOOM_WEIGHT_FACTOR);
}

/** 担当者フィルタ選択中の行が「ハイライト対象（＝グレーアウトしない）」かどうか */
function matchesAssigneeFilter(row, filter) {
	if (!filter || filter === MAP_VIEW_FILTER) return true; // 全体表示・地図表示＝フィルタなし
	return row.assignee_id === filter;
}

function styleForArea(areaId) {
	if (state.assigneeFilter === MAP_VIEW_FILTER) {
		return {
			color: UNASSIGNED_BOUNDARY_COLOR,
			weight: weightForZoom(UNASSIGNED_BOUNDARY_WEIGHT),
			fillOpacity: 0,
		};
	}

	const row = state.termDataByAreaId.get(areaId);
	if (!row) {
		return {
			color: UNASSIGNED_BOUNDARY_COLOR,
			weight: weightForZoom(UNASSIGNED_BOUNDARY_WEIGHT),
			fillOpacity: 0,
		};
	}

	// 世帯数0のエリアは担当者設定・配布記録の対象外。フィルタ状態に関わらず常にグレー固定。
	if (row.num_households === 0) {
		return {
			color: UNASSIGNED_BOUNDARY_COLOR,
			weight: weightForZoom(UNASSIGNED_BOUNDARY_WEIGHT),
			fillColor: ZERO_HOUSEHOLD_FILL_COLOR,
			fillOpacity: ZERO_HOUSEHOLD_FILL_OPACITY,
		};
	}

	// 担当者フィルタで特定の担当者が選ばれている場合、その担当者以外のエリアは
	// （エリア担当未設定=黄色 のエリアも含めて）すべて世帯ゼロと同じ濃さのグレーにする。
	if (!matchesAssigneeFilter(row, state.assigneeFilter)) {
		return {
			color: UNASSIGNED_BOUNDARY_COLOR,
			weight: weightForZoom(UNASSIGNED_BOUNDARY_WEIGHT),
			fillColor: MASKED_FILL_COLOR,
			fillOpacity: MASKED_FILL_OPACITY,
		};
	}

	// エリア担当・区画担当がともに未設定の区画は予定配布エリア外。フィルタ状態に関わらず常にグレー固定。
	if (!row.area_manager_id && !row.assignee_id) {
		return {
			color: UNASSIGNED_BOUNDARY_COLOR,
			weight: weightForZoom(UNASSIGNED_BOUNDARY_WEIGHT),
			fillColor: NON_TARGET_FILL_COLOR,
			fillOpacity: NON_TARGET_FILL_OPACITY,
		};
	}

	if (!row.assignee_id) {
		return {
			color: UNASSIGNED_BOUNDARY_COLOR,
			weight: weightForZoom(UNASSIGNED_BOUNDARY_WEIGHT),
			fillOpacity: 0,
		};
	}
	const progress = Math.min(
		Math.max((row.distribution_rate - RATE_FOR_MIN_OPACITY) / (RATE_FOR_MAX_OPACITY - RATE_FOR_MIN_OPACITY), 0),
		1.0,
	);
	const opacity = MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * progress;
	return {
		color: ASSIGNED_BOUNDARY_COLOR,
		weight: weightForZoom(ASSIGNED_BOUNDARY_WEIGHT),
		fillColor: ASSIGNED_FILL_COLOR,
		fillOpacity: opacity,
	};
}

function redrawStyles() {
	if (!geoLayer) return;
	geoLayer.eachLayer((layer) => layer.setStyle(styleForArea(layer.feature.properties.area_id)));
	if (chomeLayer) chomeLayer.setStyle({ weight: weightForZoom(CHOME_BOUNDARY_WEIGHT) });
}

map.on('zoomend', redrawStyles);

/**
 * ヘッダの全世帯数・実績/予定枚数を集計・表示する。
 * 全世帯数のみ担当者フィルタの影響を受けない。実績・予定枚数は担当者フィルタに連動し、
 * 特定の担当者を選ぶとその担当者分のみの計になる。
 * 実績率(③)の分母は予定枚数(④)、予定率(⑤)の分母は全世帯数(①)。
 */
function updateHeaderStats() {
	let totalHouseholds = 0;
	let plannedHouseholds = 0;
	let distributed = 0;

	for (const row of state.termDataByAreaId.values()) {
		totalHouseholds += row.num_households;
	}

	for (const row of state.termDataByAreaId.values()) {
		if (!matchesAssigneeFilter(row, state.assigneeFilter)) continue;
		if (!row.area_manager_id && !row.assignee_id) continue; // 予定配布エリア(エリア担当or区画担当が設定済み)のみ集計
		plannedHouseholds += row.num_households;
		distributed += row.distributed_total;
	}

	const distributedRate = plannedHouseholds > 0 ? ((distributed / plannedHouseholds) * 100).toFixed(1) : '0.0';
	const plannedRate = totalHouseholds > 0 ? ((plannedHouseholds / totalHouseholds) * 100).toFixed(1) : '0.0';

	document.getElementById('stat-total-households').textContent = totalHouseholds.toLocaleString('ja-JP');
	document.getElementById('stat-distributed').textContent = distributed.toLocaleString('ja-JP');
	document.getElementById('stat-distributed-rate').textContent = `${distributedRate}%`;
	document.getElementById('stat-planned-households').textContent = plannedHouseholds.toLocaleString('ja-JP');
	document.getElementById('stat-planned-rate').textContent = `${plannedRate}%`;
}

function populateAssigneeFilterSelect() {
	const select = document.getElementById('assignee-filter');
	select.innerHTML = '';

	const optMapView = document.createElement('option');
	optMapView.value = MAP_VIEW_FILTER;
	optMapView.textContent = '(地図表示)';
	select.appendChild(optMapView);

	const optAll = document.createElement('option');
	optAll.value = '';
	optAll.textContent = '(全体表示)';
	select.appendChild(optAll);

	for (const user of state.activeUsers) {
		const option = document.createElement('option');
		option.value = user.user_id;
		option.textContent = user.name;
		select.appendChild(option);
	}

	select.value = state.assigneeFilter;
}

document.getElementById('assignee-filter').addEventListener('change', (e) => {
	state.assigneeFilter = e.target.value;
	redrawStyles();
	updateHeaderStats();
});

// 区画数が数千件規模の地域があり、デフォルトのSVGレンダラーだと区画ごとに個別のDOM要素
// （<path>）を作るため初期描画がメインスレッドを長時間占有し操作不能になる。1枚のcanvasに
// まとめて描画するCanvasレンダラーを共有で使い、これを避ける。
const boundaryRenderer = L.canvas();

async function loadBoundary() {
	const res = await fetch(BOUNDARY_GEOJSON_PATH);
	const geojson = await res.json();
	geoLayer = L.geoJSON(geojson, {
		renderer: boundaryRenderer,
		style: (feature) => styleForArea(feature.properties.area_id),
		onEachFeature: (feature, layer) => {
			layer.on('click', () => openPopup(layer));
		},
	}).addTo(map);
}

/** 丁目単位の境界線を表示専用（太め・別色、クリック不可）で基本単位区レイヤーの上に重ねる。 */
async function loadChomeBoundary() {
	const res = await fetch(CHOME_BOUNDARY_GEOJSON_PATH);
	const geojson = await res.json();
	chomeLayer = L.geoJSON(geojson, {
		renderer: boundaryRenderer,
		interactive: false,
		style: () => ({
			color: CHOME_BOUNDARY_COLOR,
			weight: weightForZoom(CHOME_BOUNDARY_WEIGHT),
			fill: false,
		}),
	}).addTo(map);
}

/**
 * 投票所ピン（issue#13）。しずく型・紺色のdivIconマーカーをlayerGroupにまとめておき、
 * ヘッダの「投票所」チェックボックスON時のみmap.addTo()する（初期状態は非表示）。
 */
async function loadPollingStations() {
	const res = await apiFetch('/api/polling-stations');
	const stations = await res.json();
	state.pollingStations = stations;
	const markers = stations.map((s) => {
		const popup = document.createElement('div');
		popup.className = 'popup-content';
		const title = document.createElement('div');
		title.className = 'title';
		title.textContent = s.name;
		popup.appendChild(title);
		if (s.address) {
			const address = document.createElement('div');
			address.textContent = s.address;
			popup.appendChild(address);
		}
		const uncertainMark = s.location_uncertain ? '<span class="pin-uncertain-mark">?</span>' : '';
		const marker = L.marker([s.lat, s.lng], {
			icon: L.divIcon({
				className: '',
				html: `<div class="polling-station-pin" style="background:${POLLING_STATION_PIN_COLOR}">${uncertainMark}</div>`,
				iconSize: [22, 22],
				iconAnchor: [11, 22],
			}),
		}).bindPopup(popup);
		marker.pollingStation = s; // 検索結果からポップアップを開くための逆引き用
		return marker;
	});
	pollingStationLayer = L.layerGroup(markers);
}

function saveUiState() {
	sessionStorage.setItem(
		UI_STATE_KEY,
		JSON.stringify({
			pollingStationVisible: document.getElementById('polling-station-toggle').checked,
			commentFilterCategories: Array.from(state.commentFilterCategories),
			gpsActive: state.watchId !== null,
			trackQueryVisible: map.hasLayer(trackQueryLayerGroup),
			trackQueryFrom: trackQueryFromInput.value,
			trackQueryTo: trackQueryToInput.value,
			trackQueryUserId: trackQueryUserSelect.value,
			mapCenter: map.getCenter(),
			mapZoom: map.getZoom(),
		}),
	);
}

document.getElementById('polling-station-toggle').addEventListener('change', (e) => {
	if (e.target.checked) {
		pollingStationLayer.addTo(map);
	} else {
		map.removeLayer(pollingStationLayer);
	}
	saveUiState();
});

// ---- 地図コメント（issue#24） ----
// term/areaに紐付かない独立データ。地図上の任意地点を長押し／ダブルタップ／右クリックすると
// 新規作成ポップアップを開く。Leafletは長押しを標準サポートしないため、touchstart系の生イベントで
// 自前実装する。ダブルクリック/ダブルタップはLeaflet標準のdblclickイベントがPC・モバイル双方を
// 正規化してくれるため、既定のズーム動作をコメント作成用に転用するだけでよい。

async function loadComments() {
	const res = await apiFetch('/api/comments');
	const comments = await res.json();
	state.comments = new Map(comments.map((c) => [c.comment_id, c]));
	renderCommentMarkers();
}

function commentCategoryMeta(category) {
	return COMMENT_CATEGORIES.find((c) => c.value === category) ?? COMMENT_CATEGORIES[COMMENT_CATEGORIES.length - 1];
}

function commentPinColorFor(comment) {
	if (comment.category === 'other') return comment.pin_color || COMMENT_OTHER_PIN_COLORS[0];
	return commentCategoryMeta(comment.category).color;
}

const COMMENT_CATEGORY_SYMBOLS = { no_posting: 'X', poster_candidate: 'P', other: '!' };

function commentSymbolFor(comment) {
	return COMMENT_CATEGORY_SYMBOLS[comment.category] ?? '!';
}

function commentIconFor(comment) {
	return L.divIcon({
		className: '',
		html: `<div class="comment-pin" data-symbol="${commentSymbolFor(comment)}" style="background:${commentPinColorFor(comment)}"></div>`,
		iconSize: [22, 22],
		iconAnchor: [11, 22],
	});
}

function renderCommentMarkers() {
	commentLayerGroup.clearLayers();
	if (state.commentFilterCategories.size === 0) {
		if (map.hasLayer(commentLayerGroup)) map.removeLayer(commentLayerGroup);
		return;
	}
	for (const comment of state.comments.values()) {
		if (!state.commentFilterCategories.has(comment.category)) continue;
		const marker = L.marker([comment.lat, comment.lng], { icon: commentIconFor(comment) });
		marker.commentId = comment.comment_id; // 検索結果からポップアップを開くための逆引き用
		marker.bindPopup(buildCommentViewContent(comment, marker));
		commentLayerGroup.addLayer(marker);
	}
	if (!map.hasLayer(commentLayerGroup)) commentLayerGroup.addTo(map);
}

function populateCommentFilterCheckboxes() {
	const container = document.getElementById('comment-filter-checkboxes');
	container.innerHTML = '';
	for (const category of COMMENT_CATEGORIES) {
		const label = document.createElement('label');
		label.className = 'header-checkbox';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = state.commentFilterCategories.has(category.value);
		input.addEventListener('change', () => {
			if (input.checked) state.commentFilterCategories.add(category.value);
			else state.commentFilterCategories.delete(category.value);
			renderCommentMarkers();
			saveUiState();
		});
		label.appendChild(input);
		label.appendChild(document.createTextNode(category.label));
		container.appendChild(label);
	}
}

const COMMENT_LONG_PRESS_MS = 600;
const COMMENT_LONG_PRESS_MOVE_TOLERANCE_PX = 12;
const COMMENT_GESTURE_DEBOUNCE_MS = 500;
let lastCommentGestureAt = 0;

function triggerCommentCreateGesture(latlng) {
	const now = Date.now();
	if (now - lastCommentGestureAt < COMMENT_GESTURE_DEBOUNCE_MS) return;
	lastCommentGestureAt = now;
	openCreateCommentPopup(latlng);
}

map.doubleClickZoom.disable();
map.on('dblclick', (e) => triggerCommentCreateGesture(e.latlng));
map.on('contextmenu', (e) => {
	L.DomEvent.preventDefault(e.originalEvent);
	triggerCommentCreateGesture(e.latlng);
});

(function setupCommentLongPress() {
	const container = map.getContainer();
	let timer = null;
	let startPoint = null;

	function clear() {
		if (timer) clearTimeout(timer);
		timer = null;
		startPoint = null;
	}

	container.addEventListener(
		'touchstart',
		(e) => {
			if (e.touches.length !== 1) {
				clear();
				return;
			}
			const touch = e.touches[0];
			startPoint = { x: touch.clientX, y: touch.clientY };
			timer = setTimeout(() => {
				const point = map.mouseEventToContainerPoint({ clientX: startPoint.x, clientY: startPoint.y });
				const latlng = map.containerPointToLatLng(point);
				clear();
				triggerCommentCreateGesture(latlng);
			}, COMMENT_LONG_PRESS_MS);
		},
		{ passive: true },
	);

	container.addEventListener(
		'touchmove',
		(e) => {
			if (!startPoint || !timer) return;
			const touch = e.touches[0];
			const dx = touch.clientX - startPoint.x;
			const dy = touch.clientY - startPoint.y;
			if (Math.hypot(dx, dy) > COMMENT_LONG_PRESS_MOVE_TOLERANCE_PX) clear();
		},
		{ passive: true },
	);

	container.addEventListener('touchend', clear);
	container.addEventListener('touchcancel', clear);
})();

function buildCommentCategorySelectHTML(selectedCategory) {
	return COMMENT_CATEGORIES.map((c) => `<option value="${c.value}" ${c.value === selectedCategory ? 'selected' : ''}>${c.label}</option>`).join(
		'',
	);
}

function buildCommentColorPickerHTML(selectedColor) {
	return COMMENT_OTHER_PIN_COLORS.map(
		(color) => `
		<label class="comment-color-option">
			<input type="radio" name="comment-other-color" value="${color}" ${color === selectedColor ? 'checked' : ''}>
			<span class="comment-color-swatch" style="background:${color}"></span>
		</label>`,
	).join('');
}

function openCreateCommentPopup(latlng) {
	const popup = L.popup({ closeButton: true, maxWidth: 280 }).setLatLng(latlng);
	popup.setContent(buildCommentCreateContent(latlng, popup));
	popup.openOn(map);
}

function buildCommentCreateContent(latlng, popup) {
	const container = document.createElement('div');
	container.className = 'popup-content comment-edit';
	L.DomEvent.disableClickPropagation(container);

	const defaultCategory = COMMENT_CATEGORIES[0].value;
	container.innerHTML = `
		<div class="title">コメントを追加</div>
		<label class="comment-field">理由
			<select data-role="category-select">${buildCommentCategorySelectHTML(defaultCategory)}</select>
		</label>
		<div class="comment-color-picker" data-role="color-picker" style="display:${defaultCategory === 'other' ? 'flex' : 'none'};">
			${buildCommentColorPickerHTML(COMMENT_OTHER_PIN_COLORS[0])}
		</div>
		<label class="comment-field">メモ（任意）
			<textarea data-role="body-input" rows="3" placeholder="任意記入"></textarea>
		</label>
		<p class="error" data-role="comment-error"></p>
		<div class="actions">
			<button type="button" data-action="cancel">キャンセル</button>
			<button type="button" data-action="save">追加する</button>
		</div>
	`;

	const categorySelect = container.querySelector('[data-role="category-select"]');
	const colorPicker = container.querySelector('[data-role="color-picker"]');
	categorySelect.addEventListener('change', () => {
		colorPicker.style.display = categorySelect.value === 'other' ? 'flex' : 'none';
	});

	container.querySelector('[data-action="cancel"]').addEventListener('click', () => {
		popup.remove();
	});

	container.querySelector('[data-action="save"]').addEventListener('click', async () => {
		const errorEl = container.querySelector('[data-role="comment-error"]');
		const category = categorySelect.value;
		const colorInput = container.querySelector('input[name="comment-other-color"]:checked');
		const pinColor = category === 'other' ? (colorInput ? colorInput.value : COMMENT_OTHER_PIN_COLORS[0]) : undefined;
		const bodyText = container.querySelector('[data-role="body-input"]').value.trim();

		errorEl.textContent = '';
		const res = await apiFetch('/api/comments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ lat: latlng.lat, lng: latlng.lng, category, pin_color: pinColor, body: bodyText }),
		});
		const data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '追加に失敗しました';
			return;
		}

		state.comments.set(data.comment_id, data);
		renderCommentMarkers();
		popup.remove();
	});

	return container;
}

function buildCommentViewContent(comment, marker) {
	const container = document.createElement('div');
	container.className = 'popup-content comment-view';
	L.DomEvent.disableClickPropagation(container);

	container.innerHTML = `
		<div class="title">${escapeHtml(commentCategoryMeta(comment.category).label)}</div>
		${comment.body ? `<p class="comment-body">${escapeHtml(comment.body)}</p>` : ''}
		<div class="row"><span>登録:</span><span>${escapeHtml(comment.created_by_name)} / ${new Date(comment.created_at).toLocaleString('ja-JP')}</span></div>
		<div class="row"><span>最終更新:</span><span>${escapeHtml(comment.updated_by_name)} / ${new Date(comment.updated_at).toLocaleString('ja-JP')}</span></div>
		<div class="actions">
			<button type="button" data-action="delete">削除する</button>
			<button type="button" data-action="edit">編集する</button>
		</div>
	`;

	container.querySelector('[data-action="edit"]').addEventListener('click', () => {
		marker.setPopupContent(buildCommentEditContent(comment, marker));
		marker.getPopup().update();
	});

	container.querySelector('[data-action="delete"]').addEventListener('click', async () => {
		if (!confirm('このコメントを削除しますか？')) return;
		const res = await apiFetch(`/api/comments/${comment.comment_id}`, { method: 'DELETE' });
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			alert(data.error ?? '削除に失敗しました');
			return;
		}
		map.closePopup();
		state.comments.delete(comment.comment_id);
		renderCommentMarkers();
	});

	return container;
}

function buildCommentEditContent(comment, marker) {
	const container = document.createElement('div');
	container.className = 'popup-content comment-edit';
	L.DomEvent.disableClickPropagation(container);

	container.innerHTML = `
		<div class="title">コメントを編集</div>
		<label class="comment-field">理由
			<select data-role="category-select">${buildCommentCategorySelectHTML(comment.category)}</select>
		</label>
		<div class="comment-color-picker" data-role="color-picker" style="display:${comment.category === 'other' ? 'flex' : 'none'};">
			${buildCommentColorPickerHTML(comment.pin_color || COMMENT_OTHER_PIN_COLORS[0])}
		</div>
		<label class="comment-field">メモ（任意）
			<textarea data-role="body-input" rows="3" placeholder="任意記入">${escapeHtml(comment.body || '')}</textarea>
		</label>
		<p class="error" data-role="comment-error"></p>
		<div class="actions">
			<button type="button" data-action="cancel">キャンセル</button>
			<button type="button" data-action="save">更新する</button>
		</div>
	`;

	const categorySelect = container.querySelector('[data-role="category-select"]');
	const colorPicker = container.querySelector('[data-role="color-picker"]');
	categorySelect.addEventListener('change', () => {
		colorPicker.style.display = categorySelect.value === 'other' ? 'flex' : 'none';
	});

	container.querySelector('[data-action="cancel"]').addEventListener('click', () => {
		marker.setPopupContent(buildCommentViewContent(comment, marker));
		marker.getPopup().update();
	});

	container.querySelector('[data-action="save"]').addEventListener('click', async () => {
		const errorEl = container.querySelector('[data-role="comment-error"]');
		const category = categorySelect.value;
		const colorInput = container.querySelector('input[name="comment-other-color"]:checked');
		const pinColor = category === 'other' ? (colorInput ? colorInput.value : COMMENT_OTHER_PIN_COLORS[0]) : undefined;
		const bodyText = container.querySelector('[data-role="body-input"]').value.trim();

		errorEl.textContent = '';
		const res = await apiFetch(`/api/comments/${comment.comment_id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ category, pin_color: pinColor, body: bodyText }),
		});
		const data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '更新に失敗しました';
			return;
		}

		state.comments.set(data.comment_id, data);
		renderCommentMarkers();
		map.closePopup();
	});

	return container;
}

// ---- ポップアップ ----
// ポップアップ内のボタン/セレクト操作がクリックとして地図側に伝播すると、Leafletの
// 「ポップアップ外クリックで自動クローズ」機構が反応して閉じてしまうため、
// 生成した要素は必ず disableClickPropagation で地図への伝播を止める。

function openPopup(layer) {
	const areaId = layer.feature.properties.area_id;
	const row = state.termDataByAreaId.get(areaId);
	const content = row ? buildPopupContent(row, layer) : buildNoDataPopup(layer.feature.properties);
	layer.bindPopup(content).openPopup();
}

function buildNoDataPopup(props) {
	const div = document.createElement('div');
	div.className = 'popup-content';
	div.innerHTML = `<div class="title">${areaTitle(props)}</div>
		<p>選択中のタームにこのエリアのデータがありません。</p>`;
	L.DomEvent.disableClickPropagation(div);
	return div;
}

function buildPopupContent(row, layer) {
	const container = document.createElement('div');
	container.className = 'popup-content';
	L.DomEvent.disableClickPropagation(container);

	const isZeroHousehold = row.num_households === 0;
	const isNonTarget = !row.area_manager_id && !row.assignee_id;
	const canEditAreaManager = !state.viewOnly && !isZeroHousehold;
	const canEditAssignee = !state.viewOnly && !isZeroHousehold;
	const canRecordDistribution = !state.viewOnly && !isZeroHousehold && !isNonTarget;

	const areaHouseholds = areaHouseholdsFor(row);
	const areaDistributed = areaDistributedFor(row);
	const areaRateDisplay = (areaHouseholds > 0 ? (areaDistributed / areaHouseholds) * 100 : 0).toFixed(1);
	const areaBarWidth = Math.min(Number(areaRateDisplay), 100);

	const rateDisplay = row.distribution_rate.toFixed(1);
	const barWidth = Math.min(row.distribution_rate, 100);

	container.innerHTML = `
		<div class="title">${areaTitle(row)}</div>
		<div class="assignee-row">
			<span>エリア担当: ${row.area_manager_name || '未設定'}</span>
			${canEditAreaManager ? '<button type="button" data-action="edit-area-manager">変更する</button>' : ''}
		</div>
		${!isZeroHousehold && isNonTarget ? '<p class="zero-household-note">エリア担当・区画担当が未設定のため、配布記録の対象外です。区画担当の設定は可能です。</p>' : ''}
		<div class="assignee-row">
			<span>区画担当: ${row.assignee_name || '未担当'}</span>
			${canEditAssignee ? '<button type="button" data-action="edit-assignee">変更する</button>' : ''}
		</div>
		${isZeroHousehold ? '<p class="zero-household-note">世帯数が0のため、エリア担当設定・担当者設定・配布記録の対象外です。</p>' : ''}
		<div class="row"><span>エリア世帯数:</span><span>${areaHouseholds.toLocaleString('ja-JP')} 世帯</span></div>
		<div class="row"><span>区画世帯数:</span><span>${row.num_households.toLocaleString('ja-JP')} 世帯</span></div>
		<div class="row"><span>エリア累計配布:</span><span>${areaDistributed.toLocaleString('ja-JP')}世帯(${areaRateDisplay}%)</span></div>
		<div class="rate-bar-outer"><div class="rate-bar-inner" style="width:${areaBarWidth}%"></div></div>
		<div class="row"><span>区画累計配布:</span><span>${row.distributed_total.toLocaleString('ja-JP')}世帯(${rateDisplay}%)</span></div>
		<div class="rate-bar-outer"><div class="rate-bar-inner" style="width:${barWidth}%"></div></div>
		<div class="row"><span>最終更新:</span><span>${row.last_updated_at ? new Date(row.last_updated_at).toLocaleString('ja-JP') : '未記録'}</span></div>
	`;

	if (canRecordDistribution) {
		const form = document.createElement('div');
		form.className = 'record-form';
		form.innerHTML = `
			<label>今回の配布枚数:
				<input type="number" step="1" placeholder="枚数" data-role="delta-input">
			</label>
			<span class="hint">※ 負数を入力すると減算されます</span>
			<p class="recorded-by">記録者: ${session.user.name}（ログイン中ユーザー）</p>
			<p class="error" data-role="record-error"></p>
			<button type="button" data-action="submit-record">記録する</button>
		`;
		container.appendChild(form);

		form.querySelector('[data-action="submit-record"]').addEventListener('click', async () => {
			const input = form.querySelector('[data-role="delta-input"]');
			const errorEl = form.querySelector('[data-role="record-error"]');
			const delta = parseInt(input.value, 10);
			if (!Number.isFinite(delta) || delta === 0) {
				errorEl.textContent = '枚数を入力してください';
				return;
			}
			errorEl.textContent = '';
			const res = await apiFetch('/api/record', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ term_id: state.currentTermId, area_id: row.area_id, delta }),
			});
			const data = await res.json();
			if (!res.ok) {
				errorEl.textContent = data.error ?? '記録に失敗しました';
				return;
			}
			state.termDataByAreaId.set(row.area_id, data);
			redrawStyles();
			updateHeaderStats();
			layer.setPopupContent(buildPopupContent(data, layer));
			layer.getPopup().update();
		});
	}

	if (canEditAssignee) {
		const editButton = container.querySelector('[data-action="edit-assignee"]');
		editButton.addEventListener('click', () => {
			layer.setPopupContent(buildAssigneeEditContent(row, layer));
			layer.getPopup().update();
		});
	}

	if (canEditAreaManager) {
		const areaManagerEditButton = container.querySelector('[data-action="edit-area-manager"]');
		areaManagerEditButton.addEventListener('click', () => {
			layer.setPopupContent(buildAreaManagerEditContent(row, layer));
			layer.getPopup().update();
		});
	}

	return container;
}

function buildAreaManagerEditContent(row, layer) {
	const container = document.createElement('div');
	container.className = 'popup-content assignee-edit';
	L.DomEvent.disableClickPropagation(container);

	const options = ['<option value="">未設定</option>']
		.concat(state.activeUsers.map((u) => `<option value="${u.user_id}">${u.name}</option>`))
		.join('');

	container.innerHTML = `
		<div class="title">エリア担当を設定</div>
		<p class="hint">同じエリア(丁目)内の全区画に反映されます。担当者未設定の区画には担当者としても反映されます。</p>
		<select data-role="area-manager-select">${options}</select>
		<p class="error" data-role="area-manager-error"></p>
		<div class="actions">
			<button type="button" data-action="cancel">キャンセル</button>
			<button type="button" data-action="save">設定する</button>
		</div>
	`;
	container.querySelector('[data-role="area-manager-select"]').value = row.area_manager_id ?? '';

	container.querySelector('[data-action="cancel"]').addEventListener('click', () => {
		layer.setPopupContent(buildPopupContent(row, layer));
		layer.getPopup().update();
	});
	container.querySelector('[data-action="save"]').addEventListener('click', async () => {
		const select = container.querySelector('[data-role="area-manager-select"]');
		const errorEl = container.querySelector('[data-role="area-manager-error"]');
		const res = await apiFetch('/api/area-manager', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ area_id: row.area_id, area_manager_id: select.value || null }),
		});
		const data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '設定に失敗しました';
			return;
		}
		// 同一エリア内の複数区画が一括更新されるため、現タームのデータを丸ごと再取得して反映する
		await selectTerm(state.currentTermId);
		// エリア担当の設定完了直後に配布記入フォーム付きのポップアップが自動で開くと、
		// 意図せず配布実績を入力してしまいやすいため、ここではポップアップを閉じるだけにする(issue#11)。
		layer.closePopup();
	});

	return container;
}

function buildAssigneeEditContent(row, layer) {
	const container = document.createElement('div');
	container.className = 'popup-content assignee-edit';
	L.DomEvent.disableClickPropagation(container);

	const options = ['<option value="">未担当（塗りつぶしなし）</option>']
		.concat(state.activeUsers.map((u) => `<option value="${u.user_id}">${u.name}</option>`))
		.join('');

	container.innerHTML = `
		<div class="title">区画担当を設定</div>
		<select data-role="assignee-select">${options}</select>
		<p class="error" data-role="assignee-error"></p>
		<div class="actions">
			<button type="button" data-action="cancel">キャンセル</button>
			<button type="button" data-action="save">設定する</button>
		</div>
	`;
	container.querySelector('[data-role="assignee-select"]').value = row.assignee_id ?? '';

	container.querySelector('[data-action="cancel"]').addEventListener('click', () => {
		layer.setPopupContent(buildPopupContent(row, layer));
		layer.getPopup().update();
	});
	container.querySelector('[data-action="save"]').addEventListener('click', async () => {
		const select = container.querySelector('[data-role="assignee-select"]');
		const errorEl = container.querySelector('[data-role="assignee-error"]');
		const res = await apiFetch('/api/assignee', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ term_id: state.currentTermId, area_id: row.area_id, assignee_id: select.value || null }),
		});
		const data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '設定に失敗しました';
			return;
		}
		state.termDataByAreaId.set(row.area_id, data);
		redrawStyles();
		updateHeaderStats();
		layer.setPopupContent(buildPopupContent(data, layer));
		layer.getPopup().update();
	});

	return container;
}

// ---- ターム管理 ----

async function loadTerms() {
	const res = await apiFetch('/api/terms');
	state.terms = await res.json();

	const select = document.getElementById('term-select');
	select.innerHTML = '';
	for (const term of state.terms) {
		const option = document.createElement('option');
		option.value = String(term.term_id);
		option.textContent = `${term.term_name}${term.status === '進行中' ? '' : '（完了）'}`;
		select.appendChild(option);
	}

	if (state.terms.length === 0) return;

	const inProgress = state.terms.find((t) => t.status === '進行中');
	const defaultTerm = inProgress ?? state.terms[0];
	select.value = String(defaultTerm.term_id);
	await selectTerm(defaultTerm.term_id);
}

async function selectTerm(termId) {
	state.currentTermId = termId;
	const term = currentTerm();
	state.viewOnly = !term || term.status !== '進行中';
	document.getElementById('view-only-badge').classList.toggle('show', state.viewOnly);

	const res = await apiFetch(`/api/term-data?term_id=${termId}`);
	const rows = await res.json();
	state.termDataByAreaId = new Map(rows.map((r) => [r.area_id, r]));
	redrawStyles();
	updateHeaderStats();
}

document.getElementById('term-select').addEventListener('change', (e) => {
	map.closePopup();
	selectTerm(Number(e.target.value));
});

// ---- GPS ----

function stopGpsWatch() {
	if (state.watchId !== null) {
		navigator.geolocation.clearWatch(state.watchId);
		state.watchId = null;
	}
	gpsButton.classList.remove('active');
	if (state.gpsMarker) {
		map.removeLayer(state.gpsMarker);
		state.gpsMarker = null;
	}
}

const gpsButton = document.getElementById('gps-button');

function startGpsWatch() {
	if (!navigator.geolocation) {
		alert('この端末は位置情報に対応していません');
		return;
	}
	gpsButton.classList.add('active');
	let firstFix = true;
	state.watchId = navigator.geolocation.watchPosition(
		(pos) => {
			const latlng = [pos.coords.latitude, pos.coords.longitude];
			if (!state.gpsMarker) {
				state.gpsMarker = L.marker(latlng, {
					icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
				}).addTo(map);
			} else {
				state.gpsMarker.setLatLng(latlng);
			}
			if (firstFix) {
				map.setView(latlng, Math.max(map.getZoom(), 15));
				firstFix = false;
			}
		},
		() => {
			alert('現在地を取得できませんでした');
			stopGpsWatch();
		},
		{ enableHighAccuracy: true },
	);
}

gpsButton.addEventListener('click', () => {
	if (state.watchId !== null) {
		stopGpsWatch();
	} else {
		startGpsWatch();
	}
	saveUiState();
});

// ---- GPS軌跡記録 ----
// START/STOPで移動軌跡を記録する。位置取得はブラウザタブがフォアグラウンドでないと
// 継続できないため、記録中は画面ロックを防止するWake Lockを併用し、タブが非表示に
// なったら記録を自動停止する（フォアグラウンド前提を許容する運用判断）。
// 現在地表示（#gps-button）と同時にwatchPositionを二重に張らないよう、記録開始時は
// 現在地表示を止め、記録用watchPositionのコールバックでgpsMarkerも更新する。

const TRACK_FLUSH_INTERVAL_MS = 20000;
const TRACK_MAX_POINTS_PER_REQUEST = 200;

async function flushTrackBuffer() {
	if (state.trackId === null || state.trackBuffer.length === 0) return;
	const trackId = state.trackId;
	const toSend = state.trackBuffer.splice(0, TRACK_MAX_POINTS_PER_REQUEST);
	try {
		const res = await apiFetch(`/api/gps-tracks/${trackId}/points`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ points: toSend }),
		});
		if (!res.ok) {
			state.trackBuffer = toSend.concat(state.trackBuffer);
		}
	} catch {
		state.trackBuffer = toSend.concat(state.trackBuffer);
	}
}

const trackRecordButton = document.getElementById('track-record-button');

async function startTracking() {
	stopGpsWatch();
	if (!navigator.geolocation) {
		alert('この端末は位置情報に対応していません');
		return;
	}

	const res = await apiFetch('/api/gps-tracks/start', { method: 'POST' });
	const data = await res.json();
	if (!res.ok) {
		alert(data.error ?? '記録の開始に失敗しました');
		return;
	}

	state.trackId = data.track_id;
	state.trackBuffer = [];
	state.trackPolyline = L.polyline([], { color: TRACK_COLOR_TODAY, weight: 4 }).addTo(map);
	trackRecordButton.classList.add('active');
	gpsButton.disabled = true;

	if (navigator.wakeLock) {
		state.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
	}

	let firstFix = true;
	state.trackWatchId = navigator.geolocation.watchPosition(
		(pos) => {
			const latlng = [pos.coords.latitude, pos.coords.longitude];
			state.trackBuffer.push({
				lat: pos.coords.latitude,
				lng: pos.coords.longitude,
				recorded_at: new Date(pos.timestamp).toISOString(),
				accuracy: pos.coords.accuracy,
			});
			state.trackPolyline.addLatLng(latlng);
			if (!state.gpsMarker) {
				state.gpsMarker = L.marker(latlng, {
					icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
				}).addTo(map);
			} else {
				state.gpsMarker.setLatLng(latlng);
			}
			if (firstFix) {
				map.setView(latlng, Math.max(map.getZoom(), 15));
				firstFix = false;
			}
		},
		() => {
			alert('現在地を取得できませんでした');
			stopTracking();
		},
		{ enableHighAccuracy: true },
	);

	state.trackFlushTimer = setInterval(flushTrackBuffer, TRACK_FLUSH_INTERVAL_MS);
}

async function stopTracking() {
	if (state.trackId === null) return;
	const trackId = state.trackId;

	if (state.trackWatchId !== null) {
		navigator.geolocation.clearWatch(state.trackWatchId);
		state.trackWatchId = null;
	}
	if (state.trackFlushTimer !== null) {
		clearInterval(state.trackFlushTimer);
		state.trackFlushTimer = null;
	}
	// オフライン等で送信不能な場合の無限ループを避けるため試行回数に上限を設ける
	for (let attempts = 0; state.trackBuffer.length > 0 && attempts < 5; attempts++) {
		await flushTrackBuffer();
	}
	await apiFetch(`/api/gps-tracks/${trackId}/stop`, { method: 'POST' }).catch(() => {});
	state.trackId = null;

	if (state.wakeLock) {
		await state.wakeLock.release().catch(() => {});
		state.wakeLock = null;
	}
	if (state.gpsMarker) {
		map.removeLayer(state.gpsMarker);
		state.gpsMarker = null;
	}
	if (state.trackPolyline) {
		map.removeLayer(state.trackPolyline);
		liveTrackLayerGroup.addLayer(state.trackPolyline);
		if (!map.hasLayer(liveTrackLayerGroup)) liveTrackLayerGroup.addTo(map);
		state.trackPolyline = null;
	}
	trackRecordButton.classList.remove('active');
	gpsButton.disabled = false;
}

trackRecordButton.addEventListener('click', () => {
	if (state.trackId !== null) {
		stopTracking();
	} else {
		startTracking();
	}
});

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden' && state.trackId !== null) {
		stopTracking();
	}
});

// ---- メニュー ----

const menuButton = document.getElementById('menu-button');
const menuPanel = document.getElementById('menu-panel');
menuButton.addEventListener('click', () => menuPanel.classList.toggle('show'));
document.addEventListener('click', (e) => {
	if (!menuPanel.contains(e.target) && e.target !== menuButton) menuPanel.classList.remove('show');
});

document.getElementById('logout-button').addEventListener('click', () => {
	sessionStorage.removeItem(SESSION_KEY);
	location.href = '/login.html';
});

// ---- ヘッダの開閉 ----
// 三角マーク（.header-toggle-hint）のクリックのみで開閉する。Leafletは自分では
// コンテナサイズの変化を検知しないため、開閉後は必ずinvalidateSize()でタイル表示を再計算させる。

const header = document.getElementById('header');
document.querySelector('.header-toggle-hint').addEventListener('click', () => {
	header.classList.toggle('collapsed');
	requestAnimationFrame(() => map.invalidateSize());
});

// ---- 検索 ----
// ヘッダの🔍ボタンで検索欄を開閉する。入力中はシステム内データ（町丁目・投票所・コメント）を
// 通信なしで即時に絞り込み、Enter／検索ボタン押下時のみ外部API（国土地理院 住所検索・
// OpenStreetMap Nominatim）にも問い合わせる（Nominatimの利用規約で入力中の逐次問い合わせが
// 禁止されているため）。外部APIはどちらもAPIキー不要・CORS許可済みでブラウザから直接呼ぶ。

const GSI_ADDRESS_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const SEARCH_FOCUS_ZOOM = 17;
const SEARCH_LOCAL_RESULT_LIMIT = 20;

const searchButton = document.getElementById('search-button');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchResultsPanel = document.getElementById('search-results');
const searchResultLayer = L.layerGroup().addTo(map); // 検索でフォーカスした地点の一時的な強調表示
let searchSeq = 0; // 古い外部検索の応答で新しい結果を上書きしないための通し番号
let chomeSearchIndex = null;

const KANJI_DIGITS = { 〇: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };

/** 部分一致比較用の正規化。全角英数→半角、ヶ/ケの統一、漢数字→算用数字（「二丁目」と「2丁目」を
 *  一致させるため。「二俣川」→「2俣川」のように地名側も変換されるが、比較の両辺に同じ変換を
 *  かけるので一致判定には影響しない）、空白除去。 */
function normalizeQuery(str) {
	return String(str ?? '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[ヶヵ]/g, 'ケ')
		.replace(/[〇一二三四五六七八九]/g, (ch) => KANJI_DIGITS[ch])
		.replace(/\s+/g, '');
}

/** 町丁目名→範囲の索引。エリア境界レイヤーがある地域はその各ポリゴン、無い地域は区画の
 *  town/chomeごとに範囲を合成する。初回検索時に一度だけ作る。 */
function buildChomeSearchIndex() {
	const index = new Map();
	const source = chomeLayer ?? geoLayer;
	if (!source) return [];
	source.eachLayer((layer) => {
		const { town, chome } = layer.feature.properties;
		if (!town) return;
		const label = chome ? `${town}${chome}丁目` : town;
		const entry = index.get(label);
		if (entry) {
			entry.bounds.extend(layer.getBounds());
			entry.features.push(layer.feature);
		} else {
			// getBounds()はレイヤー内部の範囲オブジェクトそのものを返すため、extendで書き換えないよう複製する
			const b = layer.getBounds();
			index.set(label, { label, key: normalizeQuery(label), bounds: L.latLngBounds(b.getSouthWest(), b.getNorthEast()), features: [layer.feature] });
		}
	});
	return Array.from(index.values());
}

function searchLocal(query) {
	const q = normalizeQuery(query);
	if (!q) return [];
	chomeSearchIndex ??= buildChomeSearchIndex();
	const results = [];
	for (const entry of chomeSearchIndex) {
		if (entry.key.includes(q)) {
			results.push({ kind: '町丁目', title: entry.label, focus: () => focusChome(entry) });
		}
	}
	for (const s of state.pollingStations) {
		if (normalizeQuery(s.name).includes(q) || normalizeQuery(s.address).includes(q)) {
			results.push({ kind: '投票所', title: s.name, sub: s.address, focus: () => focusPollingStation(s) });
		}
	}
	for (const c of state.comments.values()) {
		if (c.body && normalizeQuery(c.body).includes(q)) {
			results.push({ kind: 'コメント', title: c.body.split('\n')[0], sub: commentCategoryMeta(c.category).label, focus: () => focusComment(c) });
		}
	}
	return results.slice(0, SEARCH_LOCAL_RESULT_LIMIT);
}

/** 外部検索の対象範囲＝この地域の区画全体（少し余白を持たせる）。地域ごとの設定は不要。 */
function searchBounds() {
	return (geoLayer ? geoLayer.getBounds() : map.getBounds()).pad(0.1);
}

async function searchGsi(query) {
	const bounds = searchBounds();
	const fetchOnce = async (q) => {
		const res = await fetch(`${GSI_ADDRESS_SEARCH_URL}?q=${encodeURIComponent(q)}`);
		if (!res.ok) throw new Error(`GSI ${res.status}`);
		const features = await res.json();
		return features
			.map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], title: f.properties.title }))
			// 部分一致しなかった場合に返る「神奈川県横浜市旭区」のような地域全体を指す結果は除外する
			.filter((r) => bounds.contains([r.lat, r.lng]) && !r.title.endsWith(REGION_DISPLAY_NAME));
	};
	// 地理院APIは「旭区役所」→「大阪市旭区」のように他地域も返すため範囲で絞り込む。市区名を省いた
	// 住所（「鶴ケ峰1-4-12」等）は範囲内の結果が出ないことがあるので、地域名を前置して1回だけ再試行する。
	let results = await fetchOnce(query);
	if (results.length === 0 && !query.includes(REGION_DISPLAY_NAME)) {
		results = await fetchOnce(`${REGION_DISPLAY_NAME}${query}`);
	}
	return results.map((r) => ({
		kind: '住所',
		title: r.title.replace(/^神奈川県/, ''),
		focus: () => focusPoint([r.lat, r.lng], r.title),
	}));
}

async function searchNominatim(query) {
	const b = searchBounds();
	const params = new URLSearchParams({
		q: query,
		format: 'jsonv2',
		countrycodes: 'jp',
		'accept-language': 'ja',
		limit: '8',
		bounded: '1',
		viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(','),
	});
	const res = await fetch(`${NOMINATIM_SEARCH_URL}?${params}`);
	if (!res.ok) throw new Error(`Nominatim ${res.status}`);
	const places = await res.json();
	return places.map((p) => {
		// display_nameは「施設名, 道路, 町丁目, …, 横浜市, 神奈川県, 郵便番号, 日本」の順なので、
		// 国・県・郵便番号を除いて逆順に並べ、「横浜市 旭区 鶴ケ峰 …」の住所風の補足にする。
		const parts = p.display_name.split(', ').filter((part) => !['日本', '神奈川県'].includes(part) && !/^\d{3}-\d{4}$/.test(part));
		const title = p.name || parts[0];
		const sub = parts.slice(1).reverse().join(' ');
		return { kind: '施設', title, sub, focus: () => focusPoint([Number(p.lat), Number(p.lon)], title) };
	});
}

function renderSearchResults(results, { message = '', showAttribution = false } = {}) {
	searchResultsPanel.innerHTML = '';
	for (const r of results) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'search-result';
		button.innerHTML = `<span class="search-kind">${escapeHtml(r.kind)}</span><span>${escapeHtml(r.title)}${r.sub ? `<span class="search-sub">${escapeHtml(r.sub)}</span>` : ''}</span>`;
		button.addEventListener('click', () => {
			hideSearchResults();
			searchInput.blur(); // スマホでソフトキーボードを閉じ、地図を見えるようにする
			r.focus();
		});
		searchResultsPanel.appendChild(button);
	}
	if (message) {
		const p = document.createElement('div');
		p.className = 'search-message';
		p.textContent = message;
		searchResultsPanel.appendChild(p);
	}
	if (showAttribution) {
		const p = document.createElement('div');
		p.className = 'search-attribution';
		p.textContent = '住所検索: 国土地理院 / 施設検索: © OpenStreetMap contributors';
		searchResultsPanel.appendChild(p);
	}
	searchResultsPanel.classList.toggle('show', searchResultsPanel.childElementCount > 0);
}

function hideSearchResults() {
	searchResultsPanel.classList.remove('show');
}

function focusPoint(latlng, title) {
	searchResultLayer.clearLayers();
	const marker = L.circleMarker(latlng, { radius: 10, color: '#dc2626', weight: 3, fillColor: '#dc2626', fillOpacity: 0.3 });
	marker.bindPopup(escapeHtml(title));
	searchResultLayer.addLayer(marker);
	map.setView(latlng, Math.max(map.getZoom(), SEARCH_FOCUS_ZOOM));
	marker.openPopup();
}

function focusChome(entry) {
	searchResultLayer.clearLayers();
	searchResultLayer.addLayer(
		L.geoJSON(entry.features, { interactive: false, style: { color: '#dc2626', weight: 4, dashArray: '8 6', fill: false } }),
	);
	map.fitBounds(entry.bounds);
}

function focusPollingStation(station) {
	searchResultLayer.clearLayers();
	// 投票所が非表示なら表示に切り替える（ヘッダのチェックボックスと状態を揃える）
	const toggle = document.getElementById('polling-station-toggle');
	if (!toggle.checked) {
		toggle.checked = true;
		pollingStationLayer.addTo(map);
		saveUiState();
	}
	const marker = pollingStationLayer.getLayers().find((m) => m.pollingStation === station);
	map.setView([station.lat, station.lng], Math.max(map.getZoom(), SEARCH_FOCUS_ZOOM));
	marker?.openPopup();
}

function focusComment(comment) {
	const marker = map.hasLayer(commentLayerGroup) ? commentLayerGroup.getLayers().find((m) => m.commentId === comment.comment_id) : null;
	if (!marker) {
		// フィルタで非表示のカテゴリは位置の強調表示のみ
		focusPoint([comment.lat, comment.lng], comment.body);
		return;
	}
	searchResultLayer.clearLayers();
	map.setView([comment.lat, comment.lng], Math.max(map.getZoom(), SEARCH_FOCUS_ZOOM));
	marker.openPopup();
}

searchButton.addEventListener('click', () => {
	const open = header.classList.toggle('search-open');
	if (open) {
		header.classList.remove('collapsed'); // 折りたたみ中は検索欄も隠れるため開く
		searchInput.focus();
	} else {
		hideSearchResults();
		searchResultLayer.clearLayers();
	}
	searchButton.classList.toggle('active', open);
	requestAnimationFrame(() => map.invalidateSize());
});

searchInput.addEventListener('input', () => {
	searchSeq++;
	const query = searchInput.value.trim();
	if (!query) {
		hideSearchResults();
		return;
	}
	const local = searchLocal(query);
	renderSearchResults(local, { message: local.length === 0 ? 'Enterで住所・施設を検索' : '' });
});

searchInput.addEventListener('focus', () => {
	if (searchInput.value.trim() && searchResultsPanel.childElementCount > 0) searchResultsPanel.classList.add('show');
});

searchForm.addEventListener('submit', async (e) => {
	e.preventDefault();
	const query = searchInput.value.trim();
	if (!query) return;
	const seq = ++searchSeq;
	const local = searchLocal(query);
	renderSearchResults(local, { message: '住所・施設を検索中…' });
	const [gsi, nominatim] = await Promise.allSettled([searchGsi(query), searchNominatim(query)]);
	if (seq !== searchSeq) return;
	const external = [...(gsi.status === 'fulfilled' ? gsi.value : []), ...(nominatim.status === 'fulfilled' ? nominatim.value : [])];
	const failed = gsi.status === 'rejected' || nominatim.status === 'rejected';
	const results = [...local, ...external];
	let message = '';
	if (results.length === 0) message = failed ? '見つかりませんでした（外部検索の一部が失敗しました）' : '見つかりませんでした';
	else if (failed) message = '外部検索の一部が失敗しました';
	renderSearchResults(results, { message, showAttribution: true });
});

document.addEventListener('click', (e) => {
	if (!searchResultsPanel.contains(e.target) && !searchForm.contains(e.target)) hideSearchResults();
});

const newTermButton = document.getElementById('new-term-button');
if (session.user.role === '管理者') {
	newTermButton.style.display = 'block';
	document.getElementById('users-link').style.display = 'block';
	document.getElementById('polling-stations-link').style.display = 'block';
	document.getElementById('data-clear-link').style.display = 'block';
	newTermButton.addEventListener('click', () => {
		menuPanel.classList.remove('show');
		openNewTermModal();
	});
}

// ---- 新ターム開始モーダル ----

const newTermModal = document.getElementById('new-term-modal');
const newTermNameInput = document.getElementById('new-term-name-input');
const newTermInheritList = document.getElementById('new-term-inherit-list');
const newTermError = document.getElementById('new-term-error');

function openNewTermModal() {
	newTermNameInput.value = '';
	newTermError.textContent = '';

	newTermInheritList.innerHTML = '';
	const noneOption = document.createElement('label');
	noneOption.className = 'inherit-option';
	noneOption.innerHTML = '<input type="radio" name="inherit-term" value="" checked> 継承しない';
	newTermInheritList.appendChild(noneOption);

	for (const term of state.terms) {
		const option = document.createElement('label');
		option.className = 'inherit-option';
		const label = `${term.term_name}${term.status === '進行中' ? '' : '（完了）'}`;
		option.innerHTML = `<input type="radio" name="inherit-term" value="${term.term_id}"> ${label}`;
		newTermInheritList.appendChild(option);
	}

	newTermModal.classList.add('show');
	newTermNameInput.focus();
}

function closeNewTermModal() {
	newTermModal.classList.remove('show');
}

document.getElementById('new-term-cancel').addEventListener('click', closeNewTermModal);

document.getElementById('new-term-submit').addEventListener('click', async () => {
	const termName = newTermNameInput.value.trim();
	if (!termName) {
		newTermError.textContent = 'タームの名称を入力してください';
		return;
	}
	const selected = newTermInheritList.querySelector('input[name="inherit-term"]:checked');
	const inheritFromTermId = selected && selected.value ? Number(selected.value) : null;

	const res = await apiFetch('/api/term/new', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ term_name: termName, inherit_from_term_id: inheritFromTermId }),
	});
	const data = await res.json();
	if (!res.ok) {
		newTermError.textContent = data.error ?? '新タームの開始に失敗しました';
		return;
	}
	closeNewTermModal();
	await loadTerms();
});

// ---- 軌跡照会 ----
// 記録済みのGPS軌跡（gps_tracks/gps_track_points）を日付範囲で照会し、地図に重ね描きする。
// 一般ユーザーは自分の軌跡のみ、管理者は全員分または特定ユーザーを選んで閲覧できる
// （権限の判定はサーバー側 GET /api/gps-tracks 内で行っており、フロントのユーザー選択欄は
// 管理者にのみ表示する）。

// 全ユーザー共通で、当日／前日以前の2色のみで色分けする（ユーザーごとの色分けはしない）。
// 当日色は記録中のリアルタイム描画（startTracking）でも同じ色を使う。
const TRACK_COLOR_TODAY = '#22c55e';
const TRACK_COLOR_PAST = '#fb923c';

// UTCのISO日時からJST（この機能の利用地域、夏時間なし固定+9:00）のカレンダー日文字列を得る。
function jstDateString(date) {
	return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function colorForTrack(startedAt) {
	return jstDateString(new Date(startedAt)) === jstDateString(new Date()) ? TRACK_COLOR_TODAY : TRACK_COLOR_PAST;
}

const trackQueryModal = document.getElementById('track-query-modal');
const trackQueryFromInput = document.getElementById('track-query-from');
const trackQueryToInput = document.getElementById('track-query-to');
const trackQueryUserField = document.getElementById('track-query-user-field');
const trackQueryUserSelect = document.getElementById('track-query-user-select');
const trackQueryDuration = document.getElementById('track-query-duration');
const trackQueryError = document.getElementById('track-query-error');

// 対象ユーザーselectの選択肢を構築する。モーダルを開くときと、保存済み状態からの
// 軌跡表示復元（init()）の両方から呼ぶ。
function populateTrackQueryUserSelect() {
	if (session.user.role === '管理者') {
		trackQueryUserField.style.display = 'block';
		trackQueryUserSelect.innerHTML =
			'<option value="">(全員)</option>' + state.activeUsers.map((u) => `<option value="${u.user_id}">${escapeHtml(u.name)}</option>`).join('');
	} else {
		trackQueryUserField.style.display = 'none';
	}
}

function openTrackQueryModal() {
	trackQueryError.textContent = '';
	if (!trackQueryFromInput.value) {
		const today = new Date().toISOString().slice(0, 10);
		trackQueryFromInput.value = currentTerm()?.start_date ?? today;
		trackQueryToInput.value = today;
	}
	populateTrackQueryUserSelect();
	trackQueryModal.classList.add('show');
	updateTrackDuration();
}

function closeTrackQueryModal() {
	trackQueryModal.classList.remove('show');
}

// from/toとuser選択に応じてtrack一覧を取得する共通処理。「表示」ボタンでの地図描画と、
// 日付/ユーザー変更のたびの累積時間再計算の両方から呼ばれる。summary:trueのときは座標点を
// 含まない軽量レスポンスを要求する（累積時間の計算にのみ使う場合、期間全体の座標点を
// 毎回まるごと取得すると参加人数・記録期間次第でレスポンスが巨大になるため）。
async function fetchTracksForRange({ summary = false } = {}) {
	const from = trackQueryFromInput.value;
	const to = trackQueryToInput.value;
	if (!from || !to) return null;

	const params = new URLSearchParams({ from, to });
	if (session.user.role === '管理者' && trackQueryUserSelect.value) {
		params.set('user_id', trackQueryUserSelect.value);
	}
	if (summary) params.set('summary', '1');
	const res = await apiFetch(`/api/gps-tracks?${params.toString()}`);
	const data = await res.json();
	if (!res.ok) {
		return { error: data.error ?? '照会に失敗しました' };
	}
	return { tracks: data.tracks };
}

function formatDuration(totalSeconds) {
	const totalMinutes = Math.round(totalSeconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}分`;
	return `${hours}時間${minutes}分`;
}

function formatDistance(totalMeters) {
	if (totalMeters < 1000) return `${Math.round(totalMeters)}m`;
	return `${(totalMeters / 1000).toFixed(1)}km`;
}

async function updateTrackDuration() {
	const result = await fetchTracksForRange({ summary: true });
	if (!result || result.error) {
		trackQueryDuration.textContent = '';
		return;
	}
	const totalSeconds = result.tracks.reduce((sum, t) => sum + (t.duration_seconds ?? 0), 0);
	const totalMeters = result.tracks.reduce((sum, t) => sum + (t.distance_meters ?? 0), 0);
	trackQueryDuration.textContent = `記録累計時間: ${formatDuration(totalSeconds)} / 移動距離: ${formatDistance(totalMeters)}`;
}

trackQueryFromInput.addEventListener('change', updateTrackDuration);
trackQueryToInput.addEventListener('change', updateTrackDuration);
trackQueryUserSelect.addEventListener('change', updateTrackDuration);

document.getElementById('track-query-button').addEventListener('click', () => {
	menuPanel.classList.remove('show');
	openTrackQueryModal();
});
document.getElementById('track-query-close').addEventListener('click', closeTrackQueryModal);

// 軌跡照会の結果をtrackQueryLayerGroupへ描画する。「表示」ボタン押下時と、メニュー内リンクへの
// 遷移から地図に戻った際の復元（init()）の両方から呼ばれる。
function renderTrackResults(tracks) {
	trackQueryLayerGroup.clearLayers();
	for (const track of tracks) {
		if (track.points.length === 0) continue;
		const latlngs = track.points.map((p) => [p.lat, p.lng]);
		const polyline = L.polyline(latlngs, { color: colorForTrack(track.started_at), weight: 4 });
		const popup = document.createElement('div');
		popup.className = 'popup-content';
		popup.innerHTML = `
			<div class="title">${escapeHtml(track.user_name)}</div>
			<div class="row"><span>開始:</span><span>${new Date(track.started_at).toLocaleString('ja-JP')}</span></div>
			<div class="row"><span>終了:</span><span>${track.ended_at ? new Date(track.ended_at).toLocaleString('ja-JP') : '記録中'}</span></div>
		`;
		polyline.bindPopup(popup);
		trackQueryLayerGroup.addLayer(polyline);
	}
	if (!map.hasLayer(trackQueryLayerGroup)) trackQueryLayerGroup.addTo(map);
}

document.getElementById('track-query-clear').addEventListener('click', () => {
	trackQueryLayerGroup.clearLayers();
	if (map.hasLayer(trackQueryLayerGroup)) map.removeLayer(trackQueryLayerGroup);
	liveTrackLayerGroup.clearLayers();
	if (map.hasLayer(liveTrackLayerGroup)) map.removeLayer(liveTrackLayerGroup);
	saveUiState();
	closeTrackQueryModal();
});

document.getElementById('track-query-show').addEventListener('click', async () => {
	if (!trackQueryFromInput.value || !trackQueryToInput.value) {
		trackQueryError.textContent = '開始日・終了日を指定してください';
		return;
	}
	trackQueryError.textContent = '';

	const result = await fetchTracksForRange();
	if (result.error) {
		trackQueryError.textContent = result.error;
		return;
	}

	renderTrackResults(result.tracks);
	saveUiState();
	closeTrackQueryModal();
});

// ---- 初期化 ----

async function init() {
	const usersRes = await fetch('/api/users/active');
	state.activeUsers = await usersRes.json();
	populateAssigneeFilterSelect();
	populateCommentFilterCheckboxes();
	restoreTrackQueryDisplay();
	await loadBoundary();
	if (typeof CHOME_BOUNDARY_GEOJSON_PATH !== 'undefined') {
		await loadChomeBoundary();
	}
	await loadPollingStations();
	// デフォルトは表示。保存済み状態（バーガーメニュー内リンクへ遷移して戻った場合等）があればそれを復元する。
	const pollingStationToggle = document.getElementById('polling-station-toggle');
	pollingStationToggle.checked = savedUiState ? savedUiState.pollingStationVisible : true;
	if (pollingStationToggle.checked) pollingStationLayer.addTo(map);

	await loadComments();
	await loadTerms();

	if (savedUiState?.gpsActive) {
		startGpsWatch();
	}
}

// 軌跡照会で「表示」した状態は、バーガーメニュー内リンクへの遷移から地図に戻った際にも
// 維持する（フルページ遷移でJS状態は失われるため、保存済みパラメータで取得し直す）。
// init()の他の逐次処理を待たせないよう、独立して（awaitせず）呼び出す。
async function restoreTrackQueryDisplay() {
	if (!savedUiState?.trackQueryVisible) return;
	trackQueryFromInput.value = savedUiState.trackQueryFrom ?? '';
	trackQueryToInput.value = savedUiState.trackQueryTo ?? '';
	populateTrackQueryUserSelect();
	trackQueryUserSelect.value = savedUiState.trackQueryUserId ?? '';
	const result = await fetchTracksForRange();
	if (result && !result.error) {
		renderTrackResults(result.tracks);
	}
}

init();
