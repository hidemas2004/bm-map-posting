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
 *
 * アップロード先URLは region-id から regions/<id>/meta.json の deployedUrl を自動的に使う
 * （手入力を求めない）。これは、CSVパスとデプロイ先を両方手入力させると「region-idはA地域だが
 * URLはB地域」のような取り違えが起きうるため（実際に発生した事故を踏まえた対策）。
 * meta.jsonにdeployedUrlが無い場合のみ入力を求め、次回のために保存する。
 * また、送信は全件洗い替え（DELETE→INSERT）で取り消せないため、実行直前に地域名・CSVパス・
 * 行数・送信先URLを表示して最終確認を挟む。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorrectedPollingStationsCsv } from './lib/polling-stations-correction.mjs';
import { ask, confirm, closePrompt } from './lib/prompt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

function countCsvRows(csvText) {
	return csvText.trim().split(/\r\n|\n/).length - 1; // ヘッダ行を除く
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

	console.log(`\n=== ${meta.displayName ?? regionId}（${regionId}）: 投票所マスタ測地系チェック ===`);
	const { csvText: uploadCsv, summary } = await buildCorrectedPollingStationsCsv(readFileSync(csvPath, 'utf8'));
	for (const line of summary) console.log(line);

	let deployedUrl = meta.deployedUrl;
	if (deployedUrl) {
		console.log(`\nアップロード先: ${deployedUrl}（regions/${regionId}/meta.jsonから自動決定）`);
	} else {
		console.log('\n--- アップロード先の指定 ---');
		console.log(`regions/${regionId}/meta.json に deployedUrl が無いため、手入力してください。`);
		deployedUrl = (await ask('デプロイ先URL（例: https://bm-map-posting-xxxx.xxxx.workers.dev）')).replace(/\/+$/, '');
		meta.deployedUrl = deployedUrl;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		console.log(`（次回のために regions/${regionId}/meta.json へ保存しました）`);
	}

	console.log('\n--- 最終確認 ---');
	console.log(`  地域:         ${meta.displayName ?? regionId}（${regionId}）`);
	console.log(`  CSVファイル:  ${csvPath}`);
	console.log(`  件数:         ${countCsvRows(uploadCsv)}件`);
	console.log(`  送信先:       ${deployedUrl}`);
	console.log('  ※ 投票所マスタは全件洗い替え（DELETE→INSERT）です。取り消しはできません。');
	const proceed = await confirm('この内容でアップロードしてよいですか？', { defaultValue: false });
	if (!proceed) {
		console.log('\n中断しました。');
		closePrompt();
		return;
	}

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
