import { handleLogin, requireAuth, type AuthEnv } from './auth';
import { listActiveUsers, type UsersEnv } from './users';

export interface Env extends AuthEnv, UsersEnv {
	ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/api/login' && request.method === 'POST') {
			return handleLogin(request, env);
		}
		if (url.pathname === '/api/users/active' && request.method === 'GET') {
			return listActiveUsers(env);
		}

		// /api/ 配下はここから下すべて認証必須（後続フェーズで追加するエンドポイント用）
		if (url.pathname.startsWith('/api/')) {
			const user = await requireAuth(request, env);
			if (!user) {
				return Response.json({ error: '認証が必要です' }, { status: 401 });
			}
			return Response.json({ error: 'Not Found' }, { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},
};
