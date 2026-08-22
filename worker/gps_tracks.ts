import type { SessionUser } from './auth';

/**
 * GPS移動軌跡の記録・照会機能。comments/polling_stationsと同様、term/areaに紐付かない
 * 独立データ。track（記録セッション、gps_tracks）とpoint（座標点、gps_track_points）を
 * 分割している（track一覧の軽量取得のため）。
 */

const MAX_POINTS_PER_REQUEST = 200;

export interface GpsTracksEnv {
	DB: D1Database;
}

interface TrackRow {
	track_id: number;
	user_id: string;
	user_name: string;
	term_id: number | null;
	started_at: string;
	ended_at: string | null;
	point_count: number;
}

interface PointRow {
	track_id: number;
	lat: number;
	lng: number;
	recorded_at: string;
	accuracy: number | null;
}

function validatePoint(p: unknown): { lat: number; lng: number; recorded_at: string; accuracy: number | null } | null {
	if (typeof p !== 'object' || p === null) return null;
	const { lat, lng, recorded_at, accuracy } = p as Record<string, unknown>;
	const latNum = Number(lat);
	const lngNum = Number(lng);
	if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) return null;
	if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) return null;
	const recordedAt = typeof recorded_at === 'string' && recorded_at ? recorded_at : new Date().toISOString();
	const accuracyNum = accuracy === undefined || accuracy === null ? null : Number(accuracy);
	return {
		lat: latNum,
		lng: lngNum,
		recorded_at: recordedAt,
		accuracy: accuracyNum !== null && Number.isFinite(accuracyNum) ? accuracyNum : null,
	};
}

export async function startTrack(env: GpsTracksEnv, user: SessionUser): Promise<Response> {
	const now = new Date().toISOString();

	// 前回の記録がタブの異常終了等でstopされないまま残っている場合、孤立させないよう
	// 確定させてから新規trackを作成する。終了時刻は「今回のstart時刻」ではなく、実際に
	// 最後に記録できていた座標点の時刻を使う（記録点が無ければstarted_atにフォールバック）。
	// 今回のstart時刻を使うと、タブを閉じてから次にSTARTを押すまでの時間がそのまま
	// 記録時間に混入してしまうため。
	await env.DB.prepare(
		`UPDATE gps_tracks
		 SET ended_at = COALESCE((SELECT MAX(recorded_at) FROM gps_track_points WHERE track_id = gps_tracks.track_id), started_at)
		 WHERE user_id = ? AND ended_at IS NULL`,
	)
		.bind(user.user_id)
		.run();

	// 記録開始時点で進行中のタームにデータを紐づける。クライアント側で選択中のタームとは
	// 独立に、サーバー側で権威的に判定する。進行中タームが無ければNULLのまま記録を許可する。
	const activeTerm = await env.DB.prepare("SELECT term_id FROM terms WHERE status = '進行中'").first<{ term_id: number }>();

	const result = await env.DB.prepare(
		'INSERT INTO gps_tracks (user_id, user_name, term_id, started_at, ended_at, point_count) VALUES (?, ?, ?, ?, NULL, 0)',
	)
		.bind(user.user_id, user.name, activeTerm?.term_id ?? null, now)
		.run();

	return Response.json({ track_id: result.meta.last_row_id, started_at: now });
}

async function findOwnTrack(env: GpsTracksEnv, user: SessionUser, trackId: number): Promise<TrackRow | null> {
	const row = await env.DB.prepare('SELECT * FROM gps_tracks WHERE track_id = ?').bind(trackId).first<TrackRow>();
	if (!row || row.user_id !== user.user_id) return null;
	return row;
}

export async function submitTrackPoints(request: Request, env: GpsTracksEnv, user: SessionUser, trackIdParam: string): Promise<Response> {
	const trackId = Number(trackIdParam);
	if (!Number.isInteger(trackId)) {
		return Response.json({ error: 'track_id が不正です' }, { status: 400 });
	}
	const track = await findOwnTrack(env, user, trackId);
	if (!track) {
		return Response.json({ error: '指定された記録が見つかりません' }, { status: 404 });
	}

	const body = await request.json<{ points?: unknown[] }>().catch(() => ({}) as { points?: unknown[] });
	if (!Array.isArray(body.points) || body.points.length === 0) {
		return Response.json({ error: 'points を指定してください' }, { status: 400 });
	}
	if (body.points.length > MAX_POINTS_PER_REQUEST) {
		return Response.json({ error: `points は${MAX_POINTS_PER_REQUEST}件以下にしてください` }, { status: 400 });
	}

	const points = body.points.map(validatePoint);
	if (points.some((p) => p === null)) {
		return Response.json({ error: '座標データが不正です' }, { status: 400 });
	}

	const statements = [
		...(points as NonNullable<ReturnType<typeof validatePoint>>[]).map((p) =>
			env.DB.prepare('INSERT INTO gps_track_points (track_id, lat, lng, recorded_at, accuracy) VALUES (?, ?, ?, ?, ?)').bind(
				trackId,
				p.lat,
				p.lng,
				p.recorded_at,
				p.accuracy,
			),
		),
		env.DB.prepare('UPDATE gps_tracks SET point_count = point_count + ? WHERE track_id = ?').bind(points.length, trackId),
	];
	await env.DB.batch(statements);

	return Response.json({ inserted: points.length });
}

export async function stopTrack(env: GpsTracksEnv, user: SessionUser, trackIdParam: string): Promise<Response> {
	const trackId = Number(trackIdParam);
	if (!Number.isInteger(trackId)) {
		return Response.json({ error: 'track_id が不正です' }, { status: 400 });
	}
	const track = await findOwnTrack(env, user, trackId);
	if (!track) {
		return Response.json({ error: '指定された記録が見つかりません' }, { status: 404 });
	}

	const now = track.ended_at ?? new Date().toISOString();
	if (!track.ended_at) {
		await env.DB.prepare('UPDATE gps_tracks SET ended_at = ? WHERE track_id = ?').bind(now, trackId).run();
	}

	return Response.json({ track_id: trackId, ended_at: now });
}

function durationSeconds(startedAt: string, effectiveEndedAt: string): number {
	return Math.max(0, (new Date(effectiveEndedAt).getTime() - new Date(startedAt).getTime()) / 1000);
}

export async function queryTracks(env: GpsTracksEnv, user: SessionUser, url: URL): Promise<Response> {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	if (!from || !to) {
		return Response.json({ error: 'from・to を指定してください' }, { status: 400 });
	}
	// summary=1: 累積時間表示など、座標点そのものが不要な用途向けの軽量モード。
	// gps_track_pointsの全件取得を行わず、ended_at未確定分だけ最終recorded_atを集計取得する。
	const summary = url.searchParams.get('summary') === '1';

	const requestedUserId = url.searchParams.get('user_id');
	// 一般ユーザーはuser_id指定に関わらず常に本人のみ。管理者のみ他ユーザー指定・全員表示が可能。
	const targetUserId = user.role === '管理者' ? requestedUserId : user.user_id;

	// from/toはJST（この機能の利用地域）のカレンダー日として解釈し、started_at（サーバーが
	// toISOString()で保存するUTCのISO 8601、T区切り・Z付き）と同じ書式のUTC境界に変換する。
	// スペース区切りの文字列のまま比較すると、'T'(0x54) > ' '(0x20)により
	// started_at <= toTs が同日中は常に不成立になり、結果が0件になるバグがあったため。
	const fromDate = new Date(`${from}T00:00:00+09:00`);
	const toDate = new Date(`${to}T23:59:59.999+09:00`);
	if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
		return Response.json({ error: 'from・to の形式が不正です' }, { status: 400 });
	}
	const fromTs = fromDate.toISOString();
	const toTs = toDate.toISOString();

	const tracks = targetUserId
		? await env.DB.prepare(
				'SELECT * FROM gps_tracks WHERE user_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at',
			)
				.bind(targetUserId, fromTs, toTs)
				.all<TrackRow>()
		: await env.DB.prepare('SELECT * FROM gps_tracks WHERE started_at >= ? AND started_at <= ? ORDER BY started_at')
				.bind(fromTs, toTs)
				.all<TrackRow>();

	const trackRows = tracks.results;
	if (trackRows.length === 0) {
		return Response.json({ tracks: [] });
	}

	if (summary) {
		// ended_atが未確定のtrackだけ、そのtrack_idに絞って最終recorded_atを集計取得する
		// （idx_gps_track_points_track (track_id, recorded_at) によりtrack単位のインデックス
		// 末尾参照で済み、座標点数に関わらず軽量）。
		const pendingTrackIds = trackRows.filter((t) => !t.ended_at).map((t) => t.track_id);
		const lastRecordedByTrack = new Map<number, string>();
		if (pendingTrackIds.length > 0) {
			const placeholders = pendingTrackIds.map(() => '?').join(',');
			const lastPoints = await env.DB.prepare(
				`SELECT track_id, MAX(recorded_at) AS last_recorded_at FROM gps_track_points WHERE track_id IN (${placeholders}) GROUP BY track_id`,
			)
				.bind(...pendingTrackIds)
				.all<{ track_id: number; last_recorded_at: string }>();
			for (const row of lastPoints.results) {
				lastRecordedByTrack.set(row.track_id, row.last_recorded_at);
			}
		}
		return Response.json({
			tracks: trackRows.map((t) => {
				const effectiveEndedAt = t.ended_at ?? lastRecordedByTrack.get(t.track_id) ?? t.started_at;
				return {
					track_id: t.track_id,
					user_id: t.user_id,
					user_name: t.user_name,
					term_id: t.term_id,
					started_at: t.started_at,
					ended_at: t.ended_at,
					duration_seconds: durationSeconds(t.started_at, effectiveEndedAt),
				};
			}),
		});
	}

	const placeholders = trackRows.map(() => '?').join(',');
	const points = await env.DB.prepare(
		`SELECT track_id, lat, lng, recorded_at, accuracy FROM gps_track_points WHERE track_id IN (${placeholders}) ORDER BY track_id, recorded_at`,
	)
		.bind(...trackRows.map((t) => t.track_id))
		.all<PointRow>();

	const pointsByTrack = new Map<number, PointRow[]>();
	for (const p of points.results) {
		if (!pointsByTrack.has(p.track_id)) pointsByTrack.set(p.track_id, []);
		pointsByTrack.get(p.track_id)!.push(p);
	}

	return Response.json({
		tracks: trackRows.map((t) => {
			const pts = pointsByTrack.get(t.track_id) ?? [];
			// ended_atが未確定（記録中、または何らかの理由で孤立確定前）の場合は、最終記録点の
			// 時刻をフォールバックとして使う（startTrackの孤立トラック確定と同じ考え方）。
			const effectiveEndedAt = t.ended_at ?? pts[pts.length - 1]?.recorded_at ?? t.started_at;
			return {
				track_id: t.track_id,
				user_id: t.user_id,
				user_name: t.user_name,
				term_id: t.term_id,
				started_at: t.started_at,
				ended_at: t.ended_at,
				duration_seconds: durationSeconds(t.started_at, effectiveEndedAt),
				points: pts.map((p) => ({ lat: p.lat, lng: p.lng, recorded_at: p.recorded_at, accuracy: p.accuracy })),
			};
		}),
	});
}
