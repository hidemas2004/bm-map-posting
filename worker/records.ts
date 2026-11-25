import type { SessionUser } from './auth';
import { checkChomeAreaLocked, clientIdOf, lockedMessage } from './locks';

export interface RecordsEnv {
	DB: D1Database;
}

interface TermDataRow {
	id: number;
	term_id: number;
	area_id: string;
	assignee_id: string | null;
	assignee_name: string;
	distributed_total: number;
	distribution_rate: number;
	last_updated_at: string | null;
}

export async function recordDistribution(request: Request, env: RecordsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; delta?: number }>()
		.catch(() => ({}) as { term_id?: number; area_id?: string; delta?: number });
	const termId = Number(body.term_id);
	const areaId = String(body.area_id ?? '');
	const delta = Number(body.delta);

	if (!termId || !areaId || !Number.isFinite(delta) || !Number.isInteger(delta)) {
		return Response.json({ error: 'term_id, area_id, delta(整数)を指定してください' }, { status: 400 });
	}

	const row = await env.DB.prepare(
		`SELECT term_data.id, term_data.distributed_total, term_data.assignee_id, areas.num_households
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.term_id = ? AND term_data.area_id = ?`,
	)
		.bind(termId, areaId)
		.first<{
			id: number;
			distributed_total: number;
			assignee_id: string | null;
			num_households: number;
		}>();

	if (!row) {
		return Response.json({ error: '指定されたターム・エリアの組み合わせが見つかりません' }, { status: 404 });
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

	// activity_logへの記録前に事前チェックしておく（ロック喪失時に監査ログだけが残る事故を避ける）。
	// 実際の整合性保証はこの後のUPDATE文のEXISTS条件（原子的チェック）側で行う。
	const preCheckLock = await env.DB.prepare(
		"SELECT 1 FROM edit_locks WHERE area_id = ? AND user_id = ? AND client_id = ? AND expires_at > datetime('now')",
	)
		.bind(areaId, user.user_id, clientIdOf(request) ?? '')
		.first();
	if (!preCheckLock) {
		return Response.json({ error: 'ロックの有効期限が切れました。区画を選び直してください' }, { status: 409 });
	}

	// 原子的チェック: 編集ロックを保持していること、かつ区画担当が設定済みであること（上の判定後に区画担当が
	// 外された場合に実績だけが残らないようにする。「実績が1以上の区画には必ず区画担当がいる」不変条件）。
	// activity_logはUPDATE成功後に記録する（拒否時に監査ログだけが残らないように）。
	const updateResult = await env.DB.prepare(
		`UPDATE term_data SET distributed_total = ?, distribution_rate = ?, last_updated_at = ?
		 WHERE id = ?
		   AND assignee_id IS NOT NULL
		   AND EXISTS (
		     SELECT 1 FROM edit_locks
		     WHERE area_id = ? AND user_id = ? AND client_id = ? AND expires_at > datetime('now')
		   )`,
	)
		.bind(newTotal, rate, now, row.id, areaId, user.user_id, clientIdOf(request) ?? '')
		.run();

	if (updateResult.meta.changes === 0) {
		const assigned = await env.DB.prepare('SELECT 1 FROM term_data WHERE id = ? AND assignee_id IS NOT NULL')
			.bind(row.id)
			.first();
		if (!assigned) {
			return Response.json({ error: '区画担当が未設定のためこの区画は配布記録の対象外です' }, { status: 400 });
		}
		return Response.json({ error: 'ロックの有効期限が切れました。区画を選び直してください' }, { status: 409 });
	}

	await env.DB.prepare(
		'INSERT INTO activity_log (term_id, area_id, updated_at, user_id, user_name, delta) VALUES (?, ?, ?, ?, ?, ?)',
	)
		.bind(termId, areaId, now, user.user_id, user.name, delta)
		.run();

	const updated = await env.DB.prepare(
		`SELECT areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			term_data.area_manager_id, term_data.area_manager_name,
			term_data.assignee_id, term_data.assignee_name, term_data.distributed_total,
			term_data.distribution_rate, term_data.last_updated_at
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.id = ?`,
	)
		.bind(row.id)
		.first();

	return Response.json(updated);
}

export async function setAssignee(request: Request, env: RecordsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; assignee_id?: string | null }>()
		.catch(() => ({}) as { term_id?: number; area_id?: string; assignee_id?: string | null });
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
	const result = await env.DB.prepare(
		`UPDATE term_data SET assignee_id = ?, assignee_name = ?
		 WHERE term_id = ? AND area_id = ?
		   AND (? IS NOT NULL OR distributed_total = 0)
		   AND EXISTS (
		     SELECT 1 FROM edit_locks
		     WHERE area_id = ? AND user_id = ? AND client_id = ? AND expires_at > datetime('now')
		   )`,
	)
		.bind(assigneeId, assigneeName, termId, areaId, assigneeId, areaId, user.user_id, clientIdOf(request) ?? '')
		.run();

	if (result.meta.changes === 0) {
		const current = await env.DB.prepare('SELECT distributed_total FROM term_data WHERE term_id = ? AND area_id = ?')
			.bind(termId, areaId)
			.first<{ distributed_total: number }>();
		if (!current) {
			return Response.json({ error: '指定されたターム・エリアの組み合わせが見つかりません' }, { status: 404 });
		}
		if (!assigneeId && current.distributed_total > 0) {
			return Response.json(
				{ error: '配布実績がある区画は区画担当を未担当にできません（実績を0に戻すと未担当にできます）' },
				{ status: 400 },
			);
		}
		return Response.json({ error: 'ロックの有効期限が切れました。区画を選び直してください' }, { status: 409 });
	}

	const updated = await env.DB.prepare(
		`SELECT areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			term_data.area_manager_id, term_data.area_manager_name,
			term_data.assignee_id, term_data.assignee_name, term_data.distributed_total,
			term_data.distribution_rate, term_data.last_updated_at
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.term_id = ? AND term_data.area_id = ?`,
	)
		.bind(termId, areaId)
		.first();

	return Response.json(updated);
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
 */
export async function setAreaManager(request: Request, env: RecordsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; area_manager_id?: string | null }>()
		.catch(() => ({}) as { term_id?: number; area_id?: string; area_manager_id?: string | null });
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

	const lockHolder = await checkChomeAreaLocked(env, area.chome_area_id, user.user_id, clientIdOf(request));
	if (lockHolder) {
		return Response.json({ error: lockedMessage(lockHolder) }, { status: 409 });
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

	await env.DB.batch([
		env.DB.prepare(
			`UPDATE term_data SET area_manager_id = ?, area_manager_name = ?
			 WHERE term_id = ?
			   AND area_id IN (SELECT area_id FROM areas WHERE chome_area_id = ?)`,
		).bind(areaManagerId, areaManagerName, termId, area.chome_area_id),
		env.DB.prepare(
			`UPDATE term_data SET assignee_id = ?, assignee_name = ?
			 WHERE term_id = ?
			   AND distributed_total = 0
			   AND area_id IN (SELECT area_id FROM areas WHERE chome_area_id = ? AND num_households > 0)`,
		).bind(areaManagerId, areaManagerName, termId, area.chome_area_id),
	]);

	const { results: updatedAreas } = await env.DB.prepare('SELECT area_id FROM areas WHERE chome_area_id = ?')
		.bind(area.chome_area_id)
		.all<{ area_id: string }>();

	return Response.json({
		area_manager_id: areaManagerId,
		area_manager_name: areaManagerName,
		updated_area_ids: updatedAreas.map((r) => r.area_id),
	});
}
