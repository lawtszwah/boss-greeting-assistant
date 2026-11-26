import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, snapshotConfig, randomDelayMs, DEFAULT_CONFIG } from '../src/core/config.js';

const fields = (r) => r.errors.map((e) => e.field);

test('默认值与关键词规范化', () => {
  const r = validateConfig({ keywords: ['  前端 ', '前端', 'React', 'react', ''] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.keywords, ['前端', 'React']);
  assert.equal(r.config.sessionLimit, DEFAULT_CONFIG.sessionLimit);
  assert.equal(r.config.dailyLimit, 30);
  assert.deepEqual(r.config.sendIntervalSec, { min: 15, max: 30 });
  assert.equal(r.config.salaryBucket, null);
});

test('空关键词与超过 10 个关键词', () => {
  assert.deepEqual(fields(validateConfig({ keywords: [' '] })), ['keywords']);
  const many = Array.from({ length: 11 }, (_, i) => `k${i}`);
  assert.deepEqual(fields(validateConfig({ keywords: many })), ['keywords']);
});

test('薪资只能选平台档位', () => {
  assert.equal(validateConfig({ keywords: ['a'], salaryBucket: 405 }).config.salaryBucket, '405');
  assert.equal(validateConfig({ keywords: ['a'], salaryBucket: '' }).config.salaryBucket, null);
  assert.deepEqual(fields(validateConfig({ keywords: ['a'], salaryBucket: '999' })), ['salaryBucket']);
});

test('额度越界', () => {
  const r = validateConfig({ keywords: ['a'], sessionLimit: 0, dailyLimit: 31, maxBatchesPerKeyword: 2.5 });
  assert.deepEqual(fields(r).sort(), ['dailyLimit', 'maxBatchesPerKeyword', 'sessionLimit']);
});

test('间隔校验', () => {
  assert.deepEqual(fields(validateConfig({ keywords: ['a'], sendIntervalSec: { min: 10, max: 30 } })), ['sendIntervalSec']);
  assert.deepEqual(fields(validateConfig({ keywords: ['a'], sendIntervalSec: { min: 20, max: 18 } })), ['sendIntervalSec']);
  assert.deepEqual(fields(validateConfig({ keywords: ['a'], actionIntervalSec: { min: 2, max: 8 } })), ['actionIntervalSec']);
  assert.equal(validateConfig({ keywords: ['a'], sendIntervalSec: { min: 15, max: 15 } }).ok, true);
});

test('配置快照不可修改且与原配置隔离', () => {
  const { config } = validateConfig({ keywords: ['a'] });
  const snap = snapshotConfig(config);
  config.keywords.push('b');
  assert.deepEqual(snap.keywords, ['a']);
  assert.throws(() => { snap.keywords.push('c'); });
});

test('随机等待落在区间内', () => {
  assert.equal(randomDelayMs({ min: 15, max: 30 }, () => 0), 15000);
  assert.equal(randomDelayMs({ min: 15, max: 30 }, () => 1), 30000);
});
