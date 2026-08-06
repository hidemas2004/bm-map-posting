import type { SessionUser } from './auth';

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
		`SELECT term_data.id, term_data.distributed_total, areas.num_households, areas.area_manager_id
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.term_id = ? AND term_data.area_id = ?`,
	)
		.bind(termId, areaId)
		.first<{ id: number; distributed_total: number; num_households: number; area_manager_id: string | null }>();

	if (!row) {
		return Response.json({ error: '指定されたターム・エリアの組み合わせが見つかりません' }, { status: 404 });
	}
	if (row.num_households === 0) {
		return Response.json({ error: '世帯数が0のためこのエリアは配布記録の対象外です' }, { status: 400 });
	}
	if (!row.area_manager_id) {
		return Response.json({ error: 'エリア担当が未設定のためこのエリアは配布記録の対象外です' }, { status: 400 });
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

	await env.DB.prepare(
		'INSERT INTO activity_log (term_id, area_id, updated_at, user_id, user_name, delta) VALUES (?, ?, ?, ?, ?, ?)',
	)
		.bind(termId, areaId, now, user.user_id, user.name, delta)
		.run();

	await env.DB.prepare(
		'UPDATE term_data SET distributed_total = ?, distribution_rate = ?, last_updated_at = ? WHERE id = ?',
	)
		.bind(newTotal, rate, now, row.id)
		.run();

	const updated = await env.DB.prepare(
		`SELECT areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			areas.area_manager_id, areas.area_manager_name,
			term_data.assignee_id, term_data.assignee_name, term_data.distributed_total,
			term_data.distribution_rate, term_data.last_updated_at
		 FROM term_data JOIN areas ON areas.area_id = term_data.area_id
		 WHERE term_data.id = ?`,
	)
		.bind(row.id)
		.first();

	return Response.json(updated);
}

export async function setAssignee(request: Request, env: RecordsEnv): Promise<Response> {
	const body = await request
		.json<{ term_id?: number; area_id?: string; assignee_id?: string | null }>()
		.catch(() => ({}) as { term_id?: number; area_id?: string; assignee_id?: string | null });
	const termId = Number(body.term_id);
	const areaId = String(body.area_id ?? '');
	const assigneeId = body.assignee_id ?? null;

	if (!termId || !areaId) {
		return Response.json({ error: 'term_id, area_id を指定してください' }, { status: 400 });
	}

	const area = await env.DB.prepare('SELECT num_households, area_manager_id FROM areas WHERE area_id = ?')
		.bind(areaId)
		.first<{ num_households: number; area_manager_id: string | null }>();
	if (!area) {
		return Response.json({ error: '指定されたエリアが見つかりません' }, { status: 404 });
	}
	if (area.num_households === 0) {
		return Response.json({ error: '世帯数が0のためこのエリアには担当者を設定できません' }, { status: 400 });
	}
	if (!area.area_manager_id) {
		return Response.json({ error: 'エリア担当が未設定のためこのエリアには担当者を設定できません' }, { status: 400 });
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

	const result = await env.DB.prepare(
		'UPDATE term_data SET assignee_id = ?, assignee_name = ? WHERE term_id = ? AND area_id = ?',
	)
		.bind(assigneeId, assigneeName, termId, areaId)
		.run();

	if (result.meta.changes === 0) {
		return Response.json({ error: '指定されたターム・エリアの組み合わせが見つかりません' }, { status: 404 });
	}

	const updated = await env.DB.prepare(
		`SELECT areas.area_id, areas.city, areas.ward, areas.town, areas.chome, areas.chome_area_id, areas.block, areas.num_households,
			areas.area_manager_id, areas.area_manager_name,
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
 * エリア担当（chome_area_id単位。boundary_chome.geojsonの境界ポリゴンに対応）を設定する。
 * 同一エリア内の全区画（世帯数0を含む）の area_manager_id/area_manager_name を一括更新し、
 * エリア担当を設定した場合はさらに現在進行中タームの担当者(term_data.assignee)を、
 * 同一エリア内の全区画（世帯数>0のもの）へ一括反映する（既に担当者が設定されている区画も上書きする）。
 * エリア担当を未設定(null)に戻す場合は area_manager のみ更新し、担当者の一括反映は行わない。
 */
export async function setAreaManager(request: Request, env: RecordsEnv): Promise<Response> {
	const body = await request
		.json<{ area_id?: string; area_manager_id?: string | null }>()
		.catch(() => ({}) as { area_id?: string; area_manager_id?: string | null });
	const areaId = String(body.area_id ?? '');
	const areaManagerId = body.area_manager_id ?? null;

	if (!areaId) {
		return Response.json({ error: 'area_id を指定してください' }, { status: 400 });
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

	await env.DB.prepare('UPDATE areas SET area_manager_id = ?, area_manager_name = ? WHERE chome_area_id = ?')
		.bind(areaManagerId, areaManagerName, area.chome_area_id)
		.run();

	if (areaManagerId) {
		const activeTerm = await env.DB.prepare("SELECT term_id FROM terms WHERE status = '進行中'").first<{
			term_id: number;
		}>();
		if (activeTerm) {
			await env.DB.prepare(
				`UPDATE term_data SET assignee_id = ?, assignee_name = ?
				 WHERE term_id = ?
				   AND area_id IN (SELECT area_id FROM areas WHERE chome_area_id = ? AND num_households > 0)`,
			)
				.bind(areaManagerId, areaManagerName, activeTerm.term_id, area.chome_area_id)
				.run();
		}
	}

	const { results: updatedAreas } = await env.DB.prepare('SELECT area_id FROM areas WHERE chome_area_id = ?')
		.bind(area.chome_area_id)
		.all<{ area_id: string }>();

	return Response.json({
		area_manager_id: areaManagerId,
		area_manager_name: areaManagerName,
		updated_area_ids: updatedAreas.map((r) => r.area_id),
	});
}
