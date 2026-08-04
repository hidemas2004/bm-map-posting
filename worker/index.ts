import { handleLogin, requireAdmin, requireAuth, type AuthEnv } from './auth';
import { exportUsersCsv, importUsers, listActiveUsers, listUsers, type UsersEnv } from './users';
import { exportAreasCsv, importAreas, listAreas, listAreasWithRecentTerms, type AreasEnv } from './areas';
import { createNewTerm, getTermData, listTerms, type TermsEnv } from './terms';
import { recordDistribution, setAssignee, type RecordsEnv } from './records';
import { exportActivityLogCsv, listActivityLog, type ActivityLogEnv } from './activity_log';

export interface Env extends AuthEnv, UsersEnv, AreasEnv, TermsEnv, RecordsEnv, ActivityLogEnv {
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
		if (url.pathname === '/api/areas/import' && request.method === 'POST') {
			// セッション認証ではなく AREAS_IMPORT_TOKEN による専用トークン認証（importAreas内で検証）
			return importAreas(request, env);
		}

		// /api/ 配下はここから下すべて認証必須
		if (url.pathname.startsWith('/api/')) {
			const user = await requireAuth(request, env);
			if (!user) {
				return Response.json({ error: '認証が必要です' }, { status: 401 });
			}

			if (url.pathname === '/api/areas' && request.method === 'GET') {
				return listAreas(env);
			}
			if (url.pathname === '/api/areas/with-terms' && request.method === 'GET') {
				return listAreasWithRecentTerms(env);
			}
			if (url.pathname === '/api/areas/export' && request.method === 'GET') {
				return exportAreasCsv(env);
			}
			if (url.pathname === '/api/activity-log' && request.method === 'GET') {
				return listActivityLog(env, url.searchParams.get('term_id'));
			}
			if (url.pathname === '/api/activity-log/export' && request.method === 'GET') {
				return exportActivityLogCsv(env, url.searchParams.get('term_id'));
			}
			if (url.pathname === '/api/terms' && request.method === 'GET') {
				return listTerms(env);
			}
			if (url.pathname === '/api/term-data' && request.method === 'GET') {
				const termId = url.searchParams.get('term_id');
				if (!termId) {
					return Response.json({ error: 'term_id を指定してください' }, { status: 400 });
				}
				return getTermData(env, termId);
			}
			if (url.pathname === '/api/term/new' && request.method === 'POST') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				const body = await request.json<{ term_name?: string }>().catch(() => ({}) as { term_name?: string });
				return createNewTerm(env, String(body.term_name ?? ''));
			}
			if (url.pathname === '/api/users' && request.method === 'GET') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return listUsers(env);
			}
			if (url.pathname === '/api/users/export' && request.method === 'GET') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return exportUsersCsv(env);
			}
			if (url.pathname === '/api/users/import' && request.method === 'POST') {
				const admin = await requireAdmin(request, env);
				if (!admin) {
					return Response.json({ error: '管理者権限が必要です' }, { status: 403 });
				}
				return importUsers(request, env);
			}
			if (url.pathname === '/api/record' && request.method === 'POST') {
				return recordDistribution(request, env, user);
			}
			if (url.pathname === '/api/assignee' && request.method === 'POST') {
				return setAssignee(request, env);
			}

			return Response.json({ error: 'Not Found' }, { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},
};
