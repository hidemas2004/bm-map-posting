export interface ResetEnv {
	DB: D1Database;
}

/**
 * 指定タームを削除する（管理者のみ呼び出し想定）。動作検証のためのリセット機能として、
 * 関連データを中途半端に残さずすべて初期化する:
 *   - activity_log（配布履歴）・term_data（区画担当・配布実績）: 該当タームの行を削除
 *   - areas.area_manager_id/name（エリア担当）: タームに紐づかないマスタ側の情報だが、
 *     区画担当・配布実績と合わせて初期化しないと「エリア担当だけ残る」中途半端な状態になるため、
 *     ターム削除のたびに全区画分クリアする
 */
export async function deleteTerm(env: ResetEnv, termId: string): Promise<Response> {
	const term = await env.DB.prepare('SELECT term_id FROM terms WHERE term_id = ?').bind(termId).first();
	if (!term) {
		return Response.json({ error: '指定されたタームが見つかりません' }, { status: 404 });
	}

	await env.DB.batch([
		env.DB.prepare('DELETE FROM activity_log WHERE term_id = ?').bind(termId),
		env.DB.prepare('DELETE FROM term_data WHERE term_id = ?').bind(termId),
		env.DB.prepare('DELETE FROM terms WHERE term_id = ?').bind(termId),
		env.DB.prepare("UPDATE areas SET area_manager_id = NULL, area_manager_name = ''"),
	]);

	return Response.json({ deleted: true, term_id: Number(termId) });
}
