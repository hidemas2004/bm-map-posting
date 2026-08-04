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

async function loadUsers() {
	const res = await apiFetch('/api/users');
	const users = await res.json();
	const tbody = document.getElementById('users-tbody');
	tbody.innerHTML = '';

	if (users.length === 0) {
		tbody.innerHTML = '<tr><td colspan="4" class="empty-row">ユーザーがいません</td></tr>';
	} else {
		for (const u of users) {
			const tr = document.createElement('tr');
			addCell(tr, u.user_id);
			addCell(tr, u.name);
			addCell(tr, u.role);
			addCell(tr, u.active ? 'ログイン可' : 'ログイン不可');
			tbody.appendChild(tr);
		}
	}
	document.getElementById('user-count').textContent = `${users.length}件`;
}

document.getElementById('csv-download-button').addEventListener('click', async () => {
	const res = await apiFetch('/api/users/export');
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'users.csv';
	a.click();
	URL.revokeObjectURL(url);
});

document.getElementById('import-button').addEventListener('click', async () => {
	const fileInput = document.getElementById('import-file');
	const errorEl = document.getElementById('import-error');
	const successEl = document.getElementById('import-success');
	errorEl.textContent = '';
	successEl.textContent = '';

	const file = fileInput.files[0];
	if (!file) {
		errorEl.textContent = 'CSVファイルを選択してください';
		return;
	}

	const text = await file.text();
	const res = await apiFetch('/api/users/import', {
		method: 'POST',
		headers: { 'Content-Type': 'text/csv' },
		body: text,
	});
	const data = await res.json();
	if (!res.ok) {
		errorEl.textContent = data.error ?? 'インポートに失敗しました';
		return;
	}
	successEl.textContent = `${data.imported}件のユーザーを反映しました`;
	fileInput.value = '';
	await loadUsers();
});

loadUsers();
