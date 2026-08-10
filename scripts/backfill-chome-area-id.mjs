#!/usr/bin/env node
/**
 * issue#12対応: 既にデプロイ済みの地域に、後から「エリア」機能（areas.chome_area_id、
 * boundary_chome.geojsonの境界ポリゴンとの空間結合で算出）を追加するための汎用CLI。
 * 新規地域の立上げ時は scripts/new-region.mjs が同等の処理を自動で行うため、このスクリプトは
 * 既にデプロイ済みの地域向け（大和市の chome_area_id もこのスクリプトの前身版で算出した）。
 *
 * 出力:
 *   1. migrations/backfill_chome_area_id_<region>.sql（既存DB向け・グループ化UPDATE文。
 *      出力後、migrations/ の連番規則に合わせて手動でリネームすること）
 *   2. regions/<region>/areas.sql（フレッシュDB向け・chome_area_id列を含む形に再生成）
 * あわせて、town+chome単位の旧グルーピングとchome_area_id単位の新グルーピングの
 * 差分をコンソールに要約表示する。
 *
 * 前提: ネットワーク到達性（www.e-stat.go.jp）。基本単位区データのキャッシュ
 * （.cache/estat-boundary/city<cityCode>.geojson）・エリア境界データ
 * （regions/<region>/boundary_chome.geojson）が無ければ自動取得する。
 *
 * 使い方:
 *   node scripts/backfill-chome-area-id.mjs --region 14213-yamato --city 大和市 --cityCode 14213
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMunicipality, buildAreasSql, fetchCityBoundary, fetchChomeBoundary, buildChomeAreaIdUpdateSql } from './lib/estat-boundary.mjs';
import { assignChomeAreaIds } from './lib/geo.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--region') args.region = argv[++i];
		else if (arg === '--city') args.city = argv[++i];
		else if (arg === '--cityCode') args.cityCode = argv[++i];
		else if (arg === '--help' || arg === '-h') args.help = true;
	}
	return args;
}

function printUsageAndExit(code) {
	console.log(
		[
			'使い方: node scripts/backfill-chome-area-id.mjs --region <地域ID> --city <e-StatのCITY_NAME> --cityCode <5桁市区町村コード>',
			'例:     node scripts/backfill-chome-area-id.mjs --region 14213-yamato --city 大和市 --cityCode 14213',
			'',
			'既にデプロイ済みの地域に、後から「エリア」機能（chome_area_id）を追加する。',
			'migrations/backfill_chome_area_id_<region>.sql は出力後、migrations/ の連番規則に',
			'合わせて手動でリネームすること。',
		].join('\n'),
	);
	process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.region || !args.city || !args.cityCode) printUsageAndExit(args.help ? 0 : 1);

const { region, city: CITY_NAME, cityCode: CITY_CODE } = args;
const REGION_DIR = path.join(REPO_ROOT, 'regions', region);
const CACHE_GEOJSON = path.join(REPO_ROOT, '.cache', 'estat-boundary', `city${CITY_CODE}.geojson`);
const REGION_CHOME_BOUNDARY_PATH = path.join(REGION_DIR, 'boundary_chome.geojson');
const PUBLIC_CHOME_BOUNDARY_PATH = path.join(REPO_ROOT, 'public', 'data', 'regions', region, 'boundary_chome.geojson');
const SEED_PATH = path.join(REGION_DIR, 'areas.sql');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', `backfill_chome_area_id_${region}.sql`);

function main() {
	if (!existsSync(CACHE_GEOJSON)) {
		console.log(`基本単位区の境界データが未取得のため、e-Statから取得します（${CITY_NAME}, ${CITY_CODE}）...`);
		fetchCityBoundary({ cityCode: CITY_CODE, cityName: CITY_NAME, outDir: REGION_DIR });
	}
	if (!existsSync(REGION_CHOME_BOUNDARY_PATH)) {
		console.log(`エリア境界データが未取得のため、e-Statから取得します（${CITY_NAME}, ${CITY_CODE}）...`);
		fetchChomeBoundary({ cityCode: CITY_CODE, cityName: CITY_NAME, outDir: REGION_DIR });
	}
	if (!existsSync(PUBLIC_CHOME_BOUNDARY_PATH)) {
		mkdirSync(path.dirname(PUBLIC_CHOME_BOUNDARY_PATH), { recursive: true });
		writeFileSync(PUBLIC_CHOME_BOUNDARY_PATH, readFileSync(REGION_CHOME_BOUNDARY_PATH));
	}

	const featureCollection = JSON.parse(readFileSync(CACHE_GEOJSON, 'utf8'));
	const { areas, geojson: blockGeojson, warnings: extractWarnings } = extractMunicipality(featureCollection, CITY_NAME);

	const chomeGeojson = JSON.parse(readFileSync(PUBLIC_CHOME_BOUNDARY_PATH, 'utf8'));

	const { chomeAreaIdByAreaId, warnings: spatialWarnings } = assignChomeAreaIds(blockGeojson.features, chomeGeojson.features);

	// --- 検証: chome_area_idごとの世帯数合計が boundary_chome.geojson 側の num_households と一致するか ---
	const householdsByAreaId = new Map(areas.map((a) => [a.area_id, a.num_households]));
	const sumByChomeAreaId = new Map();
	for (const [areaId, chomeAreaId] of chomeAreaIdByAreaId) {
		sumByChomeAreaId.set(chomeAreaId, (sumByChomeAreaId.get(chomeAreaId) ?? 0) + (householdsByAreaId.get(areaId) ?? 0));
	}
	const chomeHouseholdsByAreaId = new Map(chomeGeojson.features.map((f) => [f.properties.area_id, f.properties.num_households]));

	if (spatialWarnings.length > 0) {
		console.warn(`空間結合の警告が${spatialWarnings.length}件あります:`);
		for (const w of spatialWarnings) console.warn(`  ${w}`);
	} else {
		console.log('空間結合の警告はありませんでした（全区画が1つのチョーム境界に一致）。');
	}

	let mismatchCount = 0;
	for (const [chomeAreaId, sum] of sumByChomeAreaId) {
		const expected = chomeHouseholdsByAreaId.get(chomeAreaId);
		if (expected === undefined) continue; // 自分自身へのフォールバック（chomeFeaturesに存在しないid）
		if (expected !== sum) {
			mismatchCount++;
			console.error(`検証NG: chome_area_id=${chomeAreaId} の世帯数合計=${sum} ≠ boundary_chome.geojson側=${expected}`);
			for (const [areaId, cid] of chomeAreaIdByAreaId) {
				if (cid === chomeAreaId) console.error(`    area_id=${areaId} num_households=${householdsByAreaId.get(areaId)}`);
			}
		}
	}
	if (mismatchCount > 0) {
		console.error(`世帯数の不一致が${mismatchCount}件あります。空間結合ロジックを確認してください。`);
		process.exit(1);
	}
	console.log('検証OK: 全区画が漏れなく1つのチョーム境界に一致し、世帯数合計もすべて一致しました。');

	// --- 差分レポート: town+chome（旧グルーピング）単位と chome_area_id（新グルーピング）単位の比較 ---
	const areaByAreaId = new Map(areas.map((a) => [a.area_id, a]));
	const oldGroups = new Map(); // "town|chome" -> Set(chome_area_id)
	for (const [areaId, chomeAreaId] of chomeAreaIdByAreaId) {
		const a = areaByAreaId.get(areaId);
		const key = `${a.town}|${a.chome}`;
		if (!oldGroups.has(key)) oldGroups.set(key, new Set());
		oldGroups.get(key).add(chomeAreaId);
	}
	const split = [...oldGroups.entries()].filter(([, ids]) => ids.size > 1);
	console.log(`\n旧グルーピング(town+chome)が複数のエリアに分離された箇所: ${split.length}件`);
	for (const [key, ids] of split) {
		const [town, chome] = key.split('|');
		console.log(`  ${town}${chome ? chome + '丁目' : ''}: ${ids.size}エリアに分離 (${[...ids].join(', ')})`);
	}

	// --- areas配列にchome_area_idを反映 ---
	for (const a of areas) {
		a.chome_area_id = chomeAreaIdByAreaId.get(a.area_id) ?? a.area_id;
	}

	// --- regions/<region>/areas.sql 再生成 ---
	const allWarnings = [...extractWarnings, ...spatialWarnings];
	writeFileSync(SEED_PATH, buildAreasSql(CITY_NAME, areas, allWarnings));
	console.log(`\n${SEED_PATH} を再生成しました（${areas.length}行）。`);

	// --- migrations/backfill_chome_area_id_<region>.sql: 既存DB向けのグループ化UPDATE文 ---
	writeFileSync(MIGRATION_PATH, buildChomeAreaIdUpdateSql(chomeAreaIdByAreaId, spatialWarnings));
	console.log(`${MIGRATION_PATH} を生成しました。migrations/ の連番規則に合わせてリネームしてください。`);
}

main();
