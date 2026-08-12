#!/usr/bin/env node
/**
 * 新しい市区町村を並行稼働で追加するための対話スクリプト。
 *   npm run new-region
 *
 * 全ての地域（大和市を含む）は env.<region-id> の名前付き環境として追加し、独立した
 * Worker・D1データベースでデプロイする。「無名のデフォルト環境」は存在しない設計
 * （詳細はREADME「複数地域の並行運用」）。
 *
 * 前提: `npx wrangler login` 済みであること（D1作成・デプロイでCloudflare認証が必要）。
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask, confirm, closePrompt } from './lib/prompt.mjs';
import { buildCorrectedPollingStationsCsv } from './lib/polling-stations-correction.mjs';
import { appendEnvBlock, envExists } from './lib/wrangler-jsonc.mjs';
import { fetchCityBoundary, fetchChomeBoundary, buildChomeAreaIdUpdateSql } from './lib/estat-boundary.mjs';
import { assignChomeAreaIds } from './lib/geo.mjs';
import { computeCenterFromGeoJson } from './lib/geojson-bbox.mjs';
import { execCommand } from './lib/win-exec.mjs';
import { ensureWranglerAuth } from './lib/wrangler-auth.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const NPX = 'npx';

function regionDir(id) {
	return path.join(REPO_ROOT, 'regions', id);
}

function publicRegionDataDir(id) {
	return path.join(PUBLIC_DIR, 'data', 'regions', id);
}

/** silent: stdout/stderrを表示せず戻り値として返す。input: 子プロセスの標準入力に書き込む文字列
 *  （wrangler secret put のような対話入力を非対話で通すため。stdin.10を明示的にpipeにする）。 */
function run(cmd, args, options = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	const stdio = options.input ? ['pipe', options.silent ? 'pipe' : 'inherit', 'inherit'] : options.silent ? 'pipe' : 'inherit';
	return execCommand(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...options, stdio });
}

function extractDatabaseId(wranglerOutput) {
	const jsonMatch = wranglerOutput.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i);
	if (jsonMatch) return jsonMatch[1];
	const genericMatch = wranglerOutput.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
	if (genericMatch) return genericMatch[0];
	return null;
}

function extractDeployedUrl(wranglerOutput) {
	const match = wranglerOutput.match(/https:\/\/\S+\.workers\.dev\S*/);
	return match ? match[0].replace(/\/+$/, '') : null;
}

async function main() {
	console.log('=== bm-map-posting: 新規地域の並行ローンチ ===\n');

	// D1作成・デプロイ等の前に認証状態を確認・リフレッシュしておく（未認証やアクセストークン
	// 期限切れのまま境界データ収集等の対話を終えた後にwrangler呼び出しで落ちるのを防ぐ）。
	await ensureWranglerAuth();

	let regionId = await ask('地域ID（例: 14213-yamato。市区町村コード5桁+ローマ字市名を推奨。英数字とハイフンのみ）');
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

	// --- 恒久的な配信パスへのコピー ---
	// public/data/regions/<id>/ は地域ごとに固有のパスなので、以後「切り替え」は発生しない
	// （旧方式は public/config.js・public/data/boundary.geojson をデプロイ直前に上書きしていたため、
	// 誤ってコミットすると別地域の内容が本番設定として混入するリスクがあった）。
	const publicDataDir = publicRegionDataDir(regionId);
	mkdirSync(publicDataDir, { recursive: true });
	writeFileSync(path.join(publicDataDir, 'boundary.geojson'), readFileSync(boundaryPath));

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

	// --- エリア境界（チョーム境界）レイヤーの有無 ---
	// 「エリア」（area_manager機能・chome_area_idの単位）の境界データ。e-Statの町丁・字等境界データ
	// から自動取得できる（fetchChomeBoundary）。取得できない場合は手動配置にフォールバックする。
	if (meta.hasChomeBoundary === undefined) {
		meta.hasChomeBoundary = await confirm(
			'エリア境界（丁目単位の境界線）レイヤーをこの地域で有効にしますか？（area_manager機能の単位。e-Statから自動取得可能）',
			{ defaultValue: true },
		);
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	}

	let chomeWarnings = [];
	if (meta.hasChomeBoundary) {
		const chomeBoundarySourcePath = path.join(dir, 'boundary_chome.geojson');
		const chomeBoundaryDestPath = path.join(publicDataDir, 'boundary_chome.geojson');
		const chomeAreaIdSqlPath = path.join(dir, 'chome_area_id.sql');

		if (!existsSync(chomeBoundarySourcePath)) {
			console.log('\n--- エリア境界（チョーム境界）データの収集 ---');
			const autoFetchChome = await confirm('e-Statから自動取得しますか？（ネットワーク到達性が必要）', { defaultValue: true });
			if (autoFetchChome) {
				try {
					const result = fetchChomeBoundary({ cityCode: meta.cityCode, cityName: meta.cityName, outDir: dir });
					chomeWarnings = result.warnings;
					console.log(`\n${result.geojson.features.length}件のエリアを取得しました。`);
				} catch (err) {
					console.error(`\n自動取得に失敗しました: ${err.message}`);
					console.log(
						'README.md の「行政区域データの追加・基本単位区単位への格上げ手順」を参照し、手動で\n' +
							`  regions/${regionId}/boundary_chome.geojson\n` +
							'を用意してください。',
					);
				}
			} else {
				console.log(`README.md を参照し、regions/${regionId}/boundary_chome.geojson を手動で用意してください。`);
			}
			while (!existsSync(chomeBoundarySourcePath)) {
				await ask('準備ができたらEnterを押してください', { defaultValue: ' ' });
			}
		} else {
			console.log(`\n(regions/${regionId}/boundary_chome.geojson は既に用意されています。このまま使用します)`);
		}

		if (!existsSync(chomeBoundaryDestPath)) {
			writeFileSync(chomeBoundaryDestPath, readFileSync(chomeBoundarySourcePath));
		}

		// --- chome_area_id の空間結合（区画→エリア） ---
		if (!existsSync(chomeAreaIdSqlPath)) {
			console.log('\n--- chome_area_id（エリア）の空間結合 ---');
			const blockGeojson = JSON.parse(readFileSync(boundaryPath, 'utf8'));
			const chomeGeojson = JSON.parse(readFileSync(chomeBoundarySourcePath, 'utf8'));
			const { chomeAreaIdByAreaId, warnings: spatialWarnings } = assignChomeAreaIds(blockGeojson.features, chomeGeojson.features);

			if (spatialWarnings.length > 0) {
				console.warn(`空間結合の警告が${spatialWarnings.length}件あります:`);
				for (const w of spatialWarnings) console.warn(`  ${w}`);
				const fallbackRatio = spatialWarnings.length / blockGeojson.features.length;
				if (fallbackRatio > 0.5) {
					console.warn(
						`\n【要注意】区画の${Math.round(fallbackRatio * 100)}%が自分自身のarea_idにフォールバックしました。` +
							'boundary_chome.geojson側のCITY_NAME抽出がうまくいっていない可能性があります' +
							`（政令指定都市の区名表記揺れ等）。デプロイ前に regions/${regionId}/boundary_chome.geojson を確認してください。`,
					);
				}
			} else {
				console.log('空間結合の警告はありませんでした（全区画が1つのエリアに一致）。');
			}

			writeFileSync(chomeAreaIdSqlPath, buildChomeAreaIdUpdateSql(chomeAreaIdByAreaId, spatialWarnings));
			chomeWarnings = [...chomeWarnings, ...spatialWarnings];
		}
	}

	// --- 初期管理者ユーザー ---
	// 合言葉は平文の秘密情報なので meta.json（gitで追跡される）には一切書き込まない。
	// DB投入・ログイン確認が完了するまでの間だけメモリ上に保持する。
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
		const output = run(NPX, ['wrangler', 'd1', 'create', d1DatabaseName], { silent: true });
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
		appendEnvBlock(regionId, {
			workerName,
			d1DatabaseName,
			databaseId,
			vars: {
				REGION_ID: regionId,
				REGION_DISPLAY_NAME: meta.displayName,
				MAP_CENTER_LAT: meta.mapCenter[0],
				MAP_CENTER_LNG: meta.mapCenter[1],
				MAP_ZOOM: meta.mapZoom,
				HAS_CHOME_BOUNDARY: meta.hasChomeBoundary,
			},
		});
		console.log(`\nwrangler.jsonc に env.${regionId} を追記しました。`);
	}

	// --- マイグレーション・地域マスタ・初期管理者の投入 ---
	// wrangler d1 execute --remote は既定で1回ごとに「Ok to proceed?」の確認を挟むが、ここで実行する
	// のは直前に作成したばかりの空のD1データベースへの初回投入のみ（既存データを壊すリスクが無い）
	// なので --yes で省略する（README等に載せる、既存DBに対する手動コマンド例では付けない）。
	if (!meta.dbSeeded) {
		console.log('\n--- D1へのマイグレーション・データ投入 ---');
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', '--file=migrations/0001_init.sql']);
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', '--file=migrations/0002_areas_block_level.sql']);
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', '--file=migrations/0003_area_manager.sql']);
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', '--file=migrations/0004_chome_area_id.sql']);
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', '--file=migrations/0006_polling_stations.sql']);
		run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', `--file=${path.relative(REPO_ROOT, areasSqlPath)}`]);
		const chomeAreaIdSqlPath = path.join(dir, 'chome_area_id.sql');
		if (meta.hasChomeBoundary && existsSync(chomeAreaIdSqlPath)) {
			run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', `--file=${path.relative(REPO_ROOT, chomeAreaIdSqlPath)}`]);
		}

		// 合言葉が平文で入るSQLはリポジトリ外（OS一時ディレクトリ）に書き、投入後に必ず削除する。
		const esc = (s) => s.replace(/'/g, "''");
		const adminSql = `INSERT INTO users (user_id, name, passphrase, role, active) VALUES ('${esc(meta.adminUserId)}', '${esc(meta.adminName)}', '${esc(adminPassphrase)}', '管理者', 1);\n`;
		const adminSqlPath = path.join(os.tmpdir(), `bm-map-posting-admin-${regionId}-${crypto.randomUUID()}.sql`);
		writeFileSync(adminSqlPath, adminSql);
		try {
			run(NPX, ['wrangler', 'd1', 'execute', d1DatabaseName, '--env', regionId, '--remote', '--yes', `--file=${adminSqlPath}`]);
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
		run(NPX, ['wrangler', 'secret', 'put', 'SESSION_SECRET', '--env', regionId], { input: sessionSecret + '\n' });
		run(NPX, ['wrangler', 'secret', 'put', 'AREAS_IMPORT_TOKEN', '--env', regionId], { input: areasImportToken + '\n' });
		meta.secretsSet = true;
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		console.log('(値はCloudflare側にのみ保存され、このスクリプトの出力には表示されません)');
	}

	// --- デプロイ前の最終確認 ---
	console.log('\n=== デプロイ内容の確認 ===');
	console.log(`  地域ID:            ${regionId}`);
	console.log(`  表示名:             ${meta.displayName}`);
	console.log(`  Worker名:           ${workerName}`);
	console.log(`  D1データベース:     ${d1DatabaseName} (${databaseId})`);
	console.log(`  地図初期座標:       [${meta.mapCenter.join(', ')}]  ズーム: ${meta.mapZoom}`);
	console.log(`  エリア境界レイヤー: ${meta.hasChomeBoundary ? '有効' : '無効'}`);
	console.log(`  管理者ユーザーID:   ${meta.adminUserId}`);
	const totalWarnings = warnings.length + chomeWarnings.length;
	if (totalWarnings > 0) {
		console.log(
			`  要確認事項:         ${totalWarnings}件（regions/${regionId}/areas.sql` +
				`${chomeWarnings.length > 0 ? `, chome_area_id.sql` : ''} 内のコメント参照）`,
		);
	}
	console.log('');

	const okToDeploy = await confirm('この内容で本番デプロイ（wrangler deploy）してよいですか？', { defaultValue: false });
	if (!okToDeploy) {
		console.log('\nデプロイを見送りました。再度 `npm run new-region` を実行すれば、この続きから再開できます。');
		closePrompt();
		return;
	}

	console.log('\n--- デプロイ ---');
	const deployOutput = run(NPX, ['wrangler', 'deploy', '--env', regionId], { silent: true });
	console.log(deployOutput);
	let deployedUrl = extractDeployedUrl(deployOutput);

	// --- 投票所データの投入（任意。regions/<id>/polling_stations.csv がある場合のみ）---
	// 座標の測地系（日本測地系/世界測地系）自動検出・補正（issue#16対応）はCloudflare Workersの
	// subrequest数上限（1 invocationあたり外部fetch 50件）を避けるため、Node側
	// （scripts/lib/polling-stations-correction.mjs）で行ってから、補正済みCSVをWorkerのAPIへ
	// アップロードする（bm-map-poster issue#3と同根の対応）。
	const pollingCsvPath = path.join(dir, 'polling_stations.csv');
	if (existsSync(pollingCsvPath) && !meta.pollingStationsSeeded) {
		console.log('\n--- 投票所データの投入 ---');
		if (!deployedUrl) {
			deployedUrl = await ask('デプロイ先URLを自動抽出できませんでした。投票所データ投入のため、URLを貼り付けてください');
		}
		if (!adminPassphrase) {
			adminPassphrase = await ask(`管理者「${meta.adminUserId}」の合言葉を再入力してください（投票所データ投入のログインに使用）`);
		}
		try {
			const loginRes = await fetch(`${deployedUrl}/api/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ user_id: meta.adminUserId, passphrase: adminPassphrase }),
			});
			if (!loginRes.ok) {
				console.error(`\n管理者ログインに失敗しました（${loginRes.status}）。投票所データの投入をスキップします。後で /polling-stations.html から手動でアップロードしてください。`);
			} else {
				const { token } = await loginRes.json();
				const { csvText, summary } = await buildCorrectedPollingStationsCsv(readFileSync(pollingCsvPath, 'utf8'));
				for (const line of summary) console.log(line);
				const importRes = await fetch(`${deployedUrl}/api/polling-stations/import`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
					body: csvText,
				});
				if (!importRes.ok) {
					console.error(`\n投票所データの投入に失敗しました（${importRes.status}）: ${await importRes.text()}`);
					console.error('後で /polling-stations.html から手動でアップロードしてください。');
				} else {
					const result = await importRes.json();
					console.log(`\n投票所データを${result.imported}件投入しました。`);
					meta.pollingStationsSeeded = true;
					writeFileSync(metaPath, JSON.stringify(meta, null, 2));
				}
			}
		} catch (err) {
			console.error(`\n投票所データの投入中にエラーが発生しました: ${err.message}`);
			console.error('後で /polling-stations.html から手動でアップロードしてください。');
		}
	}

	console.log('\n=== 完了 ===');
	console.log(`Worker「${workerName}」をデプロイしました${deployedUrl ? `（${deployedUrl}）` : '（URLはデプロイログを参照）'}。`);
	console.log(`ログイン: ユーザーID「${meta.adminUserId}」・上で入力した合言葉。`);
	console.log('担当者の追加は /users.html のCSVインポート機能から行ってください。');

	closePrompt();
}

main().catch((err) => {
	console.error('\n予期しないエラーが発生しました:', err);
	closePrompt();
	process.exit(1);
});
