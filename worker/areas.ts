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
	num_households: number;
}

export async function listAreas(env: AreasEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM areas ORDER BY area_id').all();
	return Response.json(results);
}

const RECENT_TERMS_LIMIT = 5;

interface TermSummary {
	term_id: number;
	term_name: string;
}

interface AreaTermStat {
	term_id: number;
	term_name: string;
	distributed_total: number;
	distribution_rate: number;
}

interface AreaWithTerms extends AreaRow {
	terms: AreaTermStat[];
}

/**
 * 地域マスタに、直近 RECENT_TERMS_LIMIT タームぶんの配布数・配布率を横持ちで付加する。
 * ある area が該当タームの term_data 行を持たない場合（タームより後に追加された地域など）は
 * 0/0 として扱う（`importAreas` は進行中タームにしか term_data を補完しないため起こりうる）。
 */
async function areasWithRecentTermStats(
	env: AreasEnv,
): Promise<{ areas: AreaWithTerms[]; terms: TermSummary[] }> {
	const [{ results: areaRows }, { results: terms }] = await Promise.all([
		env.DB.prepare('SELECT * FROM areas ORDER BY area_id').all<AreaRow>(),
		env.DB.prepare('SELECT term_id, term_name FROM terms ORDER BY term_id DESC LIMIT ?')
			.bind(RECENT_TERMS_LIMIT)
			.all<TermSummary>(),
	]);

	if (terms.length === 0) {
		return { areas: areaRows.map((area) => ({ ...area, terms: [] })), terms: [] };
	}

	const placeholders = terms.map(() => '?').join(',');
	const { results: termDataRows } = await env.DB.prepare(
		`SELECT area_id, term_id, distributed_total, distribution_rate FROM term_data WHERE term_id IN (${placeholders})`,
	)
		.bind(...terms.map((t) => t.term_id))
		.all<{ area_id: string; term_id: number; distributed_total: number; distribution_rate: number }>();

	const statByKey = new Map(termDataRows.map((row) => [`${row.area_id}:${row.term_id}`, row]));

	const areas = areaRows.map((area) => ({
		...area,
		terms: terms.map((t) => {
			const stat = statByKey.get(`${area.area_id}:${t.term_id}`);
			return {
				term_id: t.term_id,
				term_name: t.term_name,
				distributed_total: stat?.distributed_total ?? 0,
				distribution_rate: stat?.distribution_rate ?? 0,
			};
		}),
	}));

	return { areas, terms };
}

export async function listAreasWithRecentTerms(env: AreasEnv): Promise<Response> {
	const { areas, terms } = await areasWithRecentTermStats(env);
	return Response.json({ areas, terms });
}

export async function exportAreasCsv(env: AreasEnv): Promise<Response> {
	const { areas, terms } = await areasWithRecentTermStats(env);
	const headers = ['area_id', '市区町村', '区', '町丁目', '丁目', '世帯数'];
	for (const t of terms) {
		headers.push(`${t.term_name}_配布数`, `${t.term_name}_配布率(%)`);
	}
	const rows = areas.map((area) => {
		const row: (string | number)[] = [area.area_id, area.city, area.ward, area.town, area.chome, area.num_households];
		for (const t of area.terms) {
			row.push(t.distributed_total, t.distribution_rate);
		}
		return row;
	});
	return csvResponse(toCsv(headers, rows), 'areas.csv');
}

interface ImportArea {
	area_id: string;
	city: string;
	ward?: string; // 区を持たない市区町村（政令指定都市以外）では空文字
	town?: string;
	chome?: string;
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
			`INSERT INTO areas (area_id, city, ward, town, chome, num_households)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(area_id) DO UPDATE SET
			   city = excluded.city, ward = excluded.ward, town = excluded.town,
			   chome = excluded.chome, num_households = excluded.num_households`,
		).bind(area.area_id, area.city, area.ward ?? '', area.town ?? '', area.chome ?? '', area.num_households),
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
