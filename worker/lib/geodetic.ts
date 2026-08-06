export interface LatLng {
	lat: number;
	lng: number;
}

/**
 * 日本測地系（Tokyo Datum）からWGS84への簡易変換（国土地理院公式の近似式）。
 * 誤差は数m〜十数m程度残る。ミリ〜メートル単位の精度が必要な場合はTKY2JGDへの
 * 置き換えを検討する（issue#16では非対象・保留事項）。
 */
export function tokyoDatumToWgs84({ lat, lng }: LatLng): LatLng {
	const dLat = -0.00010695 * lat + 0.000017464 * lng + 0.0046017;
	const dLng = -0.000046038 * lat - 0.000083043 * lng + 0.01004;
	return { lat: lat + dLat, lng: lng + dLng };
}

const EARTH_RADIUS_METERS = 6371000;

export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);

	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}
