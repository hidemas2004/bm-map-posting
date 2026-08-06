import { parseCsv, stripBom } from './csv';

export interface PollingStationsEnv {
	DB: D1Database;
}

interface PollingStationRow {
	station_id: number;
	name: string;
	address: string;
	lat: number;
	lng: number;
}

export async function listPollingStations(env: PollingStationsEnv): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT station_id, name, address, lat, lng FROM polling_stations ORDER BY station_id',
	).all<PollingStationRow>();
	return Response.json(results);
}

/**
 * 投票所マスタ一括投入（管理者限定）。CSVヘッダ: name, address, lat, lng
 * （name, lat, lng は必須。address は空欄可）。
 * 投票所には area_id/user_id のような自然キーがCSV側に無い前提のため、アップサートではなく
 * アップロードのたびに全件洗い替え（DELETE→INSERT）する。
 */
export async function importPollingStations(request: Request, env: PollingStationsEnv): Promise<Response> {
	const text = stripBom(await request.text());

	const rows = parseCsv(text);
	if (rows.length === 0) {
		return Response.json({ error: 'CSVが空です' }, { status: 400 });
	}

	const header = rows[0].map((h) => h.trim());
	const colIndex = {
		name: header.indexOf('name'),
		address: header.indexOf('address'),
		lat: header.indexOf('lat'),
		lng: header.indexOf('lng'),
	};
	if (colIndex.name === -1 || colIndex.lat === -1 || colIndex.lng === -1) {
		return Response.json({ error: 'CSVヘッダに name, lat, lng が必要です' }, { status: 400 });
	}

	const dataRows = rows.slice(1);
	if (dataRows.length === 0) {
		return Response.json({ error: 'データ行がありません' }, { status: 400 });
	}

	const stations: { name: string; address: string; lat: number; lng: number }[] = [];
	for (const [i, r] of dataRows.entries()) {
		const lineNo = i + 2; // ヘッダ行ぶん+1、1始まりで+1
		const name = (r[colIndex.name] ?? '').trim();
		const address = colIndex.address !== -1 ? (r[colIndex.address] ?? '').trim() : '';
		const lat = Number((r[colIndex.lat] ?? '').trim());
		const lng = Number((r[colIndex.lng] ?? '').trim());

		if (!name) {
			return Response.json({ error: `${lineNo}行目: name は必須です` }, { status: 400 });
		}
		if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
			return Response.json({ error: `${lineNo}行目: lat が不正です` }, { status: 400 });
		}
		if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
			return Response.json({ error: `${lineNo}行目: lng が不正です` }, { status: 400 });
		}

		stations.push({ name, address, lat, lng });
	}

	const statements = [
		env.DB.prepare('DELETE FROM polling_stations'),
		...stations.map((s) =>
			env.DB.prepare('INSERT INTO polling_stations (name, address, lat, lng) VALUES (?, ?, ?, ?)').bind(
				s.name,
				s.address,
				s.lat,
				s.lng,
			),
		),
	];
	await env.DB.batch(statements);

	return Response.json({ imported: stations.length });
}
