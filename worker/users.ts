/**
 * ログイン画面のユーザーIDプルダウン用。合言葉等の機微情報は含めない。
 */

import { csvResponse, toCsv } from './csv';

export interface UsersEnv {
	DB: D1Database;
}

export async function listActiveUsers(env: UsersEnv): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT user_id, name FROM users WHERE active = 1 ORDER BY user_id',
	).all<{ user_id: string; name: string }>();
	return Response.json(results);
}

interface UserRow {
	user_id: string;
	name: string;
	role: '管理者' | '一般';
	active: number;
}

export async function listUsers(env: UsersEnv): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT user_id, name, role, active FROM users ORDER BY user_id',
	).all<UserRow>();
	return Response.json(results);
}

/** 合言葉は常に空欄でエクスポートする（ダウンロードしたCSVに現在の合言葉を平文で載せないため）。 */
export async function exportUsersCsv(env: UsersEnv): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT user_id, name, role, active FROM users ORDER BY user_id',
	).all<UserRow>();
	const csv = toCsv(
		['user_id', 'name', 'role', 'active', 'passphrase'],
		results.map((r) => [r.user_id, r.name, r.role, r.active, '']),
	);
	return csvResponse(csv, 'users.csv');
}

/** 簡易CSVパーサ。ダブルクォート囲み・""エスケープに対応（改行を含むフィールドは非対応）。 */
function parseCsv(text: string): string[][] {
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

/**
 * ユーザーマスタ一括投入（管理者限定）。`user_id`が既存ならUPSERT、なければ新規追加。
 * CSVヘッダ: user_id, name, role, active, passphrase（passphrase以外は必須ヘッダ）。
 * passphrase列を空欄にすると、既存ユーザーの合言葉は変更しない（新規ユーザーは必須）。
 * role省略時は「一般」、active省略時は1（ログイン可）として扱う。
 */
export async function importUsers(request: Request, env: UsersEnv): Promise<Response> {
	let text = await request.text();
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM除去

	const rows = parseCsv(text);
	if (rows.length === 0) {
		return Response.json({ error: 'CSVが空です' }, { status: 400 });
	}

	const header = rows[0].map((h) => h.trim());
	const colIndex = {
		user_id: header.indexOf('user_id'),
		name: header.indexOf('name'),
		role: header.indexOf('role'),
		active: header.indexOf('active'),
		passphrase: header.indexOf('passphrase'),
	};
	if (colIndex.user_id === -1 || colIndex.name === -1) {
		return Response.json({ error: 'CSVヘッダに user_id, name が必要です' }, { status: 400 });
	}

	const dataRows = rows.slice(1);
	if (dataRows.length === 0) {
		return Response.json({ error: 'データ行がありません' }, { status: 400 });
	}

	const { results: existing } = await env.DB.prepare('SELECT user_id, passphrase FROM users').all<{
		user_id: string;
		passphrase: string;
	}>();
	const existingPassphrase = new Map(existing.map((u) => [u.user_id, u.passphrase]));

	const statements = [];
	for (const [i, r] of dataRows.entries()) {
		const lineNo = i + 2; // ヘッダ行ぶん+1、1始まりで+1
		const userId = (r[colIndex.user_id] ?? '').trim();
		const name = (r[colIndex.name] ?? '').trim();
		if (!userId || !name) {
			return Response.json({ error: `${lineNo}行目: user_id, name は必須です` }, { status: 400 });
		}

		const roleRaw = colIndex.role !== -1 ? (r[colIndex.role] ?? '').trim() : '';
		const role = roleRaw === '管理者' ? '管理者' : '一般';

		const activeRaw = colIndex.active !== -1 ? (r[colIndex.active] ?? '').trim() : '1';
		const active = activeRaw === '0' || activeRaw.toLowerCase() === 'false' ? 0 : 1;

		const passphraseInput = colIndex.passphrase !== -1 ? (r[colIndex.passphrase] ?? '').trim() : '';
		const passphrase = passphraseInput || existingPassphrase.get(userId);
		if (!passphrase) {
			return Response.json(
				{ error: `${lineNo}行目: 新規ユーザー(${userId})には passphrase が必要です` },
				{ status: 400 },
			);
		}

		statements.push(
			env.DB.prepare(
				`INSERT INTO users (user_id, name, passphrase, role, active)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET
				   name = excluded.name, passphrase = excluded.passphrase,
				   role = excluded.role, active = excluded.active`,
			).bind(userId, name, passphrase, role, active),
		);
	}
	await env.DB.batch(statements);

	return Response.json({ imported: statements.length });
}
