/**
 * README.md「行政区域データの追加・基本単位区単位への格上げ手順」で大和市データを取得した際の手順を
 * スクリプト化したもの。e-Statの小地域(基本単位区)境界データ（2020年国勢調査、APIキー不要）を
 * ダウンロード→mapshaperでGeoJSON化→area_id/town/chome/block/num_householdsに整形する。
 *
 * 基本単位区は町丁・字等(丁目)よりさらに細かい区画（街区相当。大和市の場合1区画平均約38世帯）。
 * 町丁・字等は都道府県単位でのダウンロードだったが、基本単位区は**市区町村単位**でしかダウンロード
 * できない点に注意（`AGGREGATE_SURVEY_ID`のシェープファイルは対象市区町村分のみを含む）。
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

/** 令和2年国勢調査 小地域(基本単位区)境界データのサーベイID（e-Stat統計地理情報システム）。 */
const AGGREGATE_SURVEY_ID = 'B002005212020';

/** areas.sql の1つのINSERT文に含める最大行数（D1の"statement too long"エラーを避けるため）。 */
const AREAS_SQL_CHUNK_SIZE = 200;

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

/** "中央林間一丁目" → { town: "中央林間", chome: "1" }。丁目が無い地域名はそのままtownに入れる。
 *  基本単位区でも町丁・字等でもS_NAMEの形式は同じ（丁目名は基本単位区の下で共有される）ため共通で使える。 */
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

export function toPolygonList(geometry) {
	if (geometry.type === 'Polygon') return [geometry.coordinates];
	if (geometry.type === 'MultiPolygon') return geometry.coordinates;
	throw new Error(`未対応のgeometry.type: ${geometry.type}`);
}

function escapeSql(s) {
	return s.replace(/'/g, "''");
}

/**
 * 同一の city/ward/town/chome 内に基本単位区が複数ある場合、区別用の通し番号を area.block に
 * 採番する（area_idでソートした順）。e-Statの公式な区画番号ではなく本システム独自の表示用連番。
 * 丁目内の基本単位区が1つだけの場合は空欄のままにする（採番しても区別する意味が無いため）。
 */
function assignBlockNumbers(areas) {
	const groups = new Map();
	for (const area of areas) {
		const key = `${area.city}${area.ward}${area.town}${area.chome}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(area);
	}
	for (const group of groups.values()) {
		if (group.length <= 1) continue;
		group.sort((a, b) => a.area_id.localeCompare(b.area_id));
		group.forEach((area, i) => {
			area.block = String(i + 1);
		});
	}
}

export function buildAreasSql(regionLabel, areas, warnings = []) {
	const lines = [
		`-- ${regionLabel} 基本単位区単位の地域マスタ（令和2年国勢調査 小地域(基本単位区)境界データより。scripts/fetch-boundary-data.mjsで自動生成）`,
		'--',
		'-- 出典: 政府統計の総合窓口(e-Stat) 統計地理情報システム',
		'--   小地域（基本単位区）境界データ（2020年国勢調査、Shapefile形式、API keyなしでダウンロード可）',
		'-- area_id は e-Stat標準地域コード（KEY_CODE）そのまま（桁数は区画により異なる）。',
		'-- block は同一丁目内で基本単位区が複数に分かれる場合の区別用通し番号（area_idをソートして',
		'--   採番。e-Statの公式な区画番号ではなく本システム独自の表示用連番）。1区画のみの丁目では空欄。',
		'-- num_households は同データのSETAI（世帯数）列の実数値（概算ではない）。',
		'-- chome_area_id は区画が属する「エリア」（boundary_chome.geojsonの境界ポリゴン）のarea_id。',
		'--   本スクリプトはチョーム境界データを取得しないため暫定的に自分自身のarea_idを設定する',
		'--   （1区画=1エリア扱い）。実際のチョーム単位への統合は scripts/backfill-chome-area-id.mjs 参照。',
	];
	if (warnings.length > 0) {
		lines.push('--', '-- 【要確認】');
		for (const w of warnings) lines.push(`--   ${w}`);
	}

	// 基本単位区は町丁・字等より件数が桁違いに多く、全件を1つのINSERT文にまとめるとD1で
	// "statement too long: SQLITE_TOOBIG" になる（ローカル・本番とも発生を確認済み）ため、
	// AREAS_SQL_CHUNK_SIZE件ごとに複数のINSERT文に分割する。
	for (let i = 0; i < areas.length; i += AREAS_SQL_CHUNK_SIZE) {
		const chunk = areas.slice(i, i + AREAS_SQL_CHUNK_SIZE);
		lines.push('INSERT INTO areas (area_id, city, ward, town, chome, block, num_households, chome_area_id) VALUES');
		const values = chunk.map((a, j) => {
			const comma = j === chunk.length - 1 ? ';' : ',';
			return `  ('${a.area_id}', '${escapeSql(a.city)}', '${escapeSql(a.ward)}', '${escapeSql(a.town)}', '${escapeSql(a.chome)}', '${escapeSql(a.block)}', ${a.num_households}, '${escapeSql(a.chome_area_id)}')${comma}`;
		});
		lines.push(...values);
	}
	return lines.join('\n') + '\n';
}

/** 与えられたGeoJSON FeatureCollection（mapshaper出力想定、基本単位区データは市区町村単位ダウンロード
 *  のため通常は対象市区町村分のみを含む）から、指定CITY_NAMEの地域を抽出・整形する。
 *  ネットワークに依存しない純粋関数なので単体テストしやすい。 */
export function extractMunicipality(featureCollection, cityName) {
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

	if (cityFeatures.length !== featureCollection.features.length) {
		warnings.push(
			`ダウンロードデータに CITY_NAME="${cityName}" 以外のフィーチャが${featureCollection.features.length - cityFeatures.length}件` +
				'混在していました（市区町村コードの取り違えの可能性。基本単位区は市区町村単位ダウンロードのため通常は混在しないはず）',
		);
	}

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

		// chome_area_id: 本来は町丁・字等（チョーム）境界データとの空間結合で求めるべきだが、
		// 現状このスクリプトは基本単位区データしか取得しないため、暫定的に自分自身のarea_idを
		// 割り当てる（1区画=1エリアとして振る舞う、安全なデフォルト。既存動作からの後退にはならない）。
		// 大和市の実際のチョーム単位への統合は scripts/backfill-chome-area-id.mjs が別途行う。
		areas.push({ area_id: keyCode, city, ward, town, chome, block: '', num_households: totalHouseholds, chome_area_id: keyCode });
		mergedFeatures.push({
			type: 'Feature',
			properties: { area_id: keyCode, city, ward, town, chome, block: '' },
			geometry: { type: 'MultiPolygon', coordinates: features.flatMap((f) => toPolygonList(f.geometry)) },
		});
	}

	assignBlockNumbers(areas);
	const blockByAreaId = new Map(areas.map((a) => [a.area_id, a.block]));
	for (const f of mergedFeatures) f.properties.block = blockByAreaId.get(f.properties.area_id) ?? '';

	areas.sort((a, b) => a.area_id.localeCompare(b.area_id));
	mergedFeatures.sort((a, b) => a.properties.area_id.localeCompare(b.properties.area_id));

	return { areas, geojson: { type: 'FeatureCollection', features: mergedFeatures }, warnings };
}

function downloadMunicipalityShapefile(cityCode) {
	mkdirSync(CACHE_DIR, { recursive: true });
	const zipPath = path.join(CACHE_DIR, `city${cityCode}.zip`);
	const extractDir = path.join(CACHE_DIR, `city${cityCode}`);

	if (!existsSync(zipPath)) {
		const url = `https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=${AGGREGATE_SURVEY_ID}&code=${cityCode}&coordSys=1&format=shape&downloadType=5&datum=2011`;
		console.log(`e-Statから市区町村コード${cityCode}の基本単位区シェープファイルをダウンロード中...`);
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
 * 指定市区町村の基本単位区境界データを取得し、regions/<id>/ 相当のoutDirに
 * areas.sql・boundary.geojson を書き出す。
 * @param {{ cityCode: string, cityName: string, outDir: string }} options
 *   cityCode: 総務省「全国地方公共団体コード」の5桁市区町村コード（例: 大和市=14213、横浜市鶴見区=14101）
 *   cityName: e-StatのCITY_NAME（例: "大和市", "横浜市鶴見区"）。取り違え検知の照合に使う。
 */
export function fetchCityBoundary({ cityCode, cityName, outDir }) {
	const extractDir = downloadMunicipalityShapefile(cityCode);
	const shpPath = findShpFile(extractDir);
	const geojsonPath = path.join(CACHE_DIR, `city${cityCode}.geojson`);
	if (!existsSync(geojsonPath)) {
		convertToGeoJson(shpPath, geojsonPath);
	} else {
		console.log('(キャッシュ済みのGeoJSONを使用します: ' + geojsonPath + ')');
	}

	const featureCollection = JSON.parse(readFileSync(geojsonPath, 'utf8'));
	const { areas, geojson, warnings } = extractMunicipality(featureCollection, cityName);

	mkdirSync(outDir, { recursive: true });
	writeFileSync(path.join(outDir, 'boundary.geojson'), JSON.stringify(geojson));
	writeFileSync(path.join(outDir, 'areas.sql'), buildAreasSql(cityName, areas, warnings));

	return { areas, warnings, outDir };
}
