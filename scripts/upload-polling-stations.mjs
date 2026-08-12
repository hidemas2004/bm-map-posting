#!/usr/bin/env node
/**
 * 既存地域への投票所マスタCSV再投入スクリプト。
 *   node scripts/upload-polling-stations.mjs <region-id> [CSVパス（省略時 regions/<region-id>/polling_stations.csv）]
 *
 * Cloudflare Workers Freeプランのsubrequest数上限（1 invocationあたり外部fetch 50件）により、
 * CSVの行数が多いと `worker/polling_stations.ts` の importPollingStations 内でジオコーディング
 * が完走できない（GSI地名検索APIへの fetch() が1件ずつ積み上がるため。bm-map-poster issue#3と
 * 同根）。そのため測地系チェック・ジオコーディングは `scripts/lib/polling-stations-correction.mjs`
 * （サブリクエスト上限のないローカルNode実行）で行い、判定済み・補正済みのCSVを
 * `scripts/new-region.mjs` と同じ「ログイン→Bearerトークン→POST /api/polling-stations/import」
 * パターンでアップロードする。
 *
 * Web画面から直接CSVをアップロードする経路（/polling-stations.html）は測地系チェックを一切行わず
 * 入力データをそのまま採用するので、投票所マスタの新規投入・座標更新は必ずこのスクリプト経由で
 * 行うこと。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorrectedPollingStationsCsv } from './lib/polling-stations-correction.mjs';
import { ask, closePrompt } from './lib/prompt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

async function main() {
	const regionId = process.argv[2];
	if (!regionId) {
		console.error('使い方: node scripts/upload-polling-stations.mjs <region-id> [CSVパス]');
		process.exit(1);
	}
	const csvPath = process.argv[3] ?? path.join(regionDir(regionId), 'polling_stations.csv');
	if (!existsSync(csvPath)) {
		console.error(`CSVファイルが見つかりません: ${csvPath}`);
		process.exit(1);
	}

	const metaPath = path.join(regionDir(regionId), 'meta.json');
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

	console.log(`\n=== ${meta.displayName ?? regionId}: 投票所マスタ測地系チェック ===`);
	const { csvText: uploadCsv, summary } = await buildCorrectedPollingStationsCsv(readFileSync(csvPath, 'utf8'));
	for (const line of summary) console.log(line);

	console.log('\n--- アップロード先の指定 ---');
	const deployedUrl = (await ask('デプロイ先URL（例: https://bm-map-posting-xxxx.xxxx.workers.dev）')).replace(/\/+$/, '');
	const adminUserId = await ask('管理者ユーザーID', { defaultValue: meta.adminUserId });
	const adminPassphrase = await ask(`管理者「${adminUserId}」の合言葉`);

	const loginRes = await fetch(`${deployedUrl}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ user_id: adminUserId, passphrase: adminPassphrase }),
	});
	if (!loginRes.ok) {
		console.error(`\n管理者ログインに失敗しました（${loginRes.status}）。`);
		closePrompt();
		process.exit(1);
	}
	const { token } = await loginRes.json();

	const importRes = await fetch(`${deployedUrl}/api/polling-stations/import`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
		body: uploadCsv,
	});
	if (!importRes.ok) {
		console.error(`\n投票所マスタの投入に失敗しました（${importRes.status}）: ${await importRes.text()}`);
		closePrompt();
		process.exit(1);
	}
	const result = await importRes.json();
	console.log(`\n${result.imported}件の投票所を反映しました。`);

	closePrompt();
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	closePrompt();
	process.exit(1);
});
