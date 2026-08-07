import type { LatLng } from './geodetic.ts';
import { haversineDistanceMeters, tokyoDatumToWgs84 } from './geodetic.ts';
import { GeocodeServiceError, geocodeAddress, normalizeAddress } from './geocode.ts';
import { mapWithConcurrency } from './concurrency.ts';

export interface DatumCheckRow {
	line: number;
	address: string;
	lat: number;
	lng: number;
}

export type DatumBucket = 'ok' | 'candidate' | 'unresolved' | 'no_address' | 'geocode_failed';
export type DatumVerdict = 'none' | 'correct_all' | 'abort' | 'unchecked';

export interface DatumRowResult {
	line: number;
	bucket: DatumBucket;
	distRawM?: number;
	distConvM?: number;
}

export interface DatumCheckResult {
	verdict: DatumVerdict;
	rows: DatumRowResult[];
	okCount: number;
	candidateCount: number;
	unresolvedCount: number;
	noAddressCount: number;
	geocodeFailedCount: number;
	correctedCount: number;
	/** verdict === 'correct_all' の場合のみ、line -> 補正後座標 を保持する。 */
	correctedCoords: Map<number, LatLng>;
	warnings: { line: number; message: string }[];
	/** verdict === 'unchecked' の場合のみ設定される、利用者向けの説明文。 */
	note?: string;
}

export interface DatumCheckConfig {
	/** 行単位でOK/変換候補とみなす距離閾値（m）。 */
	rowThresholdMeters: number;
	/** バッチ全体をOK/変換扱いにする一致率の閾値（0-1）。 */
	batchRatioThreshold: number;
	/** ジオコーディングの同時実行数上限。 */
	concurrency: number;
	/** ジオコーディング1件あたりのタイムアウト（ms）。 */
	timeoutMs: number;
	/** バッチ判定を行うために必要な最小の判定対象行数。 */
	minJudgeableRows: number;
	/** 住所ありの行のうちこの割合以上でジオコーディングAPI呼び出し自体が失敗した場合、
	 * APIが利用不能とみなしチェックをスキップする。 */
	serviceDownRatioThreshold: number;
	geocode: (address: string, opts?: { timeoutMs?: number }) => Promise<LatLng | null>;
}

const DEFAULT_CONFIG: DatumCheckConfig = {
	rowThresholdMeters: 150,
	batchRatioThreshold: 0.9,
	concurrency: 5,
	timeoutMs: 5000,
	minJudgeableRows: 3,
	serviceDownRatioThreshold: 0.5,
	geocode: geocodeAddress,
};

interface ClassifiedRow {
	line: number;
	bucket: DatumBucket;
	distRawM?: number;
	distConvM?: number;
	raw: LatLng;
	converted: LatLng;
}

function unresolvedWarning(line: number): { line: number; message: string } {
	return { line, message: `${line}行目は住所と座標の整合性を確認できませんでした` };
}

function geocodeFailedWarning(line: number): { line: number; message: string } {
	return { line, message: `${line}行目はジオコーディングに失敗したため測地系を確認できませんでした` };
}

function stillMismatchedAfterCorrectionWarning(line: number): { line: number; message: string } {
	return { line, message: `${line}行目は測地系補正後も住所と座標の整合性を確認できませんでした` };
}

/**
 * CSV各行の座標を住所ジオコーディング結果と突き合わせ、日本測地系（Tokyo Datum）のズレを
 * 検出・補正する（issue#16）。境界データの有無に依存しない汎用ロジック。
 */
export async function checkAndCorrectDatum(
	rows: DatumCheckRow[],
	config: Partial<DatumCheckConfig> = {},
): Promise<DatumCheckResult> {
	const cfg: DatumCheckConfig = { ...DEFAULT_CONFIG, ...config };

	const noAddressLines: number[] = [];
	const geocodeFailedLines: number[] = [];
	const classified: ClassifiedRow[] = [];

	const addressedRows = rows.filter((r) => {
		if (r.address.trim() === '') {
			noAddressLines.push(r.line);
			return false;
		}
		return true;
	});

	await mapWithConcurrency(addressedRows, cfg.concurrency, async (row) => {
		const raw: LatLng = { lat: row.lat, lng: row.lng };
		const converted = tokyoDatumToWgs84(raw);

		let expected: LatLng | null;
		try {
			expected = await cfg.geocode(normalizeAddress(row.address), { timeoutMs: cfg.timeoutMs });
		} catch (err) {
			if (err instanceof GeocodeServiceError) {
				geocodeFailedLines.push(row.line);
				return;
			}
			throw err;
		}

		if (!expected) {
			classified.push({ line: row.line, bucket: 'unresolved', raw, converted });
			return;
		}

		const distRawM = haversineDistanceMeters(raw, expected);
		const distConvM = haversineDistanceMeters(converted, expected);
		let bucket: DatumBucket;
		if (distRawM <= cfg.rowThresholdMeters) {
			bucket = 'ok';
		} else if (distConvM <= cfg.rowThresholdMeters) {
			bucket = 'candidate';
		} else {
			bucket = 'unresolved';
		}
		classified.push({ line: row.line, bucket, distRawM, distConvM, raw, converted });
	});

	const okRows = classified.filter((r) => r.bucket === 'ok');
	const candidateRows = classified.filter((r) => r.bucket === 'candidate');
	const unresolvedRows = classified.filter((r) => r.bucket === 'unresolved');
	const judgedCount = classified.length;
	const addressedCount = judgedCount + geocodeFailedLines.length;

	const baseCounts = {
		okCount: okRows.length,
		candidateCount: candidateRows.length,
		unresolvedCount: unresolvedRows.length,
		noAddressCount: noAddressLines.length,
		geocodeFailedCount: geocodeFailedLines.length,
	};

	function unchecked(note: string): DatumCheckResult {
		return {
			verdict: 'unchecked',
			rows: [],
			...baseCounts,
			correctedCount: 0,
			correctedCoords: new Map(),
			warnings: [],
			note,
		};
	}

	if (addressedCount === 0) {
		return unchecked('CSVに住所が入力されていないため、測地系チェックをスキップしました');
	}
	if (geocodeFailedLines.length / addressedCount >= cfg.serviceDownRatioThreshold) {
		return unchecked(
			'GSIジオコーディングAPIに接続できなかったため、測地系チェックをスキップしました',
		);
	}
	if (judgedCount < cfg.minJudgeableRows) {
		return unchecked('判定対象の住所件数が少ないため、測地系チェックをスキップしました');
	}

	const okRatio = okRows.length / judgedCount;
	const candidateRatio = candidateRows.length / judgedCount;

	const buildRows = (): DatumRowResult[] => [
		...classified.map((r) => ({ line: r.line, bucket: r.bucket, distRawM: r.distRawM, distConvM: r.distConvM })),
		...noAddressLines.map((line) => ({ line, bucket: 'no_address' as const })),
		...geocodeFailedLines.map((line) => ({ line, bucket: 'geocode_failed' as const })),
	];

	if (okRatio >= cfg.batchRatioThreshold) {
		const warnings = [
			...unresolvedRows.map((r) => unresolvedWarning(r.line)),
			...geocodeFailedLines.map(geocodeFailedWarning),
		];
		return {
			verdict: 'none',
			rows: buildRows(),
			...baseCounts,
			correctedCount: 0,
			correctedCoords: new Map(),
			warnings,
		};
	}

	if (candidateRatio >= cfg.batchRatioThreshold) {
		const correctedCoords = new Map<number, LatLng>(rows.map((r) => [r.line, tokyoDatumToWgs84({ lat: r.lat, lng: r.lng })]));
		const stillMismatched = classified.filter(
			(r) => (r.bucket === 'ok' || r.bucket === 'unresolved') && (r.distConvM ?? Infinity) > cfg.rowThresholdMeters,
		);
		const warnings = [
			...stillMismatched.map((r) => stillMismatchedAfterCorrectionWarning(r.line)),
			...geocodeFailedLines.map(geocodeFailedWarning),
		];
		return {
			verdict: 'correct_all',
			rows: buildRows(),
			...baseCounts,
			correctedCount: rows.length,
			correctedCoords,
			warnings,
		};
	}

	return {
		verdict: 'abort',
		rows: buildRows(),
		...baseCounts,
		correctedCount: 0,
		correctedCoords: new Map(),
		warnings: [],
	};
}
