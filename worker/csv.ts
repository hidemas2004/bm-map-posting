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

/** 簡易CSVパーサ。ダブルクォート囲み・""エスケープに対応（改行を含むフィールドは非対応）。 */
export function parseCsv(text: string): string[][] {
	const lines = text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
	return lines.map((line) => {
		const fields: string[] = [];
		let cur = '';
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inQuotes) {
				if (ch === '"') {
					if (line[i + 1] === '"') {
						cur += '"';
						i++;
					} else {
						inQuotes = false;
					}
				} else {
					cur += ch;
				}
			} else if (ch === '"') {
				inQuotes = true;
			} else if (ch === ',') {
				fields.push(cur);
				cur = '';
			} else {
				cur += ch;
			}
		}
		fields.push(cur);
		return fields;
	});
}

/** CSVアップロード系エンドポイントの前処理共通化: UTF-8 BOM除去。 */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
