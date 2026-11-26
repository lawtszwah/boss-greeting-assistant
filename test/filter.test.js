// 卡片筛选规则。岗位与公司名均为虚构。薪资由平台原生筛选负责，不在卡片层复核。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJob, normalizeJobUrl, SKIP } from '../src/core/filter.js';
import { validateConfig } from '../src/core/config.js';

const baseJob = {
  jobId: 'j1',
  title: '高级前端工程师',
  company: '示例科技有限公司',
  experience: '3-5年',
  degree: '本科',
  tags: ['React', 'TypeScript'],
};
const cfg = (over = {}) => validateConfig({ keywords: ['前端'], ...over }).config;

test('全部条件满足时通过', () => {
  assert.deepEqual(evaluateJob(baseJob, cfg({ salaryBucket: '406', experiences: ['3-5年'], degrees: ['本科'] })), { pass: true });
});

test('标题或公司缺失记为解析失败', () => {
  assert.equal(evaluateJob({ ...baseJob, company: ' ' }, cfg()).code, SKIP.PARSE_FAILED);
  assert.equal(evaluateJob({ ...baseJob, title: undefined }, cfg()).code, SKIP.PARSE_FAILED);
});

test('关键词复核：标题或标签命中任一关键词', () => {
  assert.equal(evaluateJob(baseJob, cfg({ keywords: ['typescript'] })).pass, true);
  assert.equal(evaluateJob(baseJob, cfg({ keywords: ['后端', 'Java'] })).code, SKIP.KEYWORD_MISS);
});

test('排除关键词匹配标题、标签和公司，不区分大小写', () => {
  assert.equal(evaluateJob(baseJob, cfg({ excludeKeywords: ['react'] })).code, SKIP.EXCLUDED_KEYWORD);
  assert.equal(evaluateJob(baseJob, cfg({ excludeKeywords: ['示例'] })).code, SKIP.EXCLUDED_KEYWORD);
  assert.equal(evaluateJob(baseJob, cfg({ excludeCompanies: [' 示例科技 '] })).code, SKIP.EXCLUDED_COMPANY);
});

test('经验和学历：不限取值通过，缺失时无法判定', () => {
  assert.equal(evaluateJob(baseJob, cfg({ experiences: ['1-3年'] })).code, SKIP.EXPERIENCE_MISMATCH);
  assert.equal(evaluateJob({ ...baseJob, experience: '经验不限' }, cfg({ experiences: ['1-3年'] })).pass, true);
  assert.equal(evaluateJob({ ...baseJob, experience: '' }, cfg({ experiences: ['1-3年'] })).code, SKIP.EXPERIENCE_UNDETERMINABLE);
  assert.equal(evaluateJob({ ...baseJob, degree: undefined }, cfg({ degrees: ['本科'] })).code, SKIP.DEGREE_UNDETERMINABLE);
  assert.equal(evaluateJob({ ...baseJob, degree: '硕士' }, cfg({ degrees: ['本科'] })).code, SKIP.DEGREE_MISMATCH);
  assert.equal(evaluateJob({ ...baseJob, degree: undefined }, cfg()).pass, true);
});

test('岗位链接去除跟踪参数', () => {
  assert.equal(normalizeJobUrl('https://example.com/job/abc.html?ka=search&lid=1#x'), 'https://example.com/job/abc.html');
  assert.equal(normalizeJobUrl('not a url'), null);
});
