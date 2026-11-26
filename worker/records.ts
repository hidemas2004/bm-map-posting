import type { SessionUser } from './auth';

export interface RecordsEnv {
	DB: D1Database;
}

/**
 * 画面に返す区画行（/api/term-data と同じ形）の SELECT 列。
 * rev / updated_by_name は画面同期と楽観的排他制御に使う（migrations/0015_term_data_rev.sql）。
 */
export const TERM_DATA_COLUMNS = `areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			term_data.area_manager_id, term_data.area_manager_name,
			term_data.assignee_id, term_data.assignee_name, term_data.distributed_total,
			term_data.distribution_rate, term_data.last_updated_at,
			term_data.rev, term_data.updated_by_name`;

/** 指定タームの次の変更番号（UPDATE の SET 句で使う副問い合わせ。1文の中では1回だけ評価される）。 */
const NEXT_REV = '(SELECT COALESCE(MAX(rev), 0) + 1 FROM term_data WHERE term_id = ?)';

async function selectRow(env: RecordsEnv, termId: number, areaId: string): Promise<Record<string, unknown> | null> {
	return env.DB.prepare(
		`SELECT ${TERM_DATA_COLUMNS}
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.term_id = ? AND term_data.area_id = ?`,
	)
		.bind(termId, areaId)
		.first();
}

async function selectChomeAreaRows(env: RecordsEnv, termId: number, chomeAreaId: string): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${TERM_DATA_COLUMNS}
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.term_id = ? AND areas.chome_area_id = ?`,
	)
		.bind(termId, chomeAreaId)
		.all();
	return results;
}

/**
 * 楽観的排他制御の競合応答。画面が区画を開いた後に他の人が更新していた場合に返す。
 * rows に最新の区画行を含めるので、画面はそれで表示を更新し、利用者に確認・やり直しを促す。
 */
function conflictResponse(rows: unknown[], updatedByName: string, target = 'この区画'): Response {
	const who = updatedByName ? `${updatedByName}さん` : '他の人';
	return Response.json(
		{ error: `${who}が先に${target}を更新しました。最新の内容を確認してください`, conflict: true, rows },
		{ status: 409 },
	);
}

/** 画面が送ってきた変更番号（未指定なら null）。 */
function expectedRevOf(value: unknown): number | null {
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

export async function recordDistribution(request: Request, env: RecordsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; delta?: number; expected_rev?: number }>()
		.catch(() => ({}) as { term_id?: number; area_id?: string; delta?: number; expected_rev?: number });
	const termId = Number(body.term_id);
	const areaId = String(body.area_id ?? '');
	const delta = Number(body.delta);

	if (!termId || !areaId || !Number.isFinite(delta) || !Number.isInteger(delta)) {
		return Response.json({ error: 'term_id, area_id, delta(整数)を指定してください' }, { status: 400 });
	}

	const row = await env.DB.prepare(
		`SELECT term_data.id, term_data.distributed_total, term_data.assignee_id, term_data.rev, term_data.updated_by_name,
			areas.num_households
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.term_id = ? AND term_data.area_id = ?`,
	)
		.bind(termId, areaId)
		.first<{
			id: number;
			distributed_total: number;
			assignee_id: string | null;
			rev: number;
			updated_by_name: string;
			num_households: number;
		}>();

	if (!row) {
		return Response.json({ error: '指定されたターム・エリアの組み合わせが見つかりません' }, { status: 404 });
	}

	// 楽観的排他制御: 画面が区画を開いた時点の変更番号と今の番号が違えば、他の人が先に更新している。
	// 画面が番号を送ってこない場合も、上で読んだ番号を条件にして、読んでから書くまでの間の更新
	// （同時記録による実績の上書き）を防ぐ。
	const expectedRev = expectedRevOf(body.expected_rev) ?? row.rev;
	if (expectedRev !== row.rev) {
		return conflictResponse([await selectRow(env, termId, areaId)], row.updated_by_name);
	}

	if (row.num_households === 0) {
		return Response.json({ error: '世帯数が0のためこのエリアは配布記録の対象外です' }, { status: 400 });
	}
	// 配布計画の対象＝区画担当が設定済みの区画（エリア担当の有無は問わない）。
	// 「実績が1以上の区画には必ず区画担当がいる」不変条件の片側（もう片側は setAssignee / setAreaManager）。
	if (!row.assignee_id) {
		return Response.json({ error: '区画担当が未設定のためこの区画は配布記録の対象外です' }, { status: 400 });
	}

	const newTotal = row.distributed_total + delta;
	if (newTotal < 0) {
		return Response.json({ error: '配布枚数がマイナスになります' }, { status: 400 });
	}
	if (newTotal > row.num_households) {
		return Response.json({ error: '累計が世帯数を超えています' }, { status: 400 });
	}

	const now = new Date().toISOString();
	const rate = Math.round((newTotal / row.num_households) * 100 * 10) / 10;

	// 実績の更新と履歴の追加は1つのトランザクション（batch）で行い、途中で失敗（書き込み上限超過等）
	// しても実績だけ・履歴だけが残らないようにする。
	// UPDATE は「変更番号が読んだときのまま」かつ「区画担当がいる」ことを条件にする（上の判定後に
	// 他の人が更新した場合や、区画担当が外された場合に書き込まない）。
	// 履歴は UPDATE が実際に行われた場合だけ追加する（同じ時刻・同じ累計に更新された行が
	// 存在することを条件にする）。
	const [updateResult] = await env.DB.batch([
		env.DB.prepare(
			`UPDATE term_data SET distributed_total = ?, distribution_rate = ?, last_updated_at = ?,
				rev = ${NEXT_REV}, updated_by_name = ?
			 WHERE id = ? AND rev = ? AND assignee_id IS NOT NULL`,
		).bind(newTotal, rate, now, termId, user.name, row.id, expectedRev),
		env.DB.prepare(
			`INSERT INTO activity_log (term_id, area_id, updated_at, user_id, user_name, delta)
			 SELECT ?, ?, ?, ?, ?, ?
			 WHERE EXISTS (SELECT 1 FROM term_data WHERE id = ? AND last_updated_at = ? AND distributed_total = ? AND assignee_id IS NOT NULL)`,
		).bind(termId, areaId, now, user.user_id, user.name, delta, row.id, now, newTotal),
	]);

	if (updateResult.meta.changes === 0) {
		const latest = await selectRow(env, termId, areaId);
		if (latest && latest.rev !== expectedRev) {
			return conflictResponse([latest], String(latest.updated_by_name ?? ''));
		}
		return Response.json({ error: '区画担当が未設定のためこの区画は配布記録の対象外です' }, { status: 400 });
	}

	return Response.json(await selectRow(env, termId, areaId));
}

export async function setAssignee(request: Request, env: RecordsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; assignee_id?: string | null; expected_rev?: number }>()
		.catch(
			() => ({}) as { term_id?: number; area_id?: string; assignee_id?: string | null; expected_rev?: number },
		);
	const termId = Number(body.term_id);
	const areaId = String(body.area_id ?? '');
	const assigneeId = body.assignee_id ?? null;

	if (!termId || !areaId) {
		return Response.json({ error: 'term_id, area_id を指定してください' }, { status: 400 });
	}

	const area = await env.DB.prepare('SELECT num_households FROM areas WHERE area_id = ?')
		.bind(areaId)
		.first<{ num_households: number }>();
	if (!area) {
		return Response.json({ error: '指定されたエリアが見つかりません' }, { status: 404 });
	}
	if (area.num_households === 0) {
		return Response.json({ error: '世帯数が0のためこのエリアには担当者を設定できません' }, { status: 400 });
	}

	const current = await env.DB.prepare(
		'SELECT distributed_total, rev, updated_by_name FROM term_data WHERE term_id = ? AND area_id = ?',
	)
		.bind(termId, areaId)
		.first<{ distributed_total: number; rev: number; updated_by_name: string }>();
	if (!current) {
		return Response.json({ error: '指定されたターム・エリアの組み合わせが見つかりません' }, { status: 404 });
	}
	// 楽観的排他制御（recordDistribution と同じ考え方）
	const expectedRev = expectedRevOf(body.expected_rev) ?? current.rev;
	if (expectedRev !== current.rev) {
		return conflictResponse([await selectRow(env, termId, areaId)], current.updated_by_name);
	}

	let assigneeName = '';
	if (assigneeId) {
		const assignee = await env.DB.prepare('SELECT name FROM users WHERE user_id = ? AND active = 1')
			.bind(assigneeId)
			.first<{ name: string }>();
		if (!assignee) {
			return Response.json({ error: '指定された担当者が見つかりません' }, { status: 400 });
		}
		assigneeName = assignee.name;
	}

	// 実績が1以上の区画は区画担当を未担当にできない（実績を0に戻してからなら可）。
	// 判定と更新の間に実績が記録されても不変条件が崩れないよう、UPDATEの条件に含める。
	// あわせて変更番号が読んだときのままであることを条件にする（楽観的排他制御）。
	const result = await env.DB.prepare(
		`UPDATE term_data SET assignee_id = ?, assignee_name = ?, rev = ${NEXT_REV}, updated_by_name = ?
		 WHERE term_id = ? AND area_id = ? AND rev = ? AND (? IS NOT NULL OR distributed_total = 0)`,
	)
		.bind(assigneeId, assigneeName, termId, user.name, termId, areaId, expectedRev, assigneeId)
		.run();

	if (result.meta.changes === 0) {
		const latest = await selectRow(env, termId, areaId);
		if (latest && latest.rev !== expectedRev) {
			return conflictResponse([latest], String(latest.updated_by_name ?? ''));
		}
		return Response.json(
			{ error: '配布実績がある区画は区画担当を未担当にできません（実績を0に戻すと未担当にできます）' },
			{ status: 400 },
		);
	}

	return Response.json(await selectRow(env, termId, areaId));
}

/**
 * エリア担当（chome_area_id単位。boundary_chome.geojsonの境界ポリゴンに対応）を、指定タームについて設定する。
 * エリア担当はタームごとの計画情報で、term_data に区画行ごとに複製して持つ（migrations/0012_term_area_manager.sql）。
 *   - 指定ターム・同一エリア内の全区画（世帯数0を含む）の term_data.area_manager_id/name を一括更新する。
 *   - あわせて同一エリア内の区画（世帯数>0、かつ配布実績0のもの）の区画担当(term_data.assignee)も
 *     一括で上書きする。エリア担当を設定した場合はその人に、未設定(null)にした場合は区画担当も未設定にする
 *     （エリアを配布計画外にする運用のため。既存の区画担当の個別設定も上書きされる）。
 *   - 配布実績が1以上の区画は、区画担当・実績ともそのまま残す（実際に配った人の担当を消さないため。
 *     また「実績が1以上の区画には必ず区画担当がいる」不変条件を保つため。recordDistribution参照）。
 * 完了タームの計画を書き換えないよう、進行中タームのみ受け付ける。
 *
 * 楽観的排他制御: 画面は、開いた時点で持っていたエリア内の区画の変更番号の最大値（expected_rev）を送る。
 * エリア内のどこかの区画がその後に更新されていれば（最大値が変わっていれば）更新せず 409 を返す。
 * 判定と更新を1つの UPDATE 文で行う（条件と SET の副問い合わせは文の実行前に1回だけ評価されるので、
 * エリア内の全区画が同じ番号でまとめて更新されるか、1件も更新されないかのどちらかになる）。
 */
export async function setAreaManager(request: Request, env: RecordsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; area_manager_id?: string | null; expected_rev?: number }>()
		.catch(
			() => ({}) as { term_id?: number; area_id?: string; area_manager_id?: string | null; expected_rev?: number },
		);
	const termId = Number(body.term_id);
	const areaId = String(body.area_id ?? '');
	const areaManagerId = body.area_manager_id ?? null;

	if (!termId || !areaId) {
		return Response.json({ error: 'term_id, area_id を指定してください' }, { status: 400 });
	}

	const term = await env.DB.prepare('SELECT status FROM terms WHERE term_id = ?').bind(termId).first<{ status: string }>();
	if (!term) {
		return Response.json({ error: '指定されたタームが見つかりません' }, { status: 404 });
	}
	if (term.status !== '進行中') {
		return Response.json({ error: '完了したタームのエリア担当は変更できません' }, { status: 400 });
	}

	const area = await env.DB.prepare('SELECT chome_area_id, num_households FROM areas WHERE area_id = ?')
		.bind(areaId)
		.first<{ chome_area_id: string; num_households: number }>();
	if (!area) {
		return Response.json({ error: '指定されたエリアが見つかりません' }, { status: 404 });
	}
	if (area.num_households === 0) {
		return Response.json({ error: '世帯数が0の区画ではエリア担当を設定できません' }, { status: 400 });
	}

	let areaManagerName = '';
	if (areaManagerId) {
		const manager = await env.DB.prepare('SELECT name FROM users WHERE user_id = ? AND active = 1')
			.bind(areaManagerId)
			.first<{ name: string }>();
		if (!manager) {
			return Response.json({ error: '指定されたエリア担当が見つかりません' }, { status: 400 });
		}
		areaManagerName = manager.name;
	}

	const AREA_ROWS = 'SELECT area_id FROM areas WHERE chome_area_id = ?';
	const AREA_MAX_REV = `(SELECT COALESCE(MAX(rev), 0) FROM term_data WHERE term_id = ? AND area_id IN (${AREA_ROWS}))`;
	let guardRev = expectedRevOf(body.expected_rev);
	if (guardRev === null) {
		const before = await env.DB.prepare(`SELECT ${AREA_MAX_REV} AS max_rev`)
			.bind(termId, area.chome_area_id)
			.first<{ max_rev: number }>();
		guardRev = before?.max_rev ?? 0;
	}

	const result = await env.DB.prepare(
		`UPDATE term_data SET
			area_manager_id = ?,
			area_manager_name = ?,
			assignee_id = CASE WHEN distributed_total = 0 AND area_id IN (${AREA_ROWS} AND num_households > 0) THEN ? ELSE assignee_id END,
			assignee_name = CASE WHEN distributed_total = 0 AND area_id IN (${AREA_ROWS} AND num_households > 0) THEN ? ELSE assignee_name END,
			rev = ${NEXT_REV},
			updated_by_name = ?
		 WHERE term_id = ?
		   AND area_id IN (${AREA_ROWS})
		   AND ${AREA_MAX_REV} = ?`,
	)
		.bind(
			areaManagerId,
			areaManagerName,
			area.chome_area_id,
			areaManagerId,
			area.chome_area_id,
			areaManagerName,
			termId,
			user.name,
			termId,
			area.chome_area_id,
			termId,
			area.chome_area_id,
			guardRev,
		)
		.run();

	const rows = (await selectChomeAreaRows(env, termId, area.chome_area_id)) as { rev: number; updated_by_name: string }[];
	if (result.meta.changes === 0) {
		const newest = rows.reduce<(typeof rows)[number] | undefined>((a, b) => (!a || b.rev > a.rev ? b : a), undefined);
		return conflictResponse(rows, newest?.updated_by_name ?? '', 'このエリア内の区画');
	}

	return Response.json({
		area_manager_id: areaManagerId,
		area_manager_name: areaManagerName,
		rows,
	});
}
