import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './concurrency.ts';

test('mapWithConcurrency: 結果の順序が入力順と一致する', async () => {
	const items = [50, 10, 30, 5, 40];
	const results = await mapWithConcurrency(items, 2, async (ms) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return ms;
	});
	assert.deepEqual(results, items);
});

test('mapWithConcurrency: 同時実行数がlimitを超えない', async () => {
	let active = 0;
	let maxActive = 0;
	const items = Array.from({ length: 10 }, (_, i) => i);
	await mapWithConcurrency(items, 3, async (i) => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return i;
	});
	assert.ok(maxActive <= 3, `expected maxActive <= 3, got ${maxActive}`);
});

test('mapWithConcurrency: 空配列はそのまま空配列を返す', async () => {
	const results = await mapWithConcurrency([] as number[], 5, async (i) => i);
	assert.deepEqual(results, []);
});
