const SESSION_KEY = 'bm_posting_session';

const sessionRaw = sessionStorage.getItem(SESSION_KEY);
if (!sessionRaw) {
	location.href = '/login.html';
	throw new Error('not authenticated');
}
const session = JSON.parse(sessionRaw);
if (session.user.role !== '管理者') {
	location.href = '/';
	throw new Error('forbidden');
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

function addCell(row, text) {
	const cell = document.createElement('td');
	cell.textContent = text;
	row.appendChild(cell);
}

async function loadStations() {
	const res = await apiFetch('/api/polling-stations');
	const stations = await res.json();
	const tbody = document.getElementById('stations-tbody');
	tbody.innerHTML = '';

	if (stations.length === 0) {
		tbody.innerHTML = '<tr><td colspan="4" class="empty-row">投票所が登録されていません</td></tr>';
	} else {
		for (const s of stations) {
			const tr = document.createElement('tr');
			addCell(tr, s.name);
			addCell(tr, s.address);
			addCell(tr, s.lat);
			addCell(tr, s.lng);
			tbody.appendChild(tr);
		}
	}
	document.getElementById('station-count').textContent = `${stations.length}件`;
}

const DATUM_BUCKET_LABELS = {
	candidate: '日本測地系の可能性（変換候補）',
	unresolved: '住所と座標が一致しません',
	no_address: '住所未入力のため判定対象外',
	geocode_failed: 'ジオコーディングに失敗',
};

function addWarningItem(listEl, text) {
	const li = document.createElement('li');
	li.textContent = text;
	listEl.appendChild(li);
}

document.getElementById('import-button').addEventListener('click', async () => {
	const fileInput = document.getElementById('import-file');
	const errorEl = document.getElementById('import-error');
	const successEl = document.getElementById('import-success');
	const noteEl = document.getElementById('import-note');
	const warningsEl = document.getElementById('import-warnings');
	errorEl.textContent = '';
	successEl.textContent = '';
	noteEl.textContent = '';
	warningsEl.innerHTML = '';

	const file = fileInput.files[0];
	if (!file) {
		errorEl.textContent = 'CSVファイルを選択してください';
		return;
	}

	const text = await file.text();
	const res = await apiFetch('/api/polling-stations/import', {
		method: 'POST',
		headers: { 'Content-Type': 'text/csv' },
		body: text,
	});
	const data = await res.json();
	if (!res.ok) {
		errorEl.textContent = data.error ?? 'インポートに失敗しました';
		for (const r of data.datum_check?.rows ?? []) {
			if (r.bucket === 'ok') continue;
			const label = DATUM_BUCKET_LABELS[r.bucket] ?? r.bucket;
			addWarningItem(warningsEl, `${r.line}行目: ${label}`);
		}
		return;
	}
	successEl.textContent = `${data.imported}件の投票所を反映しました`;
	if (data.datum_corrected) {
		successEl.textContent += ` / 日本測地系の座標を自動補正しました（${data.corrected_count}件）`;
	}
	if (data.datum_check_note) {
		noteEl.textContent = data.datum_check_note;
	}
	for (const w of data.warnings ?? []) {
		addWarningItem(warningsEl, w.message);
	}
	fileInput.value = '';
	await loadStations();
});

loadStations();
