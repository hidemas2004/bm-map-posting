/**
 * issue#12対応: 大和市の既存地域マスタに chome_area_id（区画が属する「エリア」＝
 * boundary_chome.geojsonの境界ポリゴンのarea_id）を空間結合で算出し、
 *   1. migrations/0005_backfill_chome_area_id_yamato.sql（既存DB向け・グループ化UPDATE文）
 *   2. seed/areas_yamato.sql（フレッシュDB向け・chome_area_id列を含む形に再生成）
 * を出力する。あわせて、town+chome単位の旧グルーピングとchome_area_id単位の新グルーピングの
 * 差分（下鶴間等が分離されること）をコンソールに要約表示する。
 *
 * 前提: .cache/estat-boundary/city14213.geojson（基本単位区の生データ、npm run fetch-boundary-data
 * 実行時にキャッシュ済み）と public/data/boundary_chome.geojson が存在すること。
 *
 * 実行方法: node scripts/backfill-chome-area-id.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMunicipality, buildAreasSql } from './lib/estat-boundary.mjs';
import { assignChomeAreaIds } from './lib/geo.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CITY_CODE = '14213';
const CITY_NAME = '大和市';
const CACHE_GEOJSON = path.join(REPO_ROOT, '.cache', 'estat-boundary', `city${CITY_CODE}.geojson`);
const CHOME_BOUNDARY_PATH = path.join(REPO_ROOT, 'public', 'data', 'boundary_chome.geojson');
const SEED_PATH = path.join(REPO_ROOT, 'seed', 'areas_yamato.sql');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '0005_backfill_chome_area_id_yamato.sql');

/** 1つのUPDATE文のIN(...)に含めるarea_id数の上限（D1のSQL文長制限を避けるための安全マージン）。 */
const UPDATE_CHUNK_SIZE = 500;

function escapeSql(s) {
	return s.replace(/'/g, "''");
}

function main() {
	if (!existsSync(CACHE_GEOJSON)) {
		console.error(`キャッシュが見つかりません: ${CACHE_GEOJSON}`);
		console.error('先に `npm run fetch-boundary-data -- --region ... --city 大和市 --cityCode 14213` 等でキャッシュを作成するか、');
		console.error('ネットワーク到達可能な環境で実行してください。');
		process.exit(1);
	}
	if (!existsSync(CHOME_BOUNDARY_PATH)) {
		console.error(`チョーム境界データが見つかりません: ${CHOME_BOUNDARY_PATH}`);
		process.exit(1);
	}

	const featureCollection = JSON.parse(readFileSync(CACHE_GEOJSON, 'utf8'));
	const { areas, geojson: blockGeojson, warnings: extractWarnings } = extractMunicipality(featureCollection, CITY_NAME);

	const chomeGeojson = JSON.parse(readFileSync(CHOME_BOUNDARY_PATH, 'utf8'));

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

	// --- seed/areas_yamato.sql 再生成 ---
	const allWarnings = [...extractWarnings, ...spatialWarnings];
	writeFileSync(SEED_PATH, buildAreasSql(CITY_NAME, areas, allWarnings));
	console.log(`\n${SEED_PATH} を再生成しました（${areas.length}行）。`);

	// --- migrations/0005: 既存DB向けのグループ化UPDATE文 ---
	const groups = new Map(); // chome_area_id -> area_id[]
	for (const a of areas) {
		if (!groups.has(a.chome_area_id)) groups.set(a.chome_area_id, []);
		groups.get(a.chome_area_id).push(a.area_id);
	}
	const lines = [
		'-- issue#12対応: areas.chome_area_id のバックフィル（大和市、既存DB向け）。',
		'-- scripts/backfill-chome-area-id.mjs で自動生成。area_id自体・他の列は変更しない。',
		`-- 対象: ${areas.length}区画 / ${groups.size}エリア`,
	];
	for (const [chomeAreaId, areaIds] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		for (let i = 0; i < areaIds.length; i += UPDATE_CHUNK_SIZE) {
			const chunk = areaIds.slice(i, i + UPDATE_CHUNK_SIZE);
			const list = chunk.map((id) => `'${escapeSql(id)}'`).join(', ');
			lines.push(`UPDATE areas SET chome_area_id = '${escapeSql(chomeAreaId)}' WHERE area_id IN (${list});`);
		}
	}
	writeFileSync(MIGRATION_PATH, lines.join('\n') + '\n');
	console.log(`${MIGRATION_PATH} を生成しました（${groups.size}エリア、${lines.length - 3}文）。`);
}

main();
