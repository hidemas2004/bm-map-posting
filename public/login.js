const SESSION_KEY = 'bm_posting_session';

async function loadActiveUsers() {
	const select = document.getElementById('user-id');
	try {
		const res = await fetch('/api/users/active');
		const users = await res.json();
		for (const u of users) {
			const option = document.createElement('option');
			option.value = u.user_id;
			option.textContent = `${u.name}（${u.user_id}）`;
			select.appendChild(option);
		}
	} catch {
		document.getElementById('error-message').textContent = 'ユーザー一覧の取得に失敗しました';
	}
}

function showError(message) {
	document.getElementById('error-message').textContent = message;
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	showError('');
	const userId = document.getElementById('user-id').value;
	const passphrase = document.getElementById('passphrase').value;
	const button = event.target.querySelector('button');
	button.disabled = true;

	try {
		const res = await fetch('/api/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ user_id: userId, passphrase }),
		});
		const data = await res.json();
		if (!res.ok) {
			showError(data.error ?? 'ログインに失敗しました');
			button.disabled = false;
			return;
		}
		sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
		location.href = '/';
	} catch {
		showError('通信に失敗しました');
		button.disabled = false;
	}
});

loadActiveUsers();
