export interface AreasEnv {
	DB: D1Database;
}

export async function listAreas(env: AreasEnv): Promise<Response> {
	const { results } = await env.DB.prepare('SELECT * FROM areas ORDER BY area_id').all();
	return Response.json(results);
}
