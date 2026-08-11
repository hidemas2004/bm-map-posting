import { execCommand } from './win-exec.mjs';
import { confirm } from './prompt.mjs';

const NPX = 'npx';

function isLoggedIn() {
	try {
		const output = execCommand(NPX, ['wrangler', 'whoami', '--json'], { encoding: 'utf8', stdio: 'pipe' });
		return JSON.parse(output).loggedIn === true;
	} catch {
		return false;
	}
}

/**
 * wrangler CLIのOAuthアクセストークンは短命で、期限切れのまま `wrangler d1 create` 等の
 * API呼び出しに進むと `Authentication error [code: 10000]` で落ちる（新規地域追加の途中で
 * 発生した実例あり）。`wrangler whoami` はトークンを自動リフレッシュする副作用があるため、
 * 重い対話フロー（境界データ取得・D1作成等）に入る前にここで先に叩いておき、期限切れを
 * 未然に検知・解消する。
 */
export async function ensureWranglerAuth() {
	if (isLoggedIn()) return;

	console.log('\nwranglerの認証が無効です（未ログイン、またはアクセストークンの期限切れの可能性があります）。');
	const proceed = await confirm('ここで `npx wrangler login` を実行しますか？', { defaultValue: true });
	if (!proceed) {
		console.error('認証されていないため中断しました。`npx wrangler login` を実行してから再度お試しください。');
		process.exit(1);
	}

	execCommand(NPX, ['wrangler', 'login'], { encoding: 'utf8', stdio: 'inherit' });

	if (!isLoggedIn()) {
		console.error('ログインを確認できませんでした。`npx wrangler whoami` で状態を確認してください。');
		process.exit(1);
	}
	console.log('wranglerの認証を確認しました。');
}
