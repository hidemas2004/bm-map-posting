import type { LatLng } from './geodetic.ts';

/**
 * ジオコーディングAPI自体の呼び出し失敗（ネットワークエラー・タイムアウト・非2xx・
 * レスポンス形式異常）を表す。「該当住所なし」（=null）とは区別する。
 */
export class GeocodeServiceError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'GeocodeServiceError';
	}
}

const FULLWIDTH_DIGIT_OFFSET = '０'.charCodeAt(0) - '0'.charCodeAt(0);

/**
 * ジオコーディングの成功率を上げるための住所正規化（v1）。
 * 丁目・番地・号の表記ゆれ吸収や漢数字変換は、実データで不一致が確認された場合に追加する。
 */
export function normalizeAddress(address: string): string {
	return address
		.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET))
		.replace(/[－ー−]/g, '-')
		.replace(/[\s　]+/g, ' ')
		.trim();
}

const GSI_ADDRESS_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
const DEFAULT_TIMEOUT_MS = 5000;

interface GsiAddressSearchResult {
	geometry?: { coordinates?: unknown };
}

/**
 * 国土地理院 地名検索API（無料・APIキー不要・WGS84準拠）で住所を正引きジオコーディングする。
 * 該当住所が見つからない場合はnull（=API呼び出し自体は成功）を返す。
 * API呼び出し自体が失敗した場合はGeocodeServiceErrorをthrowする。
 */
export async function geocodeAddress(address: string, opts: { timeoutMs?: number } = {}): Promise<LatLng | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		let res: Response;
		try {
			res = await fetch(`${GSI_ADDRESS_SEARCH_URL}?q=${encodeURIComponent(address)}`, {
				signal: controller.signal,
			});
		} catch (cause) {
			throw new GeocodeServiceError('GSIジオコーディングAPIへの接続に失敗しました', { cause });
		}
		if (!res.ok) {
			throw new GeocodeServiceError(`GSIジオコーディングAPIがエラーを返しました (status ${res.status})`);
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch (cause) {
			throw new GeocodeServiceError('GSIジオコーディングAPIのレスポンスがJSONとして解釈できません', { cause });
		}

		if (!Array.isArray(body) || body.length === 0) {
			return null;
		}
		const first = body[0] as GsiAddressSearchResult;
		const coordinates = first.geometry?.coordinates;
		if (!Array.isArray(coordinates) || coordinates.length < 2) {
			return null;
		}
		const [lng, lat] = coordinates;
		if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
			return null;
		}
		return { lat, lng };
	} finally {
		clearTimeout(timer);
	}
}
