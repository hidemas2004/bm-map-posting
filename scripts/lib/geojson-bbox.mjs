/** GeoJSON FeatureCollection（MultiPolygon想定）全体のbboxの中心を [lat, lng] で返す。 */
export function computeCenterFromGeoJson(featureCollection) {
	let minLng = Infinity;
	let maxLng = -Infinity;
	let minLat = Infinity;
	let maxLat = -Infinity;

	const visit = (coords, depth) => {
		if (depth === 0) {
			const [lng, lat] = coords;
			if (lng < minLng) minLng = lng;
			if (lng > maxLng) maxLng = lng;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
			return;
		}
		for (const c of coords) visit(c, depth - 1);
	};

	for (const feature of featureCollection.features) {
		const { type, coordinates } = feature.geometry;
		// Polygon: [ring][point][lng,lat] = depth2, MultiPolygon: [polygon][ring][point][lng,lat] = depth3
		visit(coordinates, type === 'MultiPolygon' ? 3 : 2);
	}

	if (!Number.isFinite(minLng)) throw new Error('GeoJSONから座標を抽出できませんでした');

	const round = (n) => Math.round(n * 10000) / 10000;
	return [round((minLat + maxLat) / 2), round((minLng + maxLng) / 2)];
}
