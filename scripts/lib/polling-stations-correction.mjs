/**
 * 投票所CSVの測地系（日本測地系/世界測地系）自動検出・補正をローカルNode実行で行う共通ロジック。
 * Cloudflare Workers Freeプランのsubrequest数上限（1 invocationあたり外部fetch 50件）を避ける
 * ため、ジオコーディング（GSI地名検索APIへの全行fetch）はWorkerではなくここで行う
 * （`scripts/upload-polling-stations.mjs`・`scripts/new-region.mjs`の両方から呼ばれる）。
 *
 * 用語（bm-map-poster issue#3対応時の用語集を踏襲）:
 * - bucket（行単位）: ok=生座標が住所と一致 / candidate=変換後に一致 / unresolved=どちらも不一致 /
 *   no_address=住所未入力 / geocode_failed=ジオコーディング自体が失敗
 * - verdict（CSV全体の1つの結論）: none=変換不要 / correct_all=全行変換 / abort=判定が割れている /
 *   unchecked=判定自体が実行不能
 *
 * 座標を変換するのは verdict==='correct_all' の場合に加え、verdict==='abort' でも
 * candidateCount > okCount（日本測地系である証拠の方が優勢）の場合。bm-map-poster
 * (scripts/upload-boards.mjs)の実データ検証で、90%閾値のみでは実運用上「ok=0件でも
 * 変換されない」ケースが発生したため追加した上書きルールをここでも適用する。
 * uncertain（location_uncertain列）は「最終的にアップロードする座標が、ジオコーディングで
 * 実際に一致確認できているか」だけを見る。
 */

import { parseCsv, toCsv, stripBom } from '../../worker/csv.ts';
import { checkAndCorrectDatum } from './datum_check.ts';
import { tokyoDatumToWgs84 } from './geodetic.ts';

const OUTPUT_HEADER = ['name', 'address', 'lat', 'lng', 'location_uncertain'];

/**
 * @param {string} rawCsvText
 * @returns {Promise<{ csvText: string, summary: string[] }>}
 */
export async function buildCorrectedPollingStationsCsv(rawCsvText) {
	const text = stripBom(rawCsvText);
	const rows = parseCsv(text);
	if (rows.length < 2) {
		throw new Error('CSVにデータ行がありません。');
	}
	const header = rows[0].map((h) => h.trim());
	const colIndex = {
		name: header.indexOf('name'),
		address: header.indexOf('address'),
		lat: header.indexOf('lat'),
		lng: header.indexOf('lng'),
	};
	if (colIndex.name === -1 || colIndex.lat === -1 || colIndex.lng === -1) {
		throw new Error('CSVヘッダに name, lat, lng が必要です。');
	}

	const dataRows = rows.slice(1);
	const parsed = dataRows.map((r, i) => ({
		lineNo: i + 2,
		address: colIndex.address !== -1 ? (r[colIndex.address] ?? '').trim() : '',
		lat: Number((r[colIndex.lat] ?? '').trim()),
		lng: Number((r[colIndex.lng] ?? '').trim()),
	}));

	const summary = [];
	summary.push(`${parsed.length}行を判定します（GSI地名検索APIへ全件ジオコーディングするため少し時間がかかります）...`);

	const datumCheck = await checkAndCorrectDatum(parsed.map((r) => ({ line: r.lineNo, address: r.address, lat: r.lat, lng: r.lng })));

	summary.push(`判定結果: verdict=${datumCheck.verdict}`);
	summary.push(
		`  ok=${datumCheck.okCount} candidate=${datumCheck.candidateCount} unresolved=${datumCheck.unresolvedCount} ` +
			`no_address=${datumCheck.noAddressCount} geocode_failed=${datumCheck.geocodeFailedCount}`,
	);
	if (datumCheck.note) summary.push(`  note: ${datumCheck.note}`);
	for (const w of datumCheck.warnings) summary.push(`  警告 ${w.line}行目: ${w.message}`);

	const abortButCandidateWins = datumCheck.verdict === 'abort' && datumCheck.candidateCount > datumCheck.okCount;
	const willConvert = datumCheck.verdict === 'correct_all' || abortButCandidateWins;
	const bucketByLine = new Map(datumCheck.rows.map((r) => [r.line, r.bucket]));
	let uncertainCount = 0;
	const finalRows = parsed.map((r) => {
		const bucket = bucketByLine.get(r.lineNo);
		const { lat, lng } = willConvert ? tokyoDatumToWgs84({ lat: r.lat, lng: r.lng }) : r;
		const uncertain = willConvert ? bucket !== 'candidate' : bucket !== 'ok';
		if (uncertain) uncertainCount++;
		return { lat, lng, uncertain };
	});

	if (datumCheck.verdict === 'correct_all') {
		summary.push('→ 全行を日本測地系→世界測地系へ変換します（correct_all判定）。');
	} else if (abortButCandidateWins) {
		summary.push(
			`→ verdict=abortですが、candidate(${datumCheck.candidateCount})がok(${datumCheck.okCount})を上回っているため、` +
				'全行を日本測地系→世界測地系へ変換します。',
		);
	} else {
		summary.push(`→ 座標はCSVのまま変換しません（verdict=${datumCheck.verdict}）。`);
	}
	summary.push(`→ 要確認フラグ(?)を${uncertainCount}/${parsed.length}件に設定します。`);

	const outRows = dataRows.map((r, i) => {
		const fr = finalRows[i];
		return [r[colIndex.name] ?? '', r[colIndex.address] ?? '', fr.lat, fr.lng, fr.uncertain ? '1' : '0'];
	});
	const csvText = toCsv(OUTPUT_HEADER, outRows);

	return { csvText, summary };
}
