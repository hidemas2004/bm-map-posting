#!/usr/bin/env node
/**
 * 本番D1から投票所マスタを読み出し、CSV（name,address,lat,lng）として書き出す。
 *   node scripts/export-polling-stations.mjs <region-id> [出力パス（省略時 regions/<region-id>/polling_stations.csv）]
 *
 * regions/<id>/polling_stations.csv がローカルに無い地域（例: 新規地域立ち上げ時にCSVを渡した
 * だけで恒久保存していなかった場合）で、既存データを元に scripts/upload-polling-stations.mjs
 * （測地系チェック・location_uncertain付与）を再実行したいときに使う。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toCsv } from '../worker/csv.ts';
import { readWranglerConfig } from './lib/wrangler-jsonc.mjs';
import { execCommand } from './lib/win-exec.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPX = 'npx';

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

async function main() {
	const regionId = process.argv[2];
	if (!regionId) {
		console.error('使い方: node scripts/export-polling-stations.mjs <region-id> [出力パス]');
		process.exit(1);
	}

	const config = readWranglerConfig();
	const envConfig = config.env?.[regionId];
	if (!envConfig) {
		console.error(`wrangler.jsonc に env.${regionId} が見つかりません。`);
		process.exit(1);
	}
	const dbName = envConfig.d1_databases?.[0]?.database_name;
	if (!dbName) {
		console.error(`env.${regionId} にd1_databasesの設定が見つかりません。`);
		process.exit(1);
	}

	const outPath = process.argv[3] ?? path.join(regionDir(regionId), 'polling_stations.csv');

	console.log(`D1(${dbName})から投票所データを取得しています...`);
	const output = execCommand(
		NPX,
		[
			'wrangler',
			'd1',
			'execute',
			dbName,
			'--env',
			regionId,
			'--remote',
			'--command',
			'SELECT name, address, lat, lng FROM polling_stations ORDER BY station_id',
			'--json',
		],
		{ encoding: 'utf8', cwd: REPO_ROOT },
	);
	const [{ results }] = JSON.parse(output);

	const csv = toCsv(
		['name', 'address', 'lat', 'lng'],
		results.map((r) => [r.name, r.address, r.lat, r.lng]),
	);
	mkdirSync(path.dirname(outPath), { recursive: true });
	writeFileSync(outPath, csv);
	console.log(`${results.length}件を書き出しました: ${outPath}`);
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	process.exit(1);
});
