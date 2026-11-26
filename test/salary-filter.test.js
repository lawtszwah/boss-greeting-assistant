// AC-05 薪资边界，以及卡片筛选规则。岗位与公司名均为虚构。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary, matchSalary } from '../src/core/salary.js';
import { evaluateJob, normalizeJobUrl, SKIP } from '../src/core/filter.js';
import { validateConfig } from '../src/core/config.js';

test('解析常见月薪格式', () => {
  assert.deepEqual(parseSalary('15-25K'), { kind: 'monthly', minK: 15, maxK: 25 });
  assert.deepEqual(parseSalary('15K-25K·14薪'), { kind: 'monthly', minK: 15, maxK: 25 });
  assert.deepEqual(parseSalary('18K'), { kind: 'monthly', minK: 18, maxK: 18 });
  assert.deepEqual(parseSalary('1.5-2万'), { kind: 'monthly', minK: 15, maxK: 20 });
  assert.deepEqual(parseSalary('20K以上'), { kind: 'monthly', minK: 20, maxK: Infinity });
});

test('10K以下不解析为固定 10K', () => {
  assert.deepEqual(parseSalary('10K以下'), { kind: 'monthly', minK: 0, maxK: 10 });
  assert.equal(matchSalary('10K以下', 10, 10), 'pass');
  assert.equal(matchSalary('10K以下', 12, null), 'fail');
});

test('面议、日薪、时薪、年薪、无法解析', () => {
  assert.equal(parseSalary('面议').kind, 'unknown');
  assert.equal(parseSalary('200-300元/天').reason, 'not_monthly');
  assert.equal(parseSalary('50元/时').reason, 'not_monthly');
  assert.equal(parseSalary('30-50万/年').reason, 'not_monthly');
  assert.equal(parseSalary('薪资保密').reason, 'unparsable');
  assert.equal(parseSalary('').reason, 'missing');
});

test('区间交集判断', () => {
  assert.equal(matchSalary('15-25K', 20, 30), 'pass');
  assert.equal(matchSalary('15-25K', 26, null), 'fail');
  assert.equal(matchSalary('15-25K', null, 15), 'pass');
  assert.equal(matchSalary('20K以上', null, 19), 'fail');
  assert.equal(matchSalary('20K以上', 50, null), 'pass');
});

test('设置薪资条件时面议与非月薪无法判定；未设置时不排除', () => {
  assert.equal(matchSalary('面议', 10, null), 'undeterminable');
  assert.equal(matchSalary('200元/天', null, 30), 'undeterminable');
  assert.equal(matchSalary('面议', null, null), 'pass');
  assert.equal(matchSalary(undefined, null, null), 'pass');
});

const baseJob = {
  jobId: 'j1',
  title: '高级前端工程师',
  company: '示例科技有限公司',
  salaryText: '20-30K',
  experience: '3-5年',
  degree: '本科',
  tags: ['React', 'TypeScript'],
};
const cfg = (over = {}) => validateConfig({ keywords: ['前端'], ...over }).config;

test('全部条件满足时通过', () => {
  assert.deepEqual(evaluateJob(baseJob, cfg({ salaryMinK: 25, experiences: ['3-5年'], degrees: ['本科'] })), { pass: true });
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

test('薪资不匹配与无法判定', () => {
  assert.equal(evaluateJob(baseJob, cfg({ salaryMinK: 35 })).code, SKIP.SALARY_MISMATCH);
  assert.equal(evaluateJob({ ...baseJob, salaryText: '面议' }, cfg({ salaryMinK: 10 })).code, SKIP.SALARY_UNDETERMINABLE);
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
