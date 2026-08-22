const SESSION_KEY = 'bm_posting_session';

const sessionRaw = sessionStorage.getItem(SESSION_KEY);
if (!sessionRaw) {
	location.href = '/login.html';
	throw new Error('not authenticated');
}
const session = JSON.parse(sessionRaw);

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

const BASE_HEADERS = ['町丁目', '区画', 'エリア担当', '担当', '世帯数', '配布数', '配布率'];
const FROZEN_COL_COUNT = 2; // 町丁目・区画を列固定

/**
 * 先頭N列を横スクロール時も固定表示する。テーブルは列ごとに幅が揃う（table auto layout）ため、
 * ヘッダ行のセル幅を測定すればそのままボディ側の同じ列にも使い回せる。
 * ヘッダーからのオフセット計算（重い処理ではないが、行ごとに再計算する必要はない）と、
 * 個々の行への適用を分離し、バッチ描画の各回では後者だけを新規行に対して行う。
 */
function computeStickyColumnLefts(table, frozenCount) {
	const headerCells = table.querySelectorAll('thead tr th');
	const lefts = [];
	let cumulativeLeft = 0;
	for (let i = 0; i < frozenCount && i < headerCells.length; i++) {
		lefts.push(cumulativeLeft);
		cumulativeLeft += headerCells[i].getBoundingClientRect().width;
	}
	return lefts;
}

function applyStickyColumnsToRows(rows, lefts, frozenCount) {
	for (const row of rows) {
		const cells = row.children;
		for (let i = 0; i < frozenCount && i < cells.length; i++) {
			cells[i].classList.add('sticky-col');
			cells[i].style.left = `${lefts[i]}px`;
			if (i === frozenCount - 1) cells[i].classList.add('sticky-col-edge');
		}
	}
}

function addCell(row, text, tag) {
	const cell = document.createElement(tag);
	cell.textContent = text;
	row.appendChild(cell);
}

function buildHeaderRow() {
	const tr = document.createElement('tr');
	for (const label of BASE_HEADERS) addCell(tr, label, 'th');
	return tr;
}

function buildDataRow(area) {
	const tr = document.createElement('tr');
	const townChome = `${area.town}${area.chome ? `${area.chome}丁目` : ''}`;
	addCell(tr, townChome, 'td');
	addCell(tr, area.block, 'td');
	addCell(tr, area.area_manager_name, 'td');
	addCell(tr, area.assignee_name, 'td');
	addCell(tr, area.num_households.toLocaleString('ja-JP'), 'td');
	addCell(tr, area.distributed_total.toLocaleString('ja-JP'), 'td');
	addCell(tr, `${area.distribution_rate.toFixed(1)}%`, 'td');
	return tr;
}

// 地域数が数千件規模になり得るため、一度に全行をDOM構築すると初期表示が遅く、
// sticky-colの要素数も多くなりスクロールが重くなる。スクロールに応じてバッチで
// 追加描画する（無限スクロール方式）。
const AREAS_RENDER_BATCH_SIZE = 200;
const AREAS_RENDER_THRESHOLD_PX = 300;

async function loadAreas() {
	const res = await apiFetch('/api/areas/with-terms');
	const { areas } = await res.json();

	const thead = document.getElementById('areas-thead');
	thead.innerHTML = '';
	thead.appendChild(buildHeaderRow());

	const tbody = document.getElementById('areas-tbody');
	tbody.innerHTML = '';
	document.getElementById('area-count').textContent = `${areas.length}件`;

	const wrap = document.querySelector('.data-table-wrap');
	wrap.onscroll = null;

	if (areas.length === 0) {
		const tr = document.createElement('tr');
		const td = document.createElement('td');
		td.className = 'empty-row';
		td.colSpan = BASE_HEADERS.length;
		td.textContent = '地域データがありません';
		tr.appendChild(td);
		tbody.appendChild(tr);
		return;
	}

	const table = document.querySelector('.data-table');
	const stickyLefts = computeStickyColumnLefts(table, FROZEN_COL_COUNT);
	let renderedCount = 0;

	function renderNextBatch() {
		if (renderedCount >= areas.length) return;
		const end = Math.min(renderedCount + AREAS_RENDER_BATCH_SIZE, areas.length);
		const fragment = document.createDocumentFragment();
		const newRows = [];
		for (let i = renderedCount; i < end; i++) {
			const row = buildDataRow(areas[i]);
			fragment.appendChild(row);
			newRows.push(row);
		}
		tbody.appendChild(fragment);
		applyStickyColumnsToRows(newRows, stickyLefts, FROZEN_COL_COUNT);
		renderedCount = end;
	}

	renderNextBatch();
	wrap.onscroll = () => {
		if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - AREAS_RENDER_THRESHOLD_PX) {
			renderNextBatch();
		}
	};
}

document.getElementById('csv-download-button').addEventListener('click', async () => {
	const res = await apiFetch('/api/areas/export');
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'areas.csv';
	a.click();
	URL.revokeObjectURL(url);
});

loadAreas();
