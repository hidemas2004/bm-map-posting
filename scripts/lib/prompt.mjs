import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

/**
 * `node:readline/promises` の `rl.question()` を素直に使うと、パイプ入力等でstdinが
 * 複数行まとめて届いた場合に、質問側の待受が間に合わずに行が失われてハングすることがある
 * （question()呼び出し前に'line'イベントが発火してしまうケース）。
 * ここでは自前のキューで'line'イベントを取りこぼさないようにしている。
 */
const rl = readline.createInterface({ input: stdin, output: stdout });
const lineQueue = [];
const waiters = [];

rl.on('line', (line) => {
	if (waiters.length > 0) waiters.shift()(line);
	else lineQueue.push(line);
});

function nextLine() {
	if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
	return new Promise((resolve) => waiters.push(resolve));
}

/** 必須テキスト入力。空欄なら再入力を促す。 */
export async function ask(question, { defaultValue } = {}) {
	const suffix = defaultValue ? `（デフォルト: ${defaultValue}）` : '';
	for (;;) {
		stdout.write(`${question}${suffix}: `);
		const answer = (await nextLine()).trim();
		if (answer) return answer;
		if (defaultValue) return defaultValue;
		console.log('  → 空欄にはできません。');
	}
}

/** y/N確認。Enterのみ・空欄はdefaultValueを返す。 */
export async function confirm(question, { defaultValue = false } = {}) {
	const hint = defaultValue ? 'Y/n' : 'y/N';
	stdout.write(`${question} (${hint}): `);
	const answer = (await nextLine()).trim().toLowerCase();
	if (!answer) return defaultValue;
	return answer === 'y' || answer === 'yes';
}

export function closePrompt() {
	rl.close();
}
