import type { SessionUser } from './auth';

/**
 * 区画編集の排他制御用ロック（issue#未定）。区画(area_id)単位でTTL付きロックをD1に保持し、
 * クライアントは編集中10秒間隔でハートビート（acquireの再送）を送ってロックを延長する。
 * failしても待機せず即座に409を返すfail-fast方式のため、循環待機によるデッドロックは
 * 構造上発生しない。失効ロック（expires_at超過）は誰でも即座に上書き取得できるため、
 * 解放漏れ（タブ強制終了・クラッシュ・通信断）があっても最大TTL秒で自然回復する。
 */

const LOCK_TTL_SECONDS = 30;

/**
 * ロックの所有者はユーザー＋クライアント（画面）単位（migrations/0014_edit_locks_client_id.sql）。
 * 同じアカウントで複数の端末・タブを開いても互いに排他されるよう、ブラウザがページ読み込みごとに
 * 生成する乱数IDを X-Client-Id ヘッダで受け取る。ヘッダが無い・不正な場合は null。
 */
export function clientIdOf(request: Request): string | null {
	const id = request.headers.get('X-Client-Id') ?? '';
	return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

const CLIENT_ID_REQUIRED = { error: '画面を再読み込みしてください（クライアントIDがありません）' };

export interface LocksEnv {
	DB: D1Database;
}

interface LockRow {
	user_id: string;
	user_name: string;
	client_id: string;
	expires_at: string;
}

export async function acquireLock(request: Request, env: LocksEnv, user: SessionUser): Promise<Response> {
	const clientId = clientIdOf(request);
	if (!clientId) {
		return Response.json(CLIENT_ID_REQUIRED, { status: 400 });
	}
	const body = await request
		.json<{ area_id?: string; term_id?: number }>()
		.catch(() => ({}) as { area_id?: string; term_id?: number });
	const areaId = String(body.area_id ?? '');
	if (!areaId) {
		return Response.json({ error: 'area_id を指定してください' }, { status: 400 });
	}
	const termId = Number(body.term_id) || null;

	await env.DB.prepare(
		`INSERT INTO edit_locks (area_id, user_id, user_name, client_id, acquired_at, expires_at)
		 VALUES (?, ?, ?, ?, datetime('now'), datetime('now', '+${LOCK_TTL_SECONDS} seconds'))
		 ON CONFLICT(area_id) DO UPDATE SET
		   user_id = excluded.user_id,
		   user_name = excluded.user_name,
		   client_id = excluded.client_id,
		   acquired_at = excluded.acquired_at,
		   expires_at = excluded.expires_at
		 WHERE edit_locks.expires_at < datetime('now')
		    OR (edit_locks.user_id = excluded.user_id AND edit_locks.client_id = excluded.client_id)`,
	)
		.bind(areaId, user.user_id, user.name, clientId)
		.run();

	const lock = await env.DB.prepare('SELECT user_id, user_name, client_id, expires_at FROM edit_locks WHERE area_id = ?')
		.bind(areaId)
		.first<LockRow>();

	// 画面が持っているデータは開いた時点のものなので、他の人・端末の更新を反映できるよう、
	// term_id 指定時は同じエリア（chome_area_id）内の全区画の最新の term_data を一緒に返す
	const rows = termId ? await chomeAreaRows(env, termId, areaId) : undefined;

	if (!lock || lock.user_id !== user.user_id || lock.client_id !== clientId) {
		// same_user: 同じアカウントの別の端末・タブが保持している（表示文言の出し分け用）
		return Response.json(
			{ ok: false, locked_by_name: lock?.user_name ?? '', same_user: lock?.user_id === user.user_id, rows },
			{ status: 409 },
		);
	}
	return Response.json({ ok: true, expires_at: lock.expires_at, rows });
}

/** 指定区画と同じエリア内の全区画の term_data（/api/term-data と同じ形）。 */
async function chomeAreaRows(env: LocksEnv, termId: number, areaId: string): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		`SELECT
			areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			term_data.area_manager_id, term_data.area_manager_name,
			term_data.assignee_id, term_data.assignee_name, term_data.distributed_total,
			term_data.distribution_rate, term_data.last_updated_at
		FROM term_data
		JOIN areas ON areas.area_id = term_data.area_id
		WHERE term_data.term_id = ?1
		  AND (areas.area_id = ?2 OR areas.chome_area_id = (SELECT chome_area_id FROM areas WHERE area_id = ?2))`,
	)
		.bind(termId, areaId)
		.all();
	return results;
}

export async function releaseLock(request: Request, env: LocksEnv, user: SessionUser): Promise<Response> {
	const clientId = clientIdOf(request);
	if (!clientId) {
		return Response.json(CLIENT_ID_REQUIRED, { status: 400 });
	}
	const body = await request.json<{ area_id?: string }>().catch(() => ({}) as { area_id?: string });
	const areaId = String(body.area_id ?? '');
	if (!areaId) {
		return Response.json({ error: 'area_id を指定してください' }, { status: 400 });
	}
	// 自分（このクライアント）のロックだけを解放する。同じアカウントの別端末のロックは消さない
	await env.DB.prepare('DELETE FROM edit_locks WHERE area_id = ? AND user_id = ? AND client_id = ?')
		.bind(areaId, user.user_id, clientId)
		.run();
	return Response.json({ ok: true });
}

/**
 * chome_area_id内の区画のうち、自分（このユーザー＋クライアント）以外が有効なロックを保持していれば
 * その保持者を返す。同じアカウントの別端末・タブが保持している場合も「他者」として扱う。
 */
export async function checkChomeAreaLocked(
	env: LocksEnv,
	chomeAreaId: string,
	userId: string,
	clientId: string | null,
): Promise<{ name: string; sameUser: boolean } | null> {
	const row = await env.DB.prepare(
		`SELECT user_id, user_name FROM edit_locks
		 WHERE expires_at > datetime('now')
		   AND NOT (user_id = ? AND client_id = ?)
		   AND area_id IN (SELECT area_id FROM areas WHERE chome_area_id = ?)
		 LIMIT 1`,
	)
		.bind(userId, clientId ?? '', chomeAreaId)
		.first<{ user_id: string; user_name: string }>();
	return row ? { name: row.user_name, sameUser: row.user_id === userId } : null;
}

/** ロック保持者の表示文言（サーバー側エラーメッセージ用。フロントの lockHolderLabel と同じ考え方）。 */
export function lockedMessage(holder: { name: string; sameUser: boolean }): string {
	return holder.sameUser ? '別の端末（またはタブ）で編集中です' : `${holder.name}さんが編集中です`;
}

/** エリア担当編集フォームを開く前のプリチェック用（最終的な整合性はsetAreaManager側で担保） */
export async function checkAreaManagerStatus(
	request: Request,
	env: LocksEnv,
	url: URL,
	user: SessionUser,
): Promise<Response> {
	const chomeAreaId = url.searchParams.get('chome_area_id') ?? '';
	if (!chomeAreaId) {
		return Response.json({ error: 'chome_area_id を指定してください' }, { status: 400 });
	}
	const holder = await checkChomeAreaLocked(env, chomeAreaId, user.user_id, clientIdOf(request));
	return Response.json({
		locked: holder !== null,
		locked_by_name: holder?.name,
		same_user: holder?.sameUser ?? false,
	});
}
