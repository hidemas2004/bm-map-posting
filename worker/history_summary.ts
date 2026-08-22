/**
 * 新メニュー「履歴集計」。指定期間における各メンバー（および全体合計）の配布枚数・
 * 軌跡時間・移動距離を横断集計する。activity_log（配布枚数）とgps_tracks（軌跡時間・
 * 移動距離）を突き合わせるだけの読み取り専用集計で、term/areaに紐づく既存のcomments/
 * gps_tracks等と同様に独立したモジュールとして切り出す。
 */

export interface HistorySummaryEnv {
	DB: D1Database;
}

interface DistributedRow {
	user_id: string;
	user_name: string;
	distributed_total: number;
}

interface TrackAggregateRow {
	user_id: string;
	user_name: string;
	duration_seconds: number;
	distance_meters: number;
}

interface ActiveUserRow {
	user_id: string;
	name: string;
}

export interface HistorySummaryRow {
	user_id: string;
	user_name: string;
	distributed_total: number;
	duration_seconds: number;
	distance_meters: number;
}

export async function getHistorySummary(env: HistorySummaryEnv, url: URL): Promise<Response> {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	if (!from || !to) {
		return Response.json({ error: 'from・to を指定してください' }, { status: 400 });
	}

	// from/toはJST（この機能の利用地域）のカレンダー日として解釈し、updated_at/started_at
	// （サーバーがtoISOString()で保存するUTCのISO 8601、T区切り・Z付き）と同じ書式のUTC境界に
	// 変換する（worker/gps_tracks.tsのqueryTracksと同じロジック）。
	const fromDate = new Date(`${from}T00:00:00+09:00`);
	const toDate = new Date(`${to}T23:59:59.999+09:00`);
	if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
		return Response.json({ error: 'from・to の形式が不正です' }, { status: 400 });
	}
	const fromTs = fromDate.toISOString();
	const toTs = toDate.toISOString();

	const [activeUsers, distributed, tracks] = await Promise.all([
		env.DB.prepare('SELECT user_id, name FROM users WHERE active = 1 ORDER BY name').all<ActiveUserRow>(),
		env.DB.prepare(
			`SELECT user_id, user_name, SUM(delta) AS distributed_total
			 FROM activity_log
			 WHERE updated_at >= ? AND updated_at <= ?
			 GROUP BY user_id, user_name`,
		)
			.bind(fromTs, toTs)
			.all<DistributedRow>(),
		env.DB.prepare(
			`SELECT user_id, user_name,
				SUM(distance_meters) AS distance_meters,
				SUM(
					(julianday(COALESCE(ended_at, (SELECT MAX(recorded_at) FROM gps_track_points WHERE track_id = gps_tracks.track_id), started_at))
					 - julianday(started_at)) * 86400
				) AS duration_seconds
			 FROM gps_tracks
			 WHERE started_at >= ? AND started_at <= ?
			 GROUP BY user_id, user_name`,
		)
			.bind(fromTs, toTs)
			.all<TrackAggregateRow>(),
	]);

	const rowsByUser = new Map<string, HistorySummaryRow>();
	for (const u of activeUsers.results) {
		rowsByUser.set(u.user_id, { user_id: u.user_id, user_name: u.name, distributed_total: 0, duration_seconds: 0, distance_meters: 0 });
	}
	for (const d of distributed.results) {
		const row = rowsByUser.get(d.user_id) ?? { user_id: d.user_id, user_name: d.user_name, distributed_total: 0, duration_seconds: 0, distance_meters: 0 };
		row.distributed_total = d.distributed_total ?? 0;
		rowsByUser.set(d.user_id, row);
	}
	for (const t of tracks.results) {
		const row = rowsByUser.get(t.user_id) ?? { user_id: t.user_id, user_name: t.user_name, distributed_total: 0, duration_seconds: 0, distance_meters: 0 };
		row.duration_seconds = t.duration_seconds ?? 0;
		row.distance_meters = t.distance_meters ?? 0;
		rowsByUser.set(t.user_id, row);
	}

	const rows = [...rowsByUser.values()].sort((a, b) => a.user_name.localeCompare(b.user_name, 'ja'));
	const total = rows.reduce(
		(acc, r) => ({
			distributed_total: acc.distributed_total + r.distributed_total,
			duration_seconds: acc.duration_seconds + r.duration_seconds,
			distance_meters: acc.distance_meters + r.distance_meters,
		}),
		{ distributed_total: 0, duration_seconds: 0, distance_meters: 0 },
	);

	return Response.json({ rows, total });
}
