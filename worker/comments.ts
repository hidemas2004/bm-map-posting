import type { SessionUser } from './auth';

/**
 * 地図コメント機能（issue#24）。投票所(polling_stations.ts)と同じくterm/areaに紐付かない
 * 独立データ。カテゴリ定義・「その他」の選択可能ピン色はここで一元管理し、worker/config.ts
 * がそのままフロントへ埋め込む（バックエンドのバリデーション値とフロントの選択肢を単一ソース化）。
 */

export const COMMENT_CATEGORIES = [
	{ value: 'no_posting', label: 'ポスト禁止', color: '#dc2626' },
	{ value: 'poster_candidate', label: 'ポスター候補', color: '#16a34a' },
	{ value: 'other', label: 'その他', color: null },
] as const;

export type CommentCategory = (typeof COMMENT_CATEGORIES)[number]['value'];
const CATEGORY_VALUES: readonly string[] = COMMENT_CATEGORIES.map((c) => c.value);

export const COMMENT_OTHER_PIN_COLORS = ['#f59e0b', '#7c3aed', '#0d9488'] as const;

export interface CommentsEnv {
	DB: D1Database;
	COMMENT_IMAGES: R2Bucket;
}

interface CommentRow {
	comment_id: number;
	lat: number;
	lng: number;
	category: CommentCategory;
	pin_color: string;
	body: string;
	image_key: string | null;
	image_content_type: string | null;
	created_by_id: string;
	created_by_name: string;
	created_at: string;
	updated_by_id: string;
	updated_by_name: string;
	updated_at: string;
}

function toPublicComment(row: CommentRow) {
	return {
		comment_id: row.comment_id,
		lat: row.lat,
		lng: row.lng,
		category: row.category,
		pin_color: row.pin_color,
		body: row.body,
		has_image: row.image_key !== null,
		created_by_name: row.created_by_name,
		created_at: row.created_at,
		updated_by_name: row.updated_by_name,
		updated_at: row.updated_at,
	};
}

function validateCategoryAndColor(category: unknown, pinColor: unknown): { category: CommentCategory; pinColor: string } | null {
	if (typeof category !== 'string' || !CATEGORY_VALUES.includes(category)) return null;
	if (category === 'other') {
		if (typeof pinColor !== 'string' || !(COMMENT_OTHER_PIN_COLORS as readonly string[]).includes(pinColor)) return null;
		return { category: category as CommentCategory, pinColor };
	}
	return { category: category as CommentCategory, pinColor: '' };
}

export async function listComments(env: CommentsEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM comments ORDER BY comment_id').all<CommentRow>();
	return Response.json(results.map(toPublicComment));
}

export async function createComment(request: Request, env: CommentsEnv, user: SessionUser): Promise<Response> {
	const body = await request
		.json<{ lat?: number; lng?: number; category?: string; pin_color?: string; body?: string }>()
		.catch(() => ({}) as { lat?: number; lng?: number; category?: string; pin_color?: string; body?: string });

	const lat = Number(body.lat);
	const lng = Number(body.lng);
	if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
		return Response.json({ error: '位置情報が不正です' }, { status: 400 });
	}
	const validated = validateCategoryAndColor(body.category, body.pin_color);
	if (!validated) {
		return Response.json({ error: 'コメント理由またはピンの色が不正です' }, { status: 400 });
	}
	const text = String(body.body ?? '').slice(0, 2000);
	const now = new Date().toISOString();

	const result = await env.DB.prepare(
		`INSERT INTO comments (lat, lng, category, pin_color, body, created_by_id, created_by_name, created_at, updated_by_id, updated_by_name, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(lat, lng, validated.category, validated.pinColor, text, user.user_id, user.name, now, user.user_id, user.name, now)
		.run();

	const row = await env.DB.prepare('SELECT * FROM comments WHERE comment_id = ?')
		.bind(result.meta.last_row_id)
		.first<CommentRow>();
	return Response.json(toPublicComment(row!));
}

export async function updateComment(request: Request, env: CommentsEnv, user: SessionUser, commentId: string): Promise<Response> {
	const id = Number(commentId);
	if (!Number.isInteger(id)) {
		return Response.json({ error: 'comment_id が不正です' }, { status: 400 });
	}
	const body = await request
		.json<{ category?: string; pin_color?: string; body?: string }>()
		.catch(() => ({}) as { category?: string; pin_color?: string; body?: string });

	const validated = validateCategoryAndColor(body.category, body.pin_color);
	if (!validated) {
		return Response.json({ error: 'コメント理由またはピンの色が不正です' }, { status: 400 });
	}
	const text = String(body.body ?? '').slice(0, 2000);
	const now = new Date().toISOString();

	const result = await env.DB.prepare(
		`UPDATE comments SET category = ?, pin_color = ?, body = ?, updated_by_id = ?, updated_by_name = ?, updated_at = ?
		 WHERE comment_id = ?`,
	)
		.bind(validated.category, validated.pinColor, text, user.user_id, user.name, now, id)
		.run();

	if (result.meta.changes === 0) {
		return Response.json({ error: '指定されたコメントが見つかりません' }, { status: 404 });
	}

	const row = await env.DB.prepare('SELECT * FROM comments WHERE comment_id = ?').bind(id).first<CommentRow>();
	return Response.json(toPublicComment(row!));
}

export async function deleteComment(env: CommentsEnv, commentId: string): Promise<Response> {
	const id = Number(commentId);
	if (!Number.isInteger(id)) {
		return Response.json({ error: 'comment_id が不正です' }, { status: 400 });
	}
	const row = await env.DB.prepare('SELECT image_key FROM comments WHERE comment_id = ?')
		.bind(id)
		.first<{ image_key: string | null }>();
	if (!row) {
		return Response.json({ error: '指定されたコメントが見つかりません' }, { status: 404 });
	}
	if (row.image_key) {
		await env.COMMENT_IMAGES.delete(row.image_key);
	}
	await env.DB.prepare('DELETE FROM comments WHERE comment_id = ?').bind(id).run();
	return Response.json({ ok: true });
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export async function uploadCommentImage(request: Request, env: CommentsEnv, user: SessionUser, commentId: string): Promise<Response> {
	const id = Number(commentId);
	if (!Number.isInteger(id)) {
		return Response.json({ error: 'comment_id が不正です' }, { status: 400 });
	}
	const existing = await env.DB.prepare('SELECT image_key FROM comments WHERE comment_id = ?')
		.bind(id)
		.first<{ image_key: string | null }>();
	if (!existing) {
		return Response.json({ error: '指定されたコメントが見つかりません' }, { status: 404 });
	}

	const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
		return Response.json({ error: '画像形式が不正です（jpeg/png/webp/heicのいずれか）' }, { status: 400 });
	}
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength === 0) {
		return Response.json({ error: '画像データが空です' }, { status: 400 });
	}
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		return Response.json({ error: '画像サイズが大きすぎます（8MBまで）' }, { status: 400 });
	}

	const key = `comments/${id}/${crypto.randomUUID()}`;
	if (existing.image_key) {
		await env.COMMENT_IMAGES.delete(existing.image_key);
	}
	await env.COMMENT_IMAGES.put(key, bytes, { httpMetadata: { contentType } });

	const now = new Date().toISOString();
	await env.DB.prepare(
		'UPDATE comments SET image_key = ?, image_content_type = ?, updated_by_id = ?, updated_by_name = ?, updated_at = ? WHERE comment_id = ?',
	)
		.bind(key, contentType, user.user_id, user.name, now, id)
		.run();

	const row = await env.DB.prepare('SELECT * FROM comments WHERE comment_id = ?').bind(id).first<CommentRow>();
	return Response.json(toPublicComment(row!));
}

export async function deleteCommentImage(env: CommentsEnv, user: SessionUser, commentId: string): Promise<Response> {
	const id = Number(commentId);
	if (!Number.isInteger(id)) {
		return Response.json({ error: 'comment_id が不正です' }, { status: 400 });
	}
	const existing = await env.DB.prepare('SELECT image_key FROM comments WHERE comment_id = ?')
		.bind(id)
		.first<{ image_key: string | null }>();
	if (!existing) {
		return Response.json({ error: '指定されたコメントが見つかりません' }, { status: 404 });
	}
	if (existing.image_key) {
		await env.COMMENT_IMAGES.delete(existing.image_key);
	}
	const now = new Date().toISOString();
	await env.DB.prepare(
		'UPDATE comments SET image_key = NULL, image_content_type = NULL, updated_by_id = ?, updated_by_name = ?, updated_at = ? WHERE comment_id = ?',
	)
		.bind(user.user_id, user.name, now, id)
		.run();

	const row = await env.DB.prepare('SELECT * FROM comments WHERE comment_id = ?').bind(id).first<CommentRow>();
	return Response.json(toPublicComment(row!));
}

export async function getCommentImage(env: CommentsEnv, commentId: string): Promise<Response> {
	const id = Number(commentId);
	if (!Number.isInteger(id)) {
		return new Response('Not Found', { status: 404 });
	}
	const row = await env.DB.prepare('SELECT image_key, image_content_type FROM comments WHERE comment_id = ?')
		.bind(id)
		.first<{ image_key: string | null; image_content_type: string | null }>();
	if (!row || !row.image_key) {
		return new Response('Not Found', { status: 404 });
	}
	const object = await env.COMMENT_IMAGES.get(row.image_key);
	if (!object) {
		return new Response('Not Found', { status: 404 });
	}
	return new Response(object.body, {
		headers: {
			'content-type': row.image_content_type ?? 'application/octet-stream',
			'cache-control': 'private, max-age=86400',
		},
	});
}
