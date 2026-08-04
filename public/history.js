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

function areaLabel(row) {
	let label = row.city;
	if (row.ward) label += ` ${row.ward}`;
	if (row.town) label += ` ${row.town}`;
	if (row.chome) label += `${row.chome}丁目`;
	if (row.block) label += ` ${row.block}区画`;
	return label;
}

const FROZEN_COL_COUNT = 1; // 記録日時のみ列固定

function addCell(row, text, tag, className) {
	const cell = document.createElement(tag);
	cell.textContent = text;
	if (className) cell.className = className;
	row.appendChild(cell);
}

function buildLogRow(row) {
	const tr = document.createElement('tr');
	const deltaClass = row.delta > 0 ? 'delta-plus' : row.delta < 0 ? 'delta-minus' : '';
	const deltaText = row.delta > 0 ? `+${row.delta}` : String(row.delta);
	addCell(tr, new Date(row.updated_at).toLocaleString('ja-JP'), 'td');
	addCell(tr, row.term_name, 'td');
	addCell(tr, areaLabel(row), 'td');
	addCell(tr, row.user_name, 'td');
	addCell(tr, deltaText, 'td', deltaClass);
	return tr;
}

/**
 * 先頭N列を横スクロール時も固定表示する。テーブルは列ごとに幅が揃う（table auto layout）ため、
 * ヘッダ行のセル幅を測定すればそのままボディ側の同じ列にも使い回せる。
 */
function applyStickyColumns(table, frozenCount) {
	const headerCells = table.querySelectorAll('thead tr th');
	const lefts = [];
	let cumulativeLeft = 0;
	for (let i = 0; i < frozenCount && i < headerCells.length; i++) {
		lefts.push(cumulativeLeft);
		cumulativeLeft += headerCells[i].getBoundingClientRect().width;
	}
	for (const row of table.querySelectorAll('tr')) {
		const cells = row.children;
		for (let i = 0; i < frozenCount && i < cells.length; i++) {
			cells[i].classList.add('sticky-col');
			cells[i].style.left = `${lefts[i]}px`;
			if (i === frozenCount - 1) cells[i].classList.add('sticky-col-edge');
		}
	}
}

function currentQuery() {
	const termId = document.getElementById('term-filter').value;
	return termId ? `?term_id=${termId}` : '';
}

async function loadTermFilter() {
	const select = document.getElementById('term-filter');
	const res = await apiFetch('/api/terms');
	const terms = await res.json();
	select.innerHTML = '<option value="">すべてのターム</option>';
	for (const term of terms) {
		const option = document.createElement('option');
		option.value = String(term.term_id);
		option.textContent = `${term.term_name}${term.status === '進行中' ? '' : '（完了）'}`;
		select.appendChild(option);
	}
	const inProgress = terms.find((t) => t.status === '進行中');
	if (inProgress) select.value = String(inProgress.term_id);
}

async function loadLog() {
	const res = await apiFetch(`/api/activity-log${currentQuery()}`);
	const rows = await res.json();
	const tbody = document.getElementById('log-tbody');
	tbody.innerHTML = '';

	if (rows.length === 0) {
		tbody.innerHTML = '<tr><td colspan="5" class="empty-row">記録がありません</td></tr>';
		return;
	}

	for (const row of rows) {
		tbody.appendChild(buildLogRow(row));
	}

	applyStickyColumns(document.querySelector('.data-table'), FROZEN_COL_COUNT);
}

document.getElementById('term-filter').addEventListener('change', loadLog);

document.getElementById('csv-download-button').addEventListener('click', async () => {
	const res = await apiFetch(`/api/activity-log/export${currentQuery()}`);
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'activity_log.csv';
	a.click();
	URL.revokeObjectURL(url);
});

async function init() {
	await loadTermFilter();
	await loadLog();
}
init();
