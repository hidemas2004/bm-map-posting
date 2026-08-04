#!/usr/bin/env node
/**
 * 新しい市区町村を並行稼働で追加するための対話スクリプト。
 *   npm run new-region
 *
 * wrangler.jsonc のトップレベル（既存の大和市本番設定）は一切変更しない。新しい市は
 * env.<region-id> の名前付き環境として追加し、独立したWorker・D1データベースでデプロイする。
 *
 * 前提: `npx wrangler login` 済みであること（D1作成・デプロイでCloudflare認証が必要）。
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask, confirm, closePrompt } from './lib/prompt.mjs';
import { appendEnvBlock, envExists } from './lib/wrangler-jsonc.mjs';
import { fetchCityBoundary } from './lib/estat-boundary.mjs';
import { buildConfigJs, computeCenterFromGeoJson } from './lib/config-template.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

/** silent: stdout/stderrを表示せず戻り値として返す。input: 子プロセスの標準入力に書き込む文字列
 *  （wrangler secret put のような対話入力を非対話で通すため。stdin.10を明示的にpipeにする）。 */
function run(cmd, args, options = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	const stdio = options.input ? ['pipe', options.silent ? 'pipe' : 'inherit', 'inherit'] : options.silent ? 'pipe' : 'inherit';
	return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...options, stdio });
}

function extractDatabaseId(wranglerOutput) {
	const jsonMatch = wranglerOutput.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i);
	if (jsonMatch) return jsonMatch[1];
	const genericMatch = wranglerOutput.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
	if (genericMatch) return genericMatch[0];
	return null;
}

async function main() {
	console.log('=== bm-map-posting: 新規地域の並行ローンチ ===\n');

	let regionId = await ask('地域ID（例: 202704-hiratsuka。英数字とハイフンのみ）');
	regionId = regionId.trim().toLowerCase();
	if (!/^[a-z0-9-]+$/.test(regionId)) {
		console.error('エラー: 地域IDは英小文字・数字・ハイフンのみ使用できます。');
		process.exit(1);
	}

	const dir = regionDir(regionId);
	const resuming = existsSync(dir);
	if (resuming) {
		console.log(`\n(regions/${regionId}/ は既に存在します。用意済みのファイルは再利用し、続きから進めます)`);
	}
	mkdirSync(dir, { recursive: true });

	const metaPath = path.join(dir, 'meta.json');
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

	meta.displayName = meta.displayName ?? (await ask('表示名（例: 平塚市）'));
	meta.cityName =
		meta.cityName ?? (await ask('e-StatのCITY_NAME（通常は表示名と同じ。政令指定都市の区は「横浜市鶴見区」のように）', { defaultValue: meta.displayName }));
	meta.cityCode = meta.cityCode ?? (await ask('市区町村コード（総務省「全国地方公共団体コード」の5桁。政令指定都市の区は区ごとに別コード）'));
	writeFileSync(metaPath, JSON.stringify(meta, null, 2));

	// --- 境界データ・地域マスタの収集 ---
	const areasSqlPath = path.join(dir, 'areas.sql');
	const boundaryPath = path.join(dir, 'boundary.geojson');
	let warnings = [];

	if (existsSync(areasSqlPath) && existsSync(boundaryPath)) {
		console.log(`\n(regions/${regionId}/areas.sql, boundary.geojson は既に用意されています。このまま使用します)`);
	} else {
		console.log('\n--- 境界データ・地域マスタの収集 ---');
		const autoFetch = await confirm('e-Statから自動取得しますか？（ネットワーク到達性が必要）', { defaultValue: true });
		if (autoFetch) {
			try {
				const result = fetchCityBoundary({ cityCode: meta.cityCode, cityName: meta.cityName, outDir: dir });
				warnings = result.warnings;
				console.log(`\n${result.areas.length}件の地域を取得しました。`);
			} catch (err) {
				console.error(`\n自動取得に失敗しました: ${err.message}`);
				console.log(
					'README.md の「行政区域データの追加・基本単位区単位への格上げ手順」を参照し、手動で\n' +
						`  regions/${regionId}/areas.sql\n  regions/${regionId}/boundary.geojson\n` +
						'を用意してください（大和市と同じ手順。到達可能な環境で実行するか、ccに依頼できます）。',
				);
			}
		} else {
			console.log(
				`README.md の「行政区域データの追加・基本単位区単位への格上げ手順」を参照し、\n` +
					`  regions/${regionId}/areas.sql\n  regions/${regionId}/boundary.geojson\n` +
					'を手動で用意してください。',
			);
		}

		while (!existsSync(areasSqlPath) || !existsSync(boundaryPath)) {
			await ask(`準備ができたらEnterを押してください（regions/${regionId}/ に areas.sql と boundary.geojson が必要です）`, {
				defaultValue: ' ',
			});
		}
	}

	// --- 地図初期表示設定 ---
	const boundaryGeoJson = JSON.parse(readFileSync(boundaryPath, 'utf8'));
	const suggestedCenter = computeCenterFromGeoJson(boundaryGeoJson);
	if (!meta.mapCenter) {
		console.log(`\n境界データのbbox中心から地図初期座標を算出しました: [${suggestedCenter.join(', ')}]`);
		const useDefault = await confirm('この座標を使用しますか？', { defaultValue: true });
		if (useDefault) {
			meta.mapCenter = suggestedCenter;
		} else {
			const lat = Number(await ask('緯度'));
			const lng = Number(await ask('経度'));
			meta.mapCenter = [lat, lng];
		}
	}
	meta.mapZoom = meta.mapZoom ?? Number(await ask('地図初期ズームレベル', { defaultValue: '13' }));
	writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	writeFileSync(
		path.join(dir, 'config.js'),
		buildConfigJs({ displayName: meta.displayName, center: meta.mapCenter, zoom: meta.mapZoom }),
	);

	// --- 初期管理者ユーザー ---
	// 合言葉は平文の秘密情報なので meta.json（gitで追跡される）には一切書き込まない。
	// DB投入が完了するまでの間だけメモリ上に保持する。
	let adminPassphrase;
	if (!meta.dbSeeded) {
		console.log('\n--- 初期管理者ユーザーの登録 ---');
		console.log('（担当者の追加はデプロイ後に /users.html のCSVインポートで行えます。ここでは管理者1名のみ）');
		meta.adminUserId = meta.adminUserId ?? (await ask('管理者のユーザーID（例: admin）', { defaultValue: 'admin' }));
		meta.adminName = meta.adminName ?? (await ask('管理者の表示名（例: 管理者）', { defaultValue: '管理者' }));
		adminPassphrase = await ask('管理者の初期合言葉（後で /users.html から変更可能）');
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	const workerName = `bm-map-posting-${regionId}`;
	const d1DatabaseName = `bm-posting-db-${regionId}`;

	// --- D1データベース作成 ---
	let databaseId = meta.databaseId;
	if (!databaseId) {
		console.log('\n--- D1データベース作成 ---');
		const proceed = await confirm(`本番Cloudflare上に新しいD1データベース「${d1DatabaseName}」を作成します。よろしいですか？`, {
			defaultValue: true,
		});
		if (!proceed) {
			console.log('中断しました。');
			closePrompt();
			return;
		}
		const output = run('npx', ['wrangler', 'd1', 'create', d1DatabaseName], { silent: true });
		console.log(output);
		databaseId = extractDatabaseId(output);
		if (!databaseId) {
			databaseId = await ask('database_id を自動抽出できませんでした。上記の出力から database_id を貼り付けてください');
		}
		meta.databaseId = databaseId;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	// --- wrangler.jsonc へのenv追記 ---
	if (!envExists(regionId)) {
		appendEnvBlock(regionId, { workerName, d1DatabaseName, databaseId });
		console.log(`\nwrangler.jsonc に env.${regionId} を追記しました。`);
	}

	// --- マイグレーション・地域マスタ・初期管理者の投入 ---
	if (!meta.dbSeeded) {
		console.log('\n--- D1へのマイグレーション・データ投入 ---');
		run('npx', ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--file=migrations/0001_init.sql']);
		run('npx', ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--file=migrations/0002_areas_block_level.sql']);
		run('npx', ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', `--file=${path.relative(REPO_ROOT, areasSqlPath)}`]);

		// 合言葉が平文で入るSQLはリポジトリ外（OS一時ディレクトリ）に書き、投入後に必ず削除する。
		const esc = (s) => s.replace(/'/g, "''");
		const adminSql = `INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('${esc(meta.adminUserId)}', '${esc(meta.adminName)}', '${esc(adminPassphrase)}', '管理者', 1);\n`;
		const adminSqlPath = path.join(os.tmpdir(), `bm-map-posting-admin-${regionId}-${crypto.randomUUID()}.sql`);
		writeFileSync(adminSqlPath, adminSql);
		try {
			run('npx', ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', `--file=${adminSqlPath}`]);
		} finally {
			rmSync(adminSqlPath, { force: true });
		}

		meta.dbSeeded = true;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	// --- Secrets自動生成・設定 ---
	if (!meta.secretsSet) {
		console.log('\n--- Secretsの自動生成・設定 ---');
		const sessionSecret = crypto.randomBytes(32).toString('hex');
		const areasImportToken = crypto.randomBytes(32).toString('hex');
		run('npx', ['wrangler', 'secret', 'put', 'SESSION_SECRET', '--env', regionId], { input: sessionSecret + '\n' });
		run('npx', ['wrangler', 'secret', 'put', 'AREAS_IMPORT_TOKEN', '--env', regionId], { input: areasImportToken + '\n' });
		meta.secretsSet = true;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		console.log('(値はCloudflare側にのみ保存され、このスクリプトの出力には表示されません)');
	}

	// --- デプロイ前の最終確認 ---
	console.log('\n=== デプロイ内容の確認 ===');
	console.log(`  地域ID:          ${regionId}`);
	console.log(`  表示名:           ${meta.displayName}`);
	console.log(`  Worker名:         ${workerName}`);
	console.log(`  D1データベース:   ${d1DatabaseName} (${databaseId})`);
	console.log(`  地図初期座標:     [${meta.mapCenter.join(', ')}]  ズーム: ${meta.mapZoom}`);
	console.log(`  管理者ユーザーID: ${meta.adminUserId}`);
	if (warnings.length > 0) {
		console.log(`  要確認事項:       ${warnings.length}件（regions/${regionId}/areas.sql 内のコメント参照）`);
	}
	console.log('');

	const okToDeploy = await confirm('この内容で本番デプロイ（wrangler deploy）してよいですか？', { defaultValue: false });
	if (!okToDeploy) {
		console.log('\nデプロイを見送りました。再度 `npm run new-region` を実行すれば、この続きから再開できます。');
		closePrompt();
		return;
	}

	copyFileSync(path.join(dir, 'config.js'), path.join(PUBLIC_DIR, 'config.js'));
	copyFileSync(boundaryPath, path.join(PUBLIC_DIR, 'data', 'boundary.geojson'));
	console.log(`\n(public/config.js, public/data/boundary.geojson を ${regionId} の内容に切り替えました)`);

	run('npx', ['wrangler', 'deploy', '--env', regionId]);

	console.log('\n=== 完了 ===');
	console.log(`Worker「${workerName}」をデプロイしました（URLはデプロイログを参照）。`);
	console.log(`ログイン: ユーザーID「${meta.adminUserId}」・上で入力した合言葉。`);
	console.log('担当者の追加は /users.html のCSVインポート機能から行ってください。');
	console.log(`現在 public/ は「${regionId}」の内容です。別地域を扱う場合は改めてこのスクリプトを実行してください。`);

	closePrompt();
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	closePrompt();
	process.exit(1);
});
