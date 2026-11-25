export interface ResetEnv {
	DB: D1Database;
}

/**
 * 指定タームを削除する（管理者のみ呼び出し想定）。動作検証のためのリセット機能として、
 * 関連データを中途半端に残さずすべて初期化する:
 *   - activity_log（配布履歴）・term_data（エリア担当・区画担当・配布実績）: 該当タームの行を削除。
 *     エリア担当はターム単位の情報（term_data側。migrations/0012_term_area_manager.sql）なので、
 *     他タームのエリア担当には影響しない
 *   - gps_track_points・gps_tracks（軌跡記録）: 該当タームに紐づく行を削除。タームが通常
 *     完了（新タームの開始でstatusが完了になるだけ）した場合は軌跡データを残す仕様だが、
 *     この明示的なターム削除では他の関連データ同様に削除する。term_idがNULLの軌跡
 *     （記録開始時に進行中タームが無かったもの）はどのターム削除でも対象外。
 */
export async function deleteTerm(env: ResetEnv, termId: string): Promise<Response> {
	const term = await env.DB.prepare('SELECT term_id FROM terms WHERE term_id = ?').bind(termId).first();
	if (!term) {
		return Response.json({ error: '指定されたタームが見つかりません' }, { status: 404 });
	}

	await env.DB.batch([
		env.DB.prepare('DELETE FROM gps_track_points WHERE track_id IN (SELECT track_id FROM gps_tracks WHERE term_id = ?)').bind(termId),
		env.DB.prepare('DELETE FROM gps_tracks WHERE term_id = ?').bind(termId),
		env.DB.prepare('DELETE FROM activity_log WHERE term_id = ?').bind(termId),
		env.DB.prepare('DELETE FROM term_data WHERE term_id = ?').bind(termId),
		env.DB.prepare('DELETE FROM terms WHERE term_id = ?').bind(termId),
	]);

	return Response.json({ deleted: true, term_id: Number(termId) });
}
