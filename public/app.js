const SESSION_KEY = 'bm_posting_session';
const MAP_VIEW_FILTER = '__map_view__'; // 担当者フィルタの特殊値。選択時は全区画を境界線のみ（塗りつぶしなし）で表示する。

const sessionRaw = sessionStorage.getItem(SESSION_KEY);
if (!sessionRaw) {
	location.href = '/login.html';
	throw new Error('not authenticated');
}
const session = JSON.parse(sessionRaw);

const state = {
	terms: [],
	currentTermId: null,
	viewOnly: false,
	termDataByAreaId: new Map(),
	activeUsers: [],
	watchId: null,
	gpsMarker: null,
	assigneeFilter: '', // ''=全体表示、それ以外はuser_id
	comments: new Map(), // comment_id -> comment（issue#24。全ターム共通データなのでterm切替の影響を受けない）
	commentFilter: 'none', // 'none'=表示しない/'all'=全て表示/カテゴリ値
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

const map = L.map('map').setView(MAP_INITIAL_CENTER, MAP_INITIAL_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

let geoLayer = null;
let chomeLayer = null;
let pollingStationLayer = null;
const commentLayerGroup = L.layerGroup();

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

async function loadBoundary() {
	const res = await fetch(BOUNDARY_GEOJSON_PATH);
	const geojson = await res.json();
	geoLayer = L.geoJSON(geojson, {
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
		return L.marker([s.lat, s.lng], {
			icon: L.divIcon({
				className: '',
				html: `<div class="polling-station-pin" style="background:${POLLING_STATION_PIN_COLOR}"></div>`,
				iconSize: [22, 22],
				iconAnchor: [11, 22],
			}),
		}).bindPopup(popup);
	});
	pollingStationLayer = L.layerGroup(markers);
}

document.getElementById('polling-station-toggle').addEventListener('change', (e) => {
	if (e.target.checked) {
		pollingStationLayer.addTo(map);
	} else {
		map.removeLayer(pollingStationLayer);
	}
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

function commentIconFor(comment) {
	return L.divIcon({
		className: '',
		html: `<div class="comment-pin" style="background:${commentPinColorFor(comment)}"></div>`,
		iconSize: [22, 22],
		iconAnchor: [11, 22],
	});
}

function renderCommentMarkers() {
	commentLayerGroup.clearLayers();
	if (state.commentFilter === 'none') {
		if (map.hasLayer(commentLayerGroup)) map.removeLayer(commentLayerGroup);
		return;
	}
	for (const comment of state.comments.values()) {
		if (state.commentFilter !== 'all' && comment.category !== state.commentFilter) continue;
		const marker = L.marker([comment.lat, comment.lng], { icon: commentIconFor(comment) });
		marker.on('click', () => openCommentPopup(comment, marker));
		commentLayerGroup.addLayer(marker);
	}
	if (!map.hasLayer(commentLayerGroup)) commentLayerGroup.addTo(map);
}

function populateCommentFilterSelect() {
	const select = document.getElementById('comment-filter');
	select.innerHTML = '';
	const options = [
		{ value: 'none', label: 'コメント: 表示しない' },
		{ value: 'all', label: 'コメント: 全て表示' },
		...COMMENT_CATEGORIES.map((c) => ({ value: c.value, label: `コメント: ${c.label}` })),
	];
	for (const opt of options) {
		const option = document.createElement('option');
		option.value = opt.value;
		option.textContent = opt.label;
		select.appendChild(option);
	}
	select.value = state.commentFilter;
}

document.getElementById('comment-filter').addEventListener('change', (e) => {
	state.commentFilter = e.target.value;
	renderCommentMarkers();
});

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
		<label class="comment-field">画像（任意）
			<input type="file" accept="image/*" capture="environment" data-role="image-input">
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
		const imageInput = container.querySelector('[data-role="image-input"]');
		const file = imageInput.files[0];

		errorEl.textContent = '';
		const res = await apiFetch('/api/comments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ lat: latlng.lat, lng: latlng.lng, category, pin_color: pinColor, body: bodyText }),
		});
		let data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '追加に失敗しました';
			return;
		}

		if (file) {
			const uploadRes = await apiFetch(`/api/comments/${data.comment_id}/image`, {
				method: 'POST',
				headers: { 'Content-Type': file.type },
				body: file,
			});
			if (uploadRes.ok) {
				data = await uploadRes.json();
			}
		}

		state.comments.set(data.comment_id, data);
		renderCommentMarkers();
		popup.remove();
	});

	return container;
}

function openCommentPopup(comment, marker) {
	marker.bindPopup(buildCommentViewContent(comment, marker)).openPopup();
}

function buildCommentViewContent(comment, marker) {
	const container = document.createElement('div');
	container.className = 'popup-content comment-view';
	L.DomEvent.disableClickPropagation(container);

	container.innerHTML = `
		<div class="title">${escapeHtml(commentCategoryMeta(comment.category).label)}</div>
		${comment.body ? `<p class="comment-body">${escapeHtml(comment.body)}</p>` : ''}
		${comment.has_image ? '<img class="comment-image" data-role="comment-image" alt="添付画像">' : ''}
		<div class="row"><span>登録:</span><span>${escapeHtml(comment.created_by_name)} / ${new Date(comment.created_at).toLocaleString('ja-JP')}</span></div>
		<div class="row"><span>最終更新:</span><span>${escapeHtml(comment.updated_by_name)} / ${new Date(comment.updated_at).toLocaleString('ja-JP')}</span></div>
		<div class="actions">
			<button type="button" data-action="delete">削除する</button>
			<button type="button" data-action="edit">編集する</button>
		</div>
	`;

	if (comment.has_image) {
		const img = container.querySelector('[data-role="comment-image"]');
		apiFetch(`/api/comments/${comment.comment_id}/image`).then(async (res) => {
			if (!res.ok) return;
			const blob = await res.blob();
			img.src = URL.createObjectURL(blob);
		});
	}

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
		<label class="comment-field">画像（任意）
			<input type="file" accept="image/*" capture="environment" data-role="image-input">
		</label>
		${comment.has_image ? '<button type="button" class="comment-remove-image" data-action="remove-image">添付画像を削除</button>' : ''}
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

	if (comment.has_image) {
		container.querySelector('[data-action="remove-image"]').addEventListener('click', async () => {
			const res = await apiFetch(`/api/comments/${comment.comment_id}/image`, { method: 'DELETE' });
			if (!res.ok) return;
			const data = await res.json();
			state.comments.set(data.comment_id, data);
			renderCommentMarkers();
			map.closePopup();
		});
	}

	container.querySelector('[data-action="save"]').addEventListener('click', async () => {
		const errorEl = container.querySelector('[data-role="comment-error"]');
		const category = categorySelect.value;
		const colorInput = container.querySelector('input[name="comment-other-color"]:checked');
		const pinColor = category === 'other' ? (colorInput ? colorInput.value : COMMENT_OTHER_PIN_COLORS[0]) : undefined;
		const bodyText = container.querySelector('[data-role="body-input"]').value.trim();
		const imageInput = container.querySelector('[data-role="image-input"]');
		const file = imageInput.files[0];

		errorEl.textContent = '';
		const res = await apiFetch(`/api/comments/${comment.comment_id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ category, pin_color: pinColor, body: bodyText }),
		});
		let data = await res.json();
		if (!res.ok) {
			errorEl.textContent = data.error ?? '更新に失敗しました';
			return;
		}

		if (file) {
			const uploadRes = await apiFetch(`/api/comments/${comment.comment_id}/image`, {
				method: 'POST',
				headers: { 'Content-Type': file.type },
				body: file,
			});
			if (uploadRes.ok) {
				data = await uploadRes.json();
			}
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

const gpsButton = document.getElementById('gps-button');
gpsButton.addEventListener('click', () => {
	if (state.watchId !== null) {
		navigator.geolocation.clearWatch(state.watchId);
		state.watchId = null;
		gpsButton.classList.remove('active');
		if (state.gpsMarker) {
			map.removeLayer(state.gpsMarker);
			state.gpsMarker = null;
		}
		return;
	}
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
			gpsButton.classList.remove('active');
			state.watchId = null;
		},
		{ enableHighAccuracy: true },
	);
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

// ---- 初期化 ----

async function init() {
	const usersRes = await fetch('/api/users/active');
	state.activeUsers = await usersRes.json();
	populateAssigneeFilterSelect();
	populateCommentFilterSelect();
	await loadBoundary();
	if (typeof CHOME_BOUNDARY_GEOJSON_PATH !== 'undefined') {
		await loadChomeBoundary();
	}
	await loadPollingStations();
	await loadComments();
	await loadTerms();
}

init();
