import type { SessionUser } from './auth';

/**
 * 区画編集の排他制御用ロック（issue#未定）。区画(area_id)単位でTTL付きロックをD1に保持し、
 * クライアントは編集中10秒間隔でハートビート（acquireの再送）を送ってロックを延長する。
 * failしても待機せず即座に409を返すfail-fast方式のため、循環待機によるデッドロックは
 * 構造上発生しない。失効ロック（expires_at超過）は誰でも即座に上書き取得できるため、
 * 解放漏れ（タブ強制終了・クラッシュ・通信断）があっても最大TTL秒で自然回復する。
 */

const LOCK_TTL_SECONDS = 30;

export interface LocksEnv {
	DB: D1Database;
}

interface LockRow {
	user_id: string;
	user_name: string;
	expires_at: string;
}

export async function acquireLock(request: Request, env: LocksEnv, user: SessionUser): Promise<Response> {
	const body = await request.json<{ area_id?: string }>().catch(() => ({}) as { area_id?: string });
	const areaId = String(body.area_id ?? '');
	if (!areaId) {
		return Response.json({ error: 'area_id を指定してください' }, { status: 400 });
	}

	await env.DB.prepare(
		`INSERT INTO edit_locks (area_id, user_id, user_name, acquired_at, expires_at)
		 VALUES (?, ?, ?, datetime('now'), datetime('now', '+${LOCK_TTL_SECONDS} seconds'))
		 ON CONFLICT(area_id) DO UPDATE SET
		   user_id = excluded.user_id,
		   user_name = excluded.user_name,
		   acquired_at = excluded.acquired_at,
		   expires_at = excluded.expires_at
		 WHERE edit_locks.expires_at < datetime('now') OR edit_locks.user_id = excluded.user_id`,
	)
		.bind(areaId, user.user_id, user.name)
		.run();

	const lock = await env.DB.prepare('SELECT user_id, user_name, expires_at FROM edit_locks WHERE area_id = ?')
		.bind(areaId)
		.first<LockRow>();

	if (!lock || lock.user_id !== user.user_id) {
		return Response.json({ ok: false, locked_by_name: lock?.user_name ?? '' }, { status: 409 });
	}
	return Response.json({ ok: true, expires_at: lock.expires_at });
}

export async function releaseLock(request: Request, env: LocksEnv, user: SessionUser): Promise<Response> {
	const body = await request.json<{ area_id?: string }>().catch(() => ({}) as { area_id?: string });
	const areaId = String(body.area_id ?? '');
	if (!areaId) {
		return Response.json({ error: 'area_id を指定してください' }, { status: 400 });
	}
	await env.DB.prepare('DELETE FROM edit_locks WHERE area_id = ? AND user_id = ?').bind(areaId, user.user_id).run();
	return Response.json({ ok: true });
}

/** chome_area_id内の区画のうち、excludeUserId以外が有効なロックを保持していればその名前を返す。 */
export async function checkChomeAreaLocked(
	env: LocksEnv,
	chomeAreaId: string,
	excludeUserId: string,
): Promise<string | null> {
	const row = await env.DB.prepare(
		`SELECT user_name FROM edit_locks
		 WHERE expires_at > datetime('now')
		   AND user_id != ?
		   AND area_id IN (SELECT area_id FROM areas WHERE chome_area_id = ?)
		 LIMIT 1`,
	)
		.bind(excludeUserId, chomeAreaId)
		.first<{ user_name: string }>();
	return row?.user_name ?? null;
}

/** エリア担当編集フォームを開く前のプリチェック用（最終的な整合性はsetAreaManager側で担保） */
export async function checkAreaManagerStatus(env: LocksEnv, url: URL, user: SessionUser): Promise<Response> {
	const chomeAreaId = url.searchParams.get('chome_area_id') ?? '';
	if (!chomeAreaId) {
		return Response.json({ error: 'chome_area_id を指定してください' }, { status: 400 });
	}
	const lockedByName = await checkChomeAreaLocked(env, chomeAreaId, user.user_id);
	return Response.json({ locked: lockedByName !== null, locked_by_name: lockedByName ?? undefined });
}
