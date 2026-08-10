#!/usr/bin/env node
/**
 * 単体実行用CLI: 指定した市区町村の基本単位区境界データ・地域マスタを取得し、regions/<id>/ に出力する。
 *
 * 使い方:
 *   node scripts/fetch-boundary-data.mjs --region 202704-hiratsuka --city 平塚市 --cityCode 14206
 *
 * --chome-only を付けると、基本単位区の代わりに「エリア」境界（町丁・字等境界データ、都道府県単位
 * ダウンロード）だけを取得し regions/<id>/boundary_chome.geojson に出力する（wrangler認証・D1作成を
 * 伴う npm run new-region のフルフローを回さずに、エリア境界データだけ動作確認・再取得したい場合用）。
 *
 * cityCode は総務省「全国地方公共団体コード」の5桁市区町村コード（政令指定都市の区は区ごとに別コード）。
 * ネットワーク到達性（www.e-stat.go.jp）が必要。scripts/new-region.mjs から呼び出される他、
 * データだけ再取得・再生成したい場合に単独実行できる。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCityBoundary, fetchChomeBoundary } from './lib/estat-boundary.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--region') args.region = argv[++i];
		else if (arg === '--city') args.city = argv[++i];
		else if (arg === '--cityCode') args.cityCode = argv[++i];
		else if (arg === '--chome-only') args.chomeOnly = true;
		else if (arg === '--help' || arg === '-h') args.help = true;
	}
	return args;
}

function printUsageAndExit(code) {
	console.log(
		[
			'使い方: node scripts/fetch-boundary-data.mjs --region <地域ID> --city <e-StatのCITY_NAME> --cityCode <5桁市区町村コード> [--chome-only]',
			'例:     node scripts/fetch-boundary-data.mjs --region 202704-hiratsuka --city 平塚市 --cityCode 14206',
			'例（政令指定都市の区）: --city 横浜市鶴見区 --cityCode 14101',
			'例（エリア境界のみ再取得）: --region 14213-yamato --city 大和市 --cityCode 14213 --chome-only',
			'市区町村コードは総務省「全国地方公共団体コード」で確認できる。',
		].join('\n'),
	);
	process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.region || !args.city || !args.cityCode) printUsageAndExit(args.help ? 0 : 1);

const outDir = path.join(REPO_ROOT, 'regions', args.region);

try {
	if (args.chomeOnly) {
		const { geojson, warnings } = fetchChomeBoundary({ cityCode: args.cityCode, cityName: args.city, outDir });
		console.log(`\n完了: ${geojson.features.length}件のエリアを ${path.relative(REPO_ROOT, outDir)}/boundary_chome.geojson に出力しました。`);
		if (warnings.length > 0) {
			console.log(`\n【要確認事項 ${warnings.length}件】`);
			for (const w of warnings) console.log(`  - ${w}`);
		}
	} else {
		const { areas, warnings } = fetchCityBoundary({ cityCode: args.cityCode, cityName: args.city, outDir });
		console.log(`\n完了: ${areas.length}件の地域を ${path.relative(REPO_ROOT, outDir)}/areas.sql, boundary.geojson に出力しました。`);
		if (warnings.length > 0) {
			console.log(`\n【要確認事項 ${warnings.length}件】`);
			for (const w of warnings) console.log(`  - ${w}`);
		}
	}
} catch (err) {
	console.error(`\nエラー: ${err.message}`);
	process.exit(1);
}
