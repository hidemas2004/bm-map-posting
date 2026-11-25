/**
 * Workerで捕捉されなかった例外（主にD1のエラー）を、画面に表示できるJSONのエラー応答に変換する。
 * 例外がそのまま投げられるとCloudflareがHTML/テキストの500応答を返し、画面側がJSONとして読めずに
 * 何も表示されない（ユーザーからは「操作しても何も起きない」ように見える）ため、index.ts の
 * fetch ハンドラ全体をこれで包む。
 */
export function errorResponse(e: unknown): Response {
	const message = e instanceof Error ? e.message : String(e);
	console.error('unhandled error:', message);
	return Response.json({ error: friendlyErrorMessage(message) }, { status: errorStatus(message) });
}

function isDailyLimit(message: string): boolean {
	return /exceeded D1's free tier daily row (write|read) limit/i.test(message);
}

function errorStatus(message: string): number {
	return isDailyLimit(message) ? 503 : 500;
}

export function friendlyErrorMessage(message: string): string {
	if (/daily row write limit/i.test(message)) {
		return (
			'本日のデータベースの書き込み上限（Cloudflare D1 無料プラン）に達したため、保存できませんでした。' +
			'日本時間の午前9時（UTC 0時）に上限がリセットされます。それ以降にもう一度お試しください。'
		);
	}
	if (/daily row read limit/i.test(message)) {
		return (
			'本日のデータベースの読み取り上限（Cloudflare D1 無料プラン）に達したため、処理できませんでした。' +
			'日本時間の午前9時（UTC 0時）に上限がリセットされます。それ以降にもう一度お試しください。'
		);
	}
	return `サーバーでエラーが発生したため、処理できませんでした（${message}）`;
}
