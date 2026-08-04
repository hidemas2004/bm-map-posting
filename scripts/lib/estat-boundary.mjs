/**
 * README.md「行政区域データの追加・丁目単位への格上げ手順」で大和市データを取得した際の手順を
 * スクリプト化したもの。e-Statの町丁・字等境界データ（2020年国勢調査、APIキー不要）を
 * ダウンロード→mapshaperでGeoJSON化→対象市区町村を抽出→area_id/town/chome/num_householdsに整形する。
 *
 * 注意: このスクリプトの実行には `curl`・`unzip`・ネットワーク到達性
 * （www.e-stat.go.jp、npx経由のmapshaperダウンロード）が必要。ネットワークが制限された環境
 * （一部のサンドボックス等）では失敗するため、その場合はPC等の到達可能な環境で実行すること。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'estat-boundary');

const DESIGNATED_CITIES = ['横浜市', '川崎市', '相模原市'];
const DIGITS = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function kanjiToNumber(s) {
	if (s === '十') return 10;
	if (s.length === 1 && DIGITS[s] !== undefined) return DIGITS[s];
	if (s.includes('十')) {
		const [tensPart, onesPart] = s.split('十');
		const tens = tensPart === '' ? 1 : DIGITS[tensPart];
		const ones = onesPart === '' ? 0 : DIGITS[onesPart];
		if (tens === undefined || ones === undefined) return null;
		return tens * 10 + ones;
	}
	return null;
}

/** "中央林間一丁目" → { town: "中央林間", chome: "1" }。丁目が無い地域名はそのままtownに入れる。 */
export function parseTownChome(sName) {
	const m = sName.match(/^(.*?)([〇一二三四五六七八九十]+)丁目$/);
	if (!m) return { town: sName, chome: '' };
	const [, town, kanjiNum] = m;
	const num = kanjiToNumber(kanjiNum);
	if (num === null) return { town: sName, chome: '', warning: true };
	return { town, chome: String(num) };
}

/** 政令指定都市のCITY_NAME（例: "横浜市鶴見区"）を city/ward に分割する。それ以外はward=''。 */
export function splitCityWard(cityName) {
	for (const dc of DESIGNATED_CITIES) {
		if (cityName.startsWith(dc) && cityName !== dc) {
			return { city: dc, ward: cityName.slice(dc.length) };
		}
	}
	return { city: cityName, ward: '' };
}

function toPolygonList(geometry) {
	if (geometry.type === 'Polygon') return [geometry.coordinates];
	if (geometry.type === 'MultiPolygon') return geometry.coordinates;
	throw new Error(`未対応のgeometry.type: ${geometry.type}`);
}

function escapeSql(s) {
	return s.replace(/'/g, "''");
}

export function buildAreasSql(regionLabel, areas, warnings = []) {
	const lines = [
		`-- ${regionLabel} 丁目単位の地域マスタ（令和2年国勢調査 小地域境界データより。scripts/fetch-boundary-data.mjsで自動生成）`,
		'--',
		'-- 出典: 政府統計の総合窓口(e-Stat) 統計地理情報システム',
		'--   町丁・字等境界データ（2020年国勢調査、Shapefile形式、API keyなしでダウンロード可）',
		'-- area_id は e-Stat標準地域コード（KEY_CODE、11桁）そのまま。',
		'-- num_households は同データのSETAI（世帯数）列の実数値（概算ではない）。',
	];
	if (warnings.length > 0) {
		lines.push('--', '-- 【要確認】');
		for (const w of warnings) lines.push(`--   ${w}`);
	}
	lines.push('INSERT INTO areas (area_id, city, ward, town, chome, num_households) VALUES');
	const values = areas.map((a, i) => {
		const comma = i === areas.length - 1 ? ';' : ',';
		return `  ('${a.area_id}', '${escapeSql(a.city)}', '${escapeSql(a.ward)}', '${escapeSql(a.town)}', '${escapeSql(a.chome)}', ${a.num_households})${comma}`;
	});
	return [...lines, ...values].join('\n') + '\n';
}

/** 与えられたGeoJSON FeatureCollection（mapshaper出力想定）から、指定CITY_NAMEの地域を抽出・整形する。
 *  ネットワークに依存しない純粋関数なので単体テストしやすい。 */
export function extractCity(featureCollection, cityName) {
	const cityFeatures = featureCollection.features.filter((f) => f.properties.CITY_NAME === cityName);
	if (cityFeatures.length === 0) {
		throw new Error(
			`CITY_NAME="${cityName}" のフィーチャが見つかりません（表記揺れの可能性。政令指定都市の区は` +
				`"横浜市鶴見区"のように市区一体で指定する）`,
		);
	}

	const byKeyCode = new Map();
	for (const f of cityFeatures) {
		const key = f.properties.KEY_CODE;
		if (!byKeyCode.has(key)) byKeyCode.set(key, []);
		byKeyCode.get(key).push(f);
	}

	const { city, ward } = splitCityWard(cityName);
	const areas = [];
	const mergedFeatures = [];
	const warnings = [];

	for (const [keyCode, features] of byKeyCode) {
		const first = features[0].properties;
		const totalHouseholds = features.reduce((sum, f) => sum + (Number(f.properties.SETAI) || 0), 0);
		const { town, chome, warning } = parseTownChome(first.S_NAME ?? '');
		if (warning) {
			warnings.push(`area_id=${keyCode}: S_NAME="${first.S_NAME}" の丁目部分を解析できませんでした（chomeを空欄にしています。手動確認推奨）`);
		}
		if (totalHouseholds === 0) {
			warnings.push(`area_id=${keyCode} (${town}${chome}): 世帯数が0です（商業地・工業地等の可能性。配布記録の対象外として扱われます）`);
		}
		if (features.length > 1) {
			warnings.push(`area_id=${keyCode} (${town}${chome}): ${features.length}個のポリゴンをMultiPolygonに統合しました`);
		}

		areas.push({ area_id: keyCode, city, ward, town, chome, num_households: totalHouseholds });
		mergedFeatures.push({
			type: 'Feature',
			properties: { area_id: keyCode, city, ward, town, chome },
			geometry: { type: 'MultiPolygon', coordinates: features.flatMap((f) => toPolygonList(f.geometry)) },
		});
	}

	areas.sort((a, b) => a.area_id.localeCompare(b.area_id));
	mergedFeatures.sort((a, b) => a.properties.area_id.localeCompare(b.properties.area_id));

	return { areas, geojson: { type: 'FeatureCollection', features: mergedFeatures }, warnings };
}

function downloadPrefectureShapefile(prefCode) {
	mkdirSync(CACHE_DIR, { recursive: true });
	const zipPath = path.join(CACHE_DIR, `pref${prefCode}.zip`);
	const extractDir = path.join(CACHE_DIR, `pref${prefCode}`);

	if (!existsSync(zipPath)) {
		const url = `https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=${prefCode}&coordSys=1&format=shape&downloadType=5&datum=2011`;
		console.log(`e-Statから都道府県コード${prefCode}のシェープファイルをダウンロード中...`);
		execFileSync('curl', ['-L', '-f', '-o', zipPath, url], { stdio: 'inherit' });
	} else {
		console.log('(キャッシュ済みのZIPを使用します: ' + zipPath + ')');
	}

	if (!existsSync(extractDir) || readdirSync(extractDir).length === 0) {
		mkdirSync(extractDir, { recursive: true });
		execFileSync('unzip', ['-o', zipPath, '-d', extractDir], { stdio: 'inherit' });
	}
	return extractDir;
}

function findShpFile(dir) {
	const shp = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.shp'));
	if (!shp) throw new Error(`${dir} に.shpファイルが見つかりません`);
	return path.join(dir, shp);
}

function convertToGeoJson(shpPath, outPath) {
	console.log('mapshaperでGeoJSONに変換中...');
	execFileSync('npx', ['--yes', 'mapshaper', '-i', shpPath, '-o', 'format=geojson', outPath], { stdio: 'inherit' });
}

/**
 * 指定都道府県・市区町村の境界データを取得し、regions/<id>/ 相当のoutDirに
 * areas.sql・boundary.geojson を書き出す。
 * @param {{ prefCode?: string, cityName: string, outDir: string }} options
 */
export function fetchCityBoundary({ prefCode = '14', cityName, outDir }) {
	const extractDir = downloadPrefectureShapefile(prefCode);
	const shpPath = findShpFile(extractDir);
	const geojsonPath = path.join(CACHE_DIR, `pref${prefCode}.geojson`);
	if (!existsSync(geojsonPath)) {
		convertToGeoJson(shpPath, geojsonPath);
	} else {
		console.log('(キャッシュ済みのGeoJSONを使用します: ' + geojsonPath + ')');
	}

	const featureCollection = JSON.parse(readFileSync(geojsonPath, 'utf8'));
	const { areas, geojson, warnings } = extractCity(featureCollection, cityName);

	mkdirSync(outDir, { recursive: true });
	writeFileSync(path.join(outDir, 'boundary.geojson'), JSON.stringify(geojson));
	writeFileSync(path.join(outDir, 'areas.sql'), buildAreasSql(cityName, areas, warnings));

	return { areas, warnings, outDir };
}
