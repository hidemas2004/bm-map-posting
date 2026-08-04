import { csvResponse, toCsv } from './csv';

export interface ActivityLogEnv {
	DB: D1Database;
}

interface ActivityLogRow {
	log_id: number;
	term_id: number;
	term_name: string;
	area_id: string;
	city: string;
	ward: string;
	town: string;
	chome: string;
	updated_at: string;
	user_id: string;
	user_name: string;
	delta: number;
}

const LIST_QUERY = `
	SELECT activity_log.log_id, activity_log.term_id, terms.term_name, activity_log.area_id,
		areas.city, areas.ward, areas.town, areas.chome,
		activity_log.updated_at, activity_log.user_id, activity_log.user_name, activity_log.delta
	FROM activity_log
	JOIN terms ON terms.term_id = activity_log.term_id
	JOIN areas ON areas.area_id = activity_log.area_id`;

async function queryActivityLog(env: ActivityLogEnv, termId: string | null): Promise<ActivityLogRow[]> {
	const stmt = termId
		? env.DB.prepare(`${LIST_QUERY} WHERE activity_log.term_id = ? ORDER BY activity_log.updated_at DESC`).bind(termId)
		: env.DB.prepare(`${LIST_QUERY} ORDER BY activity_log.updated_at DESC`);
	const { results } = await stmt.all<ActivityLogRow>();
	return results;
}

export async function listActivityLog(env: ActivityLogEnv, termId: string | null): Promise<Response> {
	return Response.json(await queryActivityLog(env, termId));
}

export async function exportActivityLogCsv(env: ActivityLogEnv, termId: string | null): Promise<Response> {
	const rows = await queryActivityLog(env, termId);
	const csv = toCsv(
		['log_id', '記録日時', 'ターム', 'area_id', '市区町村', '区', '町丁目', '丁目', '担当者ID', '担当者名', '増減枚数'],
		rows.map((r) => [
			r.log_id,
			r.updated_at,
			r.term_name,
			r.area_id,
			r.city,
			r.ward,
			r.town,
			r.chome,
			r.user_id,
			r.user_name,
			r.delta,
		]),
	);
	return csvResponse(csv, 'activity_log.csv');
}
