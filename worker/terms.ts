export interface TermsEnv {
	DB: D1Database;
}

export async function listTerms(env: TermsEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM terms ORDER BY term_id DESC').all();
	return Response.json(results);
}

export async function getTermData(env: TermsEnv, termId: string): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT
			areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.num_households,
			term_data.assignee_id, term_data.assignee_name, term_data.distributed_total,
			term_data.distribution_rate, term_data.last_updated_at
		FROM term_data
		JOIN areas ON areas.area_id = term_data.area_id
		WHERE term_data.term_id = ?
		ORDER BY areas.area_id`,
	)
		.bind(termId)
		.all();
	return Response.json(results);
}

/** 現行タームを完了にし、新タームを全areasゼロクリア状態で作成する（管理者のみ呼び出し想定）。 */
export async function createNewTerm(env: TermsEnv, termName: string): Promise<Response> {
	if (!termName) {
		return Response.json({ error: 'term_name を指定してください' }, { status: 400 });
	}

	const today = new Date().toISOString().slice(0, 10);

	await env.DB.prepare("UPDATE terms SET status = '完了', end_date = ? WHERE status = '進行中'")
		.bind(today)
		.run();

	const inserted = await env.DB.prepare(
		"INSERT INTO terms (term_name, start_date, status) VALUES (?, ?, '進行中')",
	)
		.bind(termName, today)
		.run();
	const newTermId = inserted.meta.last_row_id;

	await env.DB.prepare(
		`INSERT INTO term_data (term_id, area_id, assignee_id, assignee_name, distributed_total, distribution_rate, last_updated_at)
		 SELECT ?, area_id, NULL, '', 0, 0, NULL FROM areas`,
	)
		.bind(newTermId)
		.run();

	const term = await env.DB.prepare('SELECT * FROM terms WHERE term_id = ?').bind(newTermId).first();
	return Response.json(term);
}
