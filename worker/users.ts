/**
 * ログイン画面のユーザーIDプルダウン用。合言葉等の機微情報は含めない。
 */

export interface UsersEnv {
	DB: D1Database;
}

export async function listActiveUsers(env: UsersEnv): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT user_id, name FROM users WHERE active = 1 ORDER BY user_id',
	).all<{ user_id: string; name: string }>();
	return Response.json(results);
}
