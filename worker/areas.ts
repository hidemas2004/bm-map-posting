import { csvResponse, toCsv } from './csv';

export interface AreasEnv {
	DB: D1Database;
	AREAS_IMPORT_TOKEN: string;
}

interface AreaRow {
	area_id: string;
	city: string;
	ward: string;
	town: string;
	chome: string;
	chome_area_id: string;
	block: string;
	num_households: number;
	area_manager_id: string | null;
	area_manager_name: string;
}

export async function listAreas(env: AreasEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM areas ORDER BY area_id').all();
	return Response.json(results);
}

interface CurrentTerm {
	term_id: number;
	term_name: string;
}

interface AreaWithCurrentTerm extends AreaRow {
	assignee_name: string;
	distributed_total: number;
	distribution_rate: number;
}

/**
 * 地域マスタに、現在進行中タームの担当・配布数・配布率を付加する。
 * 進行中タームが無い場合、または area が現タームの term_data 行を持たない場合
 * （タームより後に追加された地域など）は 0/0/未担当 として扱う。
 */
async function areasWithCurrentTermStats(
	env: AreasEnv,
): Promise<{ areas: AreaWithCurrentTerm[]; term: CurrentTerm | null }> {
	const [{ results: areaRows }, term] = await Promise.all([
		env.DB.prepare('SELECT * FROM areas ORDER BY area_id').all<AreaRow>(),
		env.DB.prepare("SELECT term_id, term_name FROM terms WHERE status = '進行中'").first<CurrentTerm>(),
	]);

	if (!term) {
		return {
			areas: areaRows.map((area) => ({ ...area, assignee_name: '', distributed_total: 0, distribution_rate: 0 })),
			term: null,
		};
	}

	const { results: termDataRows } = await env.DB.prepare(
		'SELECT area_id, assignee_name, distributed_total, distribution_rate FROM term_data WHERE term_id = ?',
	)
		.bind(term.term_id)
		.all<{ area_id: string; assignee_name: string; distributed_total: number; distribution_rate: number }>();

	const statByAreaId = new Map(termDataRows.map((row) => [row.area_id, row]));

	const areas = areaRows.map((area) => {
		const stat = statByAreaId.get(area.area_id);
		return {
			...area,
			assignee_name: stat?.assignee_name ?? '',
			distributed_total: stat?.distributed_total ?? 0,
			distribution_rate: stat?.distribution_rate ?? 0,
		};
	});

	return { areas, term };
}

export async function listAreasWithCurrentTerm(env: AreasEnv): Promise<Response> {
	const { areas, term } = await areasWithCurrentTermStats(env);
	return Response.json({ areas, term });
}

export async function exportAreasCsv(env: AreasEnv): Promise<Response> {
	const { areas } = await areasWithCurrentTermStats(env);
	const headers = ['area_id', '市区町村', '区', '町丁目', '丁目', 'エリアID', '区画', '世帯数', '対象', 'エリア担当', '担当', '配布数', '配布率(%)'];
	const rows = areas.map((area) => [
		area.area_id,
		area.city,
		area.ward,
		area.town,
		area.chome,
		area.chome_area_id,
		area.block,
		area.num_households,
		area.area_manager_id ? 1 : 0,
		area.area_manager_name,
		area.assignee_name,
		area.distributed_total,
		area.distribution_rate,
	]);
	return csvResponse(toCsv(headers, rows), 'areas.csv');
}

interface ImportArea {
	area_id: string;
	city: string;
	ward?: string; // 区を持たない市区町村（政令指定都市以外）では空文字
	town?: string;
	chome?: string;
	chome_area_id?: string; // 区画が属する「エリア」のID（boundary_chome.geojsonのarea_id）。省略時はarea_id自身にフォールバック
	block?: string; // 同一丁目内で基本単位区が複数に分かれる場合の区別用通し番号（無ければ空文字）
	num_households: number;
}

/**
 * 地域マスタ一括投入。`area_id` が既存なら上書き（UPSERT）、なければ新規追加。
 * 通常のユーザーログインとは別運用（外部スクリプト等からの投入を想定）のため、
 * セッション認証は経由せず `X-Import-Token` ヘッダを `AREAS_IMPORT_TOKEN` と照合する。
 * 進行中タームがある場合、新規追加された area の term_data 行をゼロクリア状態で補完する
 * （`createNewTerm` と同じ考え方。既存 area_id の term_data は変更しない）。
 */
export async function importAreas(request: Request, env: AreasEnv): Promise<Response> {
	const token = request.headers.get('X-Import-Token') ?? '';
	if (!env.AREAS_IMPORT_TOKEN || token !== env.AREAS_IMPORT_TOKEN) {
		return Response.json({ error: '認証が必要です' }, { status: 401 });
	}

	const body = await request.json<{ areas?: ImportArea[] }>().catch(() => ({}) as { areas?: ImportArea[] });
	const areas = body.areas;
	if (!Array.isArray(areas) || areas.length === 0) {
		return Response.json({ error: 'areas(配列)を指定してください' }, { status: 400 });
	}
	for (const [i, area] of areas.entries()) {
		if (!area || !area.area_id || !area.city || !Number.isFinite(area.num_households)) {
			return Response.json(
				{ error: `areas[${i}]: area_id, city, num_households(数値)は必須です` },
				{ status: 400 },
			);
		}
	}

	const upserts = areas.map((area) =>
		env.DB.prepare(
			`INSERT INTO areas (area_id, city, ward, town, chome, block, num_households, chome_area_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(area_id) DO UPDATE SET
			   city = excluded.city, ward = excluded.ward, town = excluded.town,
			   chome = excluded.chome, block = excluded.block, num_households = excluded.num_households,
			   chome_area_id = excluded.chome_area_id`,
		).bind(
			area.area_id,
			area.city,
			area.ward ?? '',
			area.town ?? '',
			area.chome ?? '',
			area.block ?? '',
			area.num_households,
			area.chome_area_id ?? area.area_id,
		),
	);
	await env.DB.batch(upserts);

	const activeTerm = await env.DB.prepare("SELECT term_id FROM terms WHERE status = '進行中'").first<{
		term_id: number;
	}>();
	if (activeTerm) {
		await env.DB.prepare(
			`INSERT INTO term_data (term_id, area_id, assignee_id, assignee_name, distributed_total, distribution_rate, last_updated_at)
			 SELECT ?, area_id, NULL, '', 0, 0, NULL FROM areas
			 WHERE area_id NOT IN (SELECT area_id FROM term_data WHERE term_id = ?)`,
		)
			.bind(activeTerm.term_id, activeTerm.term_id)
			.run();
	}

	return Response.json({ imported: areas.length });
}
