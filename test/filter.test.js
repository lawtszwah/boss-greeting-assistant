// 卡片筛选规则。岗位与公司名均为虚构。薪资由平台原生筛选负责，不在卡片层复核。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJob, normalizeJobUrl, classifyTags, SKIP } from '../src/core/filter.js';
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

test('经验和学历：不限取值通过；卡片没有对应标签时放行（已由平台筛选负责）', async () => {
  assert.equal(evaluateJob(baseJob, cfg({ experiences: ['1-3年'] })).code, SKIP.EXPERIENCE_MISMATCH);
  assert.equal(evaluateJob({ ...baseJob, experience: '经验不限' }, cfg({ experiences: ['1-3年'] })).pass, true);
  assert.equal(evaluateJob({ ...baseJob, experience: '' }, cfg({ experiences: ['1-3年'] })).pass, true);
  assert.equal(evaluateJob({ ...baseJob, degree: undefined }, cfg({ degrees: ['本科'] })).pass, true);
  assert.equal(evaluateJob({ ...baseJob, degree: '硕士' }, cfg({ degrees: ['本科'] })).code, SKIP.DEGREE_MISMATCH);
  assert.equal(evaluateJob({ ...baseJob, degree: '学历不限' }, cfg({ degrees: ['本科'] })).pass, true);
});

test('应届生、在校生接受卡片上的「在校/应届」', () => {
  for (const want of ['应届生', '在校生']) {
    assert.equal(evaluateJob({ ...baseJob, experience: '在校/应届' }, cfg({ experiences: [want] })).pass, true, want);
  }
  assert.equal(evaluateJob({ ...baseJob, experience: '在校/应届' }, cfg({ experiences: ['1年以内'] })).code, SKIP.EXPERIENCE_MISMATCH);
  assert.equal(evaluateJob({ ...baseJob, experience: '1-3年' }, cfg({ experiences: ['应届生'] })).code, SKIP.EXPERIENCE_MISMATCH);
});

test('按内容识别卡片标签，不依赖顺序', () => {
  assert.deepEqual(classifyTags(['3-5年', '本科']), { experience: '3-5年', degree: '本科' });
  assert.deepEqual(classifyTags(['在校/应届', '学历不限']), { experience: '在校/应届', degree: '学历不限' });
  // 实习卡片：天/周、实习月数、学历，没有经验标签。
  assert.deepEqual(classifyTags(['5天/周', '3个月', '本科']), { experience: '', degree: '本科' });
  assert.deepEqual(classifyTags(['6天/周', '6个月', '中专/中技']), { experience: '', degree: '中专/中技' });
  assert.deepEqual(classifyTags(['1年以内', '大专']), { experience: '1年以内', degree: '大专' });
  assert.deepEqual(classifyTags(['10年以上', '硕士']), { experience: '10年以上', degree: '硕士' });
  assert.deepEqual(classifyTags(['React', 'TypeScript']), { experience: '', degree: '' });
});

test('岗位链接去除跟踪参数', () => {
  assert.equal(normalizeJobUrl('https://example.com/job/abc.html?ka=search&lid=1#x'), 'https://example.com/job/abc.html');
  assert.equal(normalizeJobUrl('not a url'), null);
});
