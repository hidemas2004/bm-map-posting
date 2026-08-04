import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WRANGLER_JSONC_PATH = path.join(REPO_ROOT, 'wrangler.jsonc');

/**
 * JSONCの `//` 行コメントを取り除いてJSON.parseする（読み取り専用の検証・参照用）。
 * 本リポジトリのwrangler.jsoncは「コメントは必ず行頭からの行コメント」という前提で書かれており、
 * この関数・本ファイルの編集処理も同じ前提に依存する（文字列内の `//` や末尾コメントには非対応）。
 */
function stripLineComments(text) {
	return text
		.split('\n')
		.map((line) => (line.trim().startsWith('//') ? '' : line))
		.join('\n');
}

export function readWranglerConfig() {
	const text = readFileSync(WRANGLER_JSONC_PATH, 'utf8');
	return JSON.parse(stripLineComments(text));
}

export function envExists(regionId) {
	const config = readWranglerConfig();
	return Boolean(config.env && config.env[regionId]);
}

export function listRegionEnvs() {
	const config = readWranglerConfig();
	return Object.keys(config.env ?? {});
}

/** text[openIndex] が '{' である前提で、対応する '}' の位置を返す（文字列・行コメント内は無視）。 */
function findMatchingBrace(text, openIndex) {
	let depth = 0;
	let inString = false;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			const nextNewline = text.indexOf('\n', i);
			i = nextNewline === -1 ? text.length : nextNewline;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	throw new Error('wrangler.jsonc: 対応する閉じ括弧が見つかりません（ファイルが壊れている可能性）');
}

/**
 * closeBraceIndex（あるオブジェクトの '}' の位置）の直前に新しい行群を挿入できるよう、
 * 直前の「実内容がある最後の行」を探してカンマの有無を補正する。
 * 末尾のコメント専用行・空行はそのまま保持し、その手前に挿入する。
 */
function insertBeforeClose(text, closeBraceIndex, newLines, indent) {
	const before = text.slice(0, closeBraceIndex);
	const after = text.slice(closeBraceIndex);
	const lines = before.split('\n');

	let lastContentIdx = lines.length - 1;
	while (lastContentIdx >= 0) {
		const trimmed = lines[lastContentIdx].trim();
		if (trimmed === '' || trimmed.startsWith('//')) {
			lastContentIdx--;
			continue;
		}
		break;
	}

	const insertion = newLines.map((l) => indent + l).join('\n');

	if (lastContentIdx < 0) {
		// 中身が空のオブジェクト
		return `${lines.join('\n')}${insertion}\n${indent.slice(0, -2)}${after}`;
	}

	const contentLine = lines[lastContentIdx];
	const trimmedEnd = contentLine.trimEnd();
	const needsComma = !trimmedEnd.endsWith(',') && !trimmedEnd.endsWith('{') && !trimmedEnd.endsWith('[');
	if (needsComma) {
		lines[lastContentIdx] = `${trimmedEnd},`;
	}

	const headLines = lines.slice(0, lastContentIdx + 1);
	const tailLines = lines.slice(lastContentIdx + 1); // 末尾コメント行・空行（そのまま維持）

	return [...headLines, insertion, ...tailLines].join('\n') + after;
}

/**
 * wrangler.jsonc に env.<regionId> ブロックを追記する。
 * 既存の内容・コメントの書き換えは一切行わず、追記のみ行う。書き込み前に構文検証する。
 */
export function appendEnvBlock(regionId, { workerName, d1DatabaseName, databaseId }) {
	if (envExists(regionId)) {
		throw new Error(`env.${regionId} は既にwrangler.jsoncに存在します`);
	}

	const text = readFileSync(WRANGLER_JSONC_PATH, 'utf8');
	const config = readWranglerConfig(); // 壊れたJSONCならここで先に気づける

	const entryLines = [
		`"${regionId}": {`,
		`  "name": "${workerName}",`,
		`  "d1_databases": [`,
		`    {`,
		`      "binding": "DB",`,
		`      "database_name": "${d1DatabaseName}",`,
		`      "database_id": "${databaseId}"`,
		`    }`,
		`  ]`,
		`}`,
	];

	let newText;
	if (config.env) {
		const envKeyIdx = text.indexOf('"env"');
		if (envKeyIdx === -1) throw new Error('wrangler.jsonc: "env"キーの位置特定に失敗しました');
		const envOpenBrace = text.indexOf('{', envKeyIdx);
		const envCloseBrace = findMatchingBrace(text, envOpenBrace);
		newText = insertBeforeClose(text, envCloseBrace, entryLines, '    ');
	} else {
		const rootOpenBrace = text.indexOf('{');
		const rootCloseBrace = findMatchingBrace(text, rootOpenBrace);
		const envBlockLines = ['"env": {', ...entryLines.map((l) => '  ' + l), '}'];
		newText = insertBeforeClose(text, rootCloseBrace, envBlockLines, '  ');
	}

	JSON.parse(stripLineComments(newText)); // 安全弁: 構文が壊れていたらここで例外
	writeFileSync(WRANGLER_JSONC_PATH, newText);
}
