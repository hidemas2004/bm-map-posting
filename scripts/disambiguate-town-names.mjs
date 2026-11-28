#!/usr/bin/env node
/**
 * issue#42対応: 既にデプロイ済みの地域で、同じ名前のエリア（丁目のない大字がe-Statで複数のKEY_CODEに
 * 分割されているもの）を番号付きの名前（例: 大庭（006））に変えるためのCLI。番号付けの規則は
 * scripts/lib/estat-boundary.mjs の disambiguateDuplicateTownNames を参照。
 *
 * 既定はドライラン: 地域ごとの重複グループ・変更後の名前・影響する区画数を表示するだけで何も書き換えない。
 * --apply を付けると、指定した地域の次のファイルを書き換える。
 *   - regions/<id>/boundary_chome.geojson と public/data/regions/<id>/boundary_chome.geojson の
 *     該当フィーチャの properties.town（書式を保つため該当箇所だけを文字列置換する）
 *   - regions/<id>/areas.sql の該当区画の town
 *   - regions/<id>/chome_area_id.sql があれば、末尾に town の更新を追加（新しいDBでも名前がそろうように）
 * あわせて、既存DB向けのマイグレーション本文を標準出力に表示する（migrations/ の連番に合わせて保存すること）。
 * D1（ローカル・本番とも）には一切アクセスしない。
 *
 * 使い方:
 *   node scripts/disambiguate-town-names.mjs                    # 全地域のドライラン
 *   node scripts/disambiguate-town-names.mjs --region 14205-fujisawa --apply
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { disambiguateDuplicateTownNames, buildTownUpdateLines } from './lib/estat-boundary.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
	options: {
		region: { type: 'string' },
		apply: { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (args.help) {
	console.log('使い方: node scripts/disambiguate-town-names.mjs [--region <地域ID>] [--apply]');
	console.log('  --apply を付けない場合はドライラン（変更内容の表示のみ）。--apply には --region が必要。');
	process.exit(0);
}
if (args.apply && !args.region) {
	console.error('--apply には --region <地域ID> が必要です（地域ごとに確認してから反映するため）。');
	process.exit(1);
}

/** areas.sql の値の行 `  ('area_id', 'city', 'ward', 'town', 'chome', 'block', 世帯数, 'chome_area_id'),` */
const SQL_STR = "'((?:[^']|'')*)'";
const AREA_ROW_RE = new RegExp(`^(  \\(${SQL_STR}, ${SQL_STR}, ${SQL_STR}, )${SQL_STR}(, ${SQL_STR}, ${SQL_STR}, (\\d+), ${SQL_STR}\\)[,;])$`);
const unescapeSql = (s) => s.replace(/''/g, "'");
const escapeSql = (s) => s.replace(/'/g, "''");

function chomeBoundaryPaths(regionId) {
	return [
		path.join(REPO_ROOT, 'regions', regionId, 'boundary_chome.geojson'),
		path.join(REPO_ROOT, 'public', 'data', 'regions', regionId, 'boundary_chome.geojson'),
	].filter((p) => existsSync(p));
}

function listRegions() {
	const ids = new Set();
	for (const base of [path.join(REPO_ROOT, 'regions'), path.join(REPO_ROOT, 'public', 'data', 'regions')]) {
		if (!existsSync(base)) continue;
		for (const id of readdirSync(base)) if (chomeBoundaryPaths(id).length > 0) ids.add(id);
	}
	return [...ids].sort();
}

/** 区画のarea_id -> { town, chome_area_id, households, lineIndex } を areas.sql（と、あれば chome_area_id.sql）から読む。 */
function readBlocks(regionId) {
	const areasSqlPath = path.join(REPO_ROOT, 'regions', regionId, 'areas.sql');
	if (!existsSync(areasSqlPath)) return null;
	const lines = readFileSync(areasSqlPath, 'utf8').split('\n');
	const blocks = new Map();
	lines.forEach((line, lineIndex) => {
		const m = line.match(AREA_ROW_RE);
		if (!m) return;
		blocks.set(unescapeSql(m[2]), {
			town: unescapeSql(m[5]),
			chome_area_id: unescapeSql(m[10]),
			households: Number(m[9]),
			lineIndex,
		});
	});
	const chomeSqlPath = path.join(REPO_ROOT, 'regions', regionId, 'chome_area_id.sql');
	if (existsSync(chomeSqlPath)) {
		const re = /^UPDATE areas SET chome_area_id = '((?:[^']|'')*)' WHERE area_id IN \((.*)\);$/;
		for (const line of readFileSync(chomeSqlPath, 'utf8').split('\n')) {
			const m = line.match(re);
			if (!m) continue;
			const chomeAreaId = unescapeSql(m[1]);
			for (const idm of m[2].matchAll(/'((?:[^']|'')*)'/g)) {
				const block = blocks.get(unescapeSql(idm[1]));
				if (block) block.chome_area_id = chomeAreaId;
			}
		}
	}
	return { areasSqlPath, lines, blocks, chomeSqlPath: existsSync(chomeSqlPath) ? chomeSqlPath : null };
}

function analyze(regionId) {
	const [primaryPath] = chomeBoundaryPaths(regionId);
	const geojson = JSON.parse(readFileSync(primaryPath, 'utf8'));
	const { renamed } = disambiguateDuplicateTownNames(geojson.features);
	const blockData = readBlocks(regionId);
	const details = renamed.map((r) => {
		const members = blockData ? [...blockData.blocks.values()].filter((b) => b.chome_area_id === r.chome_area_id) : [];
		return {
			...r,
			blocks: members.length,
			households: members.reduce((sum, b) => sum + b.households, 0),
			// 区画のtownがエリアの元の名前と違う区画（想定外。あれば反映前に要確認）
			mismatched: members.filter((b) => b.town !== r.before && b.town !== r.after).length,
		};
	});
	return { renamed: details, blockData };
}

function printReport(regionId, details, blockData) {
	const groups = new Set(details.map((d) => d.before)).size;
	console.log(`\n== ${regionId}: ${groups}グループ・${details.length}エリア${blockData ? '' : '（areas.sqlが無いため区画数は不明）'}`);
	for (const d of details) {
		const blockInfo = blockData ? ` 区画${d.blocks} 世帯${d.households.toLocaleString()}` : '';
		const warn = d.mismatched > 0 ? ` 【要確認: 名前の違う区画${d.mismatched}件】` : '';
		console.log(`  ${d.chome_area_id}  ${d.before} → ${d.after}${blockInfo}${warn}`);
	}
}

/** geojsonの書式（区切りの空白など）を保ったまま、該当フィーチャの town だけを置き換える。 */
function rewriteGeojson(filePath, renamed) {
	let text = readFileSync(filePath, 'utf8');
	for (const r of renamed) {
		const id = JSON.stringify(r.chome_area_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const before = JSON.stringify(r.before).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`("area_id":\\s*${id},[^{}]*?"town":\\s*)${before}`, 'g');
		const matches = text.match(re) ?? [];
		if (matches.length !== 1) throw new Error(`${filePath}: area_id=${r.chome_area_id} の town が${matches.length}件見つかりました（1件のはず）`);
		text = text.replace(re, (_, prefix) => prefix + JSON.stringify(r.after));
	}
	// 検証: 読み込み直して、変わったのが対象フィーチャの town だけであること
	const original = JSON.parse(readFileSync(filePath, 'utf8'));
	const afterById = new Map(renamed.map((r) => [r.chome_area_id, r.after]));
	for (const f of original.features) if (afterById.has(f.properties.area_id)) f.properties.town = afterById.get(f.properties.area_id);
	if (JSON.stringify(original) !== JSON.stringify(JSON.parse(text))) throw new Error(`${filePath}: 置換結果の検証に失敗しました`);
	writeFileSync(filePath, text);
	console.log(`${path.relative(REPO_ROOT, filePath)}: ${renamed.length}フィーチャの town を更新しました`);
}

function rewriteAreasSql(blockData, renamed) {
	const byChome = new Map(renamed.map((r) => [r.chome_area_id, r]));
	let count = 0;
	for (const block of blockData.blocks.values()) {
		const r = byChome.get(block.chome_area_id);
		if (!r || block.town !== r.before) continue;
		const line = blockData.lines[block.lineIndex];
		const m = line.match(AREA_ROW_RE);
		blockData.lines[block.lineIndex] = `${m[1]}'${escapeSql(r.after)}'${m[6]}`;
		count++;
	}
	writeFileSync(blockData.areasSqlPath, blockData.lines.join('\n'));
	console.log(`${path.relative(REPO_ROOT, blockData.areasSqlPath)}: ${count}区画の town を更新しました`);
}

function rewriteChomeAreaIdSql(chomeSqlPath, townByChomeAreaId) {
	const text = readFileSync(chomeSqlPath, 'utf8');
	// 既に追加済みなら作り直す（繰り返し実行しても重複させない）
	const kept = text.split('\n').filter((line) => !/^UPDATE areas SET town = /.test(line) && !/issue#42|disambiguateDuplicateTownNames/.test(line));
	while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
	writeFileSync(chomeSqlPath, [...kept, ...buildTownUpdateLines(townByChomeAreaId)].join('\n') + '\n');
	console.log(`${path.relative(REPO_ROOT, chomeSqlPath)}: town の更新${townByChomeAreaId.size}件を末尾に追加しました`);
}

function main() {
	const regions = args.region ? [args.region] : listRegions();
	for (const regionId of regions) {
		if (chomeBoundaryPaths(regionId).length === 0) {
			console.error(`${regionId}: boundary_chome.geojson がありません`);
			process.exitCode = 1;
			continue;
		}
		const { renamed, blockData } = analyze(regionId);
		printReport(regionId, renamed, blockData);
		if (!args.apply || renamed.length === 0) continue;

		if (renamed.some((d) => d.mismatched > 0)) {
			console.error('名前の違う区画があるため反映を中止しました。内容を確認してください。');
			process.exit(1);
		}
		console.log('');
		for (const p of chomeBoundaryPaths(regionId)) rewriteGeojson(p, renamed);
		const townByChomeAreaId = new Map(renamed.map((r) => [r.chome_area_id, r.after]));
		if (blockData) {
			rewriteAreasSql(blockData, renamed);
			if (blockData.chomeSqlPath) rewriteChomeAreaIdSql(blockData.chomeSqlPath, townByChomeAreaId);
		}
		console.log('\n--- 既存DB向けマイグレーション本文（migrations/ の連番に合わせて保存すること） ---');
		console.log(buildTownUpdateLines(townByChomeAreaId).join('\n'));
	}
}

main();
