/**
 * npx等の.cmd/.batラッパーはWindowsでexecFileSyncから直接起動できない（EINVAL/ENOENT）ため、
 * Windowsではshell経由の起動が必要。ただしshell:trueに配列argsをそのまま渡すと引数がエスケープ
 * されずNode.jsのDEP0190非推奨警告（コマンドインジェクションの温床になりうる）が出るため、
 * Windowsでは自前でcmd.exe向けにクォートした単一コマンド文字列をexecSyncへ渡す。
 * Windows以外（macOS/Linux）はshellを介さずexecFileSyncをそのまま使う。
 */
import { execFileSync, execSync } from 'node:child_process';

/** 英数字・.,:\/=-_ のみで構成される引数はcmd.exe上でも無加工で安全なため、そのまま渡す
 *  （npx.cmd自身のようなコマンド名をダブルクォートで囲むと、内部の%~dp0展開に失敗し
 *  誤ったモジュール解決になる不具合が確認されたため、必要な引数だけを最小限クォートする）。
 *  それ以外（空白・特殊文字を含む値）はダブルクォートで囲み内部の"を""にエスケープする。 */
function quoteForWindowsShellIfNeeded(arg) {
	const s = String(arg);
	if (/^[\w.,:\\/=-]+$/.test(s)) return s;
	return `"${s.replace(/"/g, '""')}"`;
}

/** execFileSyncと同じ呼び出し感覚（cmd, args, options）で、Windowsでも余計な警告無しに
 *  .cmd/.batラッパーを実行できる。optionsのinput/stdio等はexecSync/execFileSyncにそのまま渡る。 */
export function execCommand(cmd, args, options = {}) {
	if (process.platform === 'win32') {
		const command = [cmd, ...args.map(quoteForWindowsShellIfNeeded)].join(' ');
		return execSync(command, options);
	}
	return execFileSync(cmd, args, options);
}
