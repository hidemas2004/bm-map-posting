function escapeCsvValue(value: string | number): string {
	const s = String(value);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel（特にWindows版）で文字化けしないよう、先頭にUTF-8 BOMを付与する。 */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
	const lines = [headers, ...rows].map((row) => row.map(escapeCsvValue).join(','));
	return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function csvResponse(csv: string, filename: string): Response {
	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
		},
	});
}
