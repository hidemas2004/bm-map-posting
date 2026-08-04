export interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/api/hello') {
			return new Response('Hello, bm-map-posting!');
		}

		return env.ASSETS.fetch(request);
	},
};
