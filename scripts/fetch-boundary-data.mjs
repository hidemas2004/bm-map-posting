#!/usr/bin/env node
/**
 * 単体実行用CLI: 指定した市区町村の基本単位区境界データ・地域マスタを取得し、regions/<id>/ に出力する。
 *
 * 使い方:
 *   node scripts/fetch-boundary-data.mjs --region 202704-hiratsuka --city 平塚市 --cityCode 14206
 *
 * cityCode は総務省「全国地方公共団体コード」の5桁市区町村コード（政令指定都市の区は区ごとに別コード）。
 * ネットワーク到達性（www.e-stat.go.jp）が必要。scripts/new-region.mjs から呼び出される他、
 * データだけ再取得・再生成したい場合に単独実行できる。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCityBoundary } from './lib/estat-boundary.mjs';

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
			'使い方: node scripts/fetch-boundary-data.mjs --region <地域ID> --city <e-StatのCITY_NAME> --cityCode <5桁市区町村コード>',
			'例:     node scripts/fetch-boundary-data.mjs --region 202704-hiratsuka --city 平塚市 --cityCode 14206',
			'例（政令指定都市の区）: --city 横浜市鶴見区 --cityCode 14101',
			'市区町村コードは総務省「全国地方公共団体コード」で確認できる。',
		].join('\n'),
	);
	process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.region || !args.city || !args.cityCode) printUsageAndExit(args.help ? 0 : 1);

const outDir = path.join(REPO_ROOT, 'regions', args.region);

try {
	const { areas, warnings } = fetchCityBoundary({ cityCode: args.cityCode, cityName: args.city, outDir });
	console.log(`\n完了: ${areas.length}件の地域を ${path.relative(REPO_ROOT, outDir)}/areas.sql, boundary.geojson に出力しました。`);
	if (warnings.length > 0) {
		console.log(`\n【要確認事項 ${warnings.length}件】`);
		for (const w of warnings) console.log(`  - ${w}`);
	}
} catch (err) {
	console.error(`\nエラー: ${err.message}`);
	process.exit(1);
}
