/**
 * ユーザーマスタ（D1 の users テーブル）を使った認証ロジック。
 * ユーザーID+合言葉を照合し、成功時はHMAC署名付きの自己完結型トークンを発行する
 * （セッションストアを持たず、Workerはステートレスに検証するだけでよい）。
 * 将来 bm-map-streetad との統合や認証方式変更に備え、認証ロジックはこのファイルに分離してある。
 */

export interface AuthEnv {
	DB: D1Database;
	SESSION_SECRET: string;
}

export interface SessionUser {
	user_id: string;
	name: string;
	role: '管理者' | '一般';
}

interface TokenPayload extends SessionUser {
	exp: number; // UNIX秒
}

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12時間

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify',
	]);
}

async function issueToken(user: SessionUser, secret: string): Promise<string> {
	const payload: TokenPayload = { ...user, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
	const payloadPart = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadPart));
	return `${payloadPart}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifyToken(token: string, secret: string): Promise<SessionUser | null> {
	const [payloadPart, signaturePart] = token.split('.');
	if (!payloadPart || !signaturePart) return null;

	const key = await hmacKey(secret);
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		fromBase64Url(signaturePart),
		new TextEncoder().encode(payloadPart),
	);
	if (!valid) return null;

	let payload: TokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadPart)));
	} catch {
		return null;
	}
	if (payload.exp < Math.floor(Date.now() / 1000)) return null;

	return { user_id: payload.user_id, name: payload.name, role: payload.role };
}

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
	let body: { user_id?: string; passphrase?: string };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'リクエストの形式が不正です' }, { status: 400 });
	}
	const userId = String(body.user_id ?? '');
	const passphrase = String(body.passphrase ?? '');
	if (!userId || !passphrase) {
		return Response.json({ error: 'ユーザーIDと合言葉を入力してください' }, { status: 400 });
	}

	const row = await env.DB.prepare(
		'SELECT user_id, name, passphrase, role FROM users WHERE user_id = ? AND active = 1',
	)
		.bind(userId)
		.first<{ user_id: string; name: string; passphrase: string; role: '管理者' | '一般' }>();

	if (!row || row.passphrase !== passphrase) {
		return Response.json({ error: 'ユーザーIDまたは合言葉が違います' }, { status: 401 });
	}

	const user: SessionUser = { user_id: row.user_id, name: row.name, role: row.role };
	const token = await issueToken(user, env.SESSION_SECRET);
	return Response.json({ token, user });
}

/** Authorization: Bearer <token> ヘッダを検証し、ログイン中ユーザーを返す。未認証ならnull。 */
export async function requireAuth(request: Request, env: AuthEnv): Promise<SessionUser | null> {
	const header = request.headers.get('Authorization') ?? '';
	const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
	if (!token) return null;
	return verifyToken(token, env.SESSION_SECRET);
}

/** 管理者専用エンドポイント用。管理者でなければnullを返す。 */
export async function requireAdmin(request: Request, env: AuthEnv): Promise<SessionUser | null> {
	const user = await requireAuth(request, env);
	if (!user || user.role !== '管理者') return null;
	return user;
}
