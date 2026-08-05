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

async function loadTerms() {
	const res = await apiFetch('/api/terms');
	const terms = await res.json();
	const tbody = document.getElementById('terms-tbody');
	tbody.innerHTML = '';

	if (terms.length === 0) {
		tbody.innerHTML = '<tr><td colspan="6" class="empty-row">タームがありません</td></tr>';
		return;
	}

	for (const term of terms) {
		const tr = document.createElement('tr');
		addCell(tr, term.term_id);
		addCell(tr, term.term_name);
		addCell(tr, term.status);
		addCell(tr, term.start_date);
		addCell(tr, term.end_date ?? '');

		const actionCell = document.createElement('td');
		const deleteButton = document.createElement('button');
		deleteButton.type = 'button';
		deleteButton.textContent = '削除';
		deleteButton.addEventListener('click', () => deleteTerm(term.term_id, term.term_name));
		actionCell.appendChild(deleteButton);
		tr.appendChild(actionCell);

		tbody.appendChild(tr);
	}
}

async function deleteTerm(termId, termName) {
	const ok = confirm(
		`「${termName}」を削除します。このタームの担当者・配布実績・配布履歴に加えて、` +
			`全区画のエリア担当（マスタ側の設定）もあわせて初期化されます。元に戻せません。よろしいですか？`,
	);
	if (!ok) return;

	const res = await apiFetch('/api/term/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ term_id: termId }),
	});
	const data = await res.json();
	if (!res.ok) {
		alert(data.error ?? 'タームの削除に失敗しました');
		return;
	}
	await loadTerms();
}

loadTerms();
