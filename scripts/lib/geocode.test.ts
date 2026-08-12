import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress } from './geocode.ts';

test('normalizeAddress: 全角数字を半角に変換する', () => {
	assert.equal(normalizeAddress('神奈川県大和市中央４丁目１番１号'), '神奈川県大和市中央4丁目1番1号');
});

test('normalizeAddress: 全角ハイフン類を半角に統一する', () => {
	assert.equal(normalizeAddress('中央４－１－１'), '中央4-1-1');
	assert.equal(normalizeAddress('中央４ー１ー１'), '中央4-1-1');
	assert.equal(normalizeAddress('中央４−１−１'), '中央4-1-1');
});

test('normalizeAddress: 前後の空白をtrimし、連続する空白（全角含む）を1つにまとめる', () => {
	assert.equal(normalizeAddress('  神奈川県　大和市  中央4丁目 '), '神奈川県 大和市 中央4丁目');
});

test('normalizeAddress: 半角のみの住所はそのまま', () => {
	assert.equal(normalizeAddress('神奈川県大和市中央4-1-1'), '神奈川県大和市中央4-1-1');
});
