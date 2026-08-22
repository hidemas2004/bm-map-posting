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

function addCell(row, text, tag) {
	const cell = document.createElement(tag);
	cell.textContent = text;
	row.appendChild(cell);
}

function buildRow(row) {
	const tr = document.createElement('tr');
	addCell(tr, row.user_name, 'td');
	addCell(tr, `${row.distributed_total}枚`, 'td');
	addCell(tr, formatDuration(row.duration_seconds), 'td');
	addCell(tr, formatDistance(row.distance_meters), 'td');
	return tr;
}

async function loadSummary() {
	const from = document.getElementById('summary-from').value;
	const to = document.getElementById('summary-to').value;
	if (!from || !to) return;

	const res = await apiFetch(`/api/history-summary?from=${from}&to=${to}`);
	const data = await res.json();
	const tbody = document.getElementById('summary-tbody');
	const tfoot = document.getElementById('summary-tfoot');
	tbody.innerHTML = '';
	tfoot.innerHTML = '';

	if (!res.ok) {
		tbody.innerHTML = `<tr><td colspan="4" class="empty-row">${data.error ?? '取得に失敗しました'}</td></tr>`;
		return;
	}

	if (data.rows.length === 0) {
		tbody.innerHTML = '<tr><td colspan="4" class="empty-row">対象データがありません</td></tr>';
		return;
	}

	for (const row of data.rows) {
		tbody.appendChild(buildRow(row));
	}

	const totalRow = document.createElement('tr');
	addCell(totalRow, '全体合計', 'td');
	addCell(totalRow, `${data.total.distributed_total}枚`, 'td');
	addCell(totalRow, formatDuration(data.total.duration_seconds), 'td');
	addCell(totalRow, formatDistance(data.total.distance_meters), 'td');
	tfoot.appendChild(totalRow);
}

document.getElementById('summary-from').addEventListener('change', loadSummary);
document.getElementById('summary-to').addEventListener('change', loadSummary);

function init() {
	const today = new Date().toISOString().slice(0, 10);
	document.getElementById('summary-from').value = today;
	document.getElementById('summary-to').value = today;
	loadSummary();
}
init();
