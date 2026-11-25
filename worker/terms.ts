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
			areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			term_data.area_manager_id, term_data.area_manager_name,
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

/**
 * 現行タームを完了にし、新タームを作成する（管理者のみ呼び出し想定）。
 * `inheritFromTermId` を指定した場合、新タームのエリア担当(term_data.area_manager_id/name)・
 * 区画担当(term_data.assignee_id/name)を、そのタームの現在の設定からコピーする（区画が
 * inheritFromTermId側に存在しない場合は未設定のまま）。配布実績(distributed_total/distribution_rate/last_updated_at)は
 * 継承対象外で、常に0/0/NULLで開始する。未指定時は全区画ゼロクリア状態で作成する（従来動作）。
 */
export async function createNewTerm(
	env: TermsEnv,
	termName: string,
	inheritFromTermId?: number | null,
): Promise<Response> {
	if (!termName) {
		return Response.json({ error: 'term_name を指定してください' }, { status: 400 });
	}

	if (inheritFromTermId) {
		const source = await env.DB.prepare('SELECT term_id FROM terms WHERE term_id = ?')
			.bind(inheritFromTermId)
			.first();
		if (!source) {
			return Response.json({ error: '指定された継承元タームが見つかりません' }, { status: 400 });
		}
	}

	const today = new Date().toISOString().slice(0, 10);

	// 現タームの完了・新タームの作成・全区画の term_data 作成を1つのトランザクション（batch）で行う。
	// 別々に実行すると、途中で失敗（書き込み上限超過等）した場合に「現タームは完了になったが
	// 新タームの区画データが無い」状態が残るため。新タームのIDは batch 内で参照できないので、
	// 直前のINSERTで唯一の「進行中」になった行を副問い合わせで指す。
	const NEW_TERM_ID = "(SELECT term_id FROM terms WHERE status = '進行中')";
	const results = await env.DB.batch([
		env.DB.prepare("UPDATE terms SET status = '完了', end_date = ? WHERE status = '進行中'").bind(today),
		env.DB.prepare("INSERT INTO terms (term_name, start_date, status) VALUES (?, ?, '進行中')").bind(termName, today),
		inheritFromTermId
			? env.DB.prepare(
					`INSERT INTO term_data (term_id, area_id, area_manager_id, area_manager_name, assignee_id, assignee_name, distributed_total, distribution_rate, last_updated_at)
					 SELECT ${NEW_TERM_ID}, areas.area_id, src.area_manager_id, COALESCE(src.area_manager_name, ''), src.assignee_id, COALESCE(src.assignee_name, ''), 0, 0, NULL
					 FROM areas
					 LEFT JOIN term_data src ON src.area_id = areas.area_id AND src.term_id = ?`,
				).bind(inheritFromTermId)
			: env.DB.prepare(
					`INSERT INTO term_data (term_id, area_id, area_manager_id, area_manager_name, assignee_id, assignee_name, distributed_total, distribution_rate, last_updated_at)
					 SELECT ${NEW_TERM_ID}, area_id, NULL, '', NULL, '', 0, 0, NULL FROM areas`,
				),
	]);
	const newTermId = results[1].meta.last_row_id;

	const term = await env.DB.prepare('SELECT * FROM terms WHERE term_id = ?').bind(newTermId).first();
	return Response.json(term);
}
