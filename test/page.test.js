// 页面适配层：读取、筛选核验、阻断检测、滚动加载、点击与成功判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchPage, fakeJob, greetSuccess, greetNothing, greetLimit, greetWrongTarget } from './fixtures/search-page.js';
import { readCards, readDetail, verifyFilterState, detectBlocker, listStatus, jobIdFromHref } from '../src/page/reader.js';
import { selectCard, loadNextBatch, clickChatAndAwait, dismissGreetDialog } from '../src/page/actions.js';
import { buildSearchUrl, verifySearchUrl, filterParams } from '../src/page/search-url.js';
import { validateConfig } from '../src/core/config.js';

const cfg = (over = {}) => validateConfig({ keywords: ['前端'], ...over }).config;

test('构造搜索 URL：关键词、城市与平台筛选代码', () => {
  const url = buildSearchUrl({
    keyword: '前端 React',
    cityCode: '101010100',
    config: cfg({ salaryBucket: '405', experiences: ['3-5年'], degrees: ['本科'], jobTypes: ['全职'] }),
  });
  const u = new URL(url);
  assert.equal(u.pathname, '/web/geek/jobs');
  assert.equal(u.searchParams.get('query'), '前端 React');
  assert.deepEqual(
    Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'query')),
    { city: '101010100', jobType: '1901', salary: '405', experience: '105', degree: '203' },
  );
  assert.throws(() => buildSearchUrl({ keyword: 'a', cityCode: '', config: cfg() }), /cityCode/);
});

test('配置限制每类筛选只选一个平台取值', () => {
  assert.deepEqual(validateConfig({ keywords: ['a'], experiences: ['1-3年', '3-5年'] }).errors.map((e) => e.field), ['experiences']);
  assert.deepEqual(validateConfig({ keywords: ['a'], degrees: ['博士后'] }).errors.map((e) => e.field), ['degrees']);
  assert.deepEqual(filterParams(cfg()), {});
});

test('核验 URL：城市被改、关键词不同、多出筛选都算不一致', () => {
  const expected = buildSearchUrl({ keyword: '前端', cityCode: '101010100', config: cfg({ salaryBucket: '405' }) });
  assert.equal(verifySearchUrl(expected, expected).ok, true);
  const changedCity = expected.replace('city=101010100', 'city=101280100');
  assert.deepEqual(verifySearchUrl(changedCity, expected).mismatches.map((m) => m.key), ['city']);
  const extra = `${expected}&degree=203`;
  assert.deepEqual(verifySearchUrl(extra, expected).mismatches.map((m) => m.key), ['degree']);
  const otherQuery = expected.replace(/query=[^&]+/, 'query=Java');
  assert.deepEqual(verifySearchUrl(otherQuery, expected).mismatches.map((m) => m.key), ['query']);
});

test('读取卡片：岗位 ID、链接、标题、公司、经验和学历；不读薪资', () => {
  const { doc } = createSearchPage({ jobs: [fakeJob(1), fakeJob(2, { degree: '大专' })] });
  const cards = readCards(doc);
  assert.equal(cards.length, 2);
  assert.deepEqual(
    { jobId: cards[1].jobId, url: cards[1].url, title: cards[1].title, company: cards[1].company, experience: cards[1].experience, degree: cards[1].degree },
    { jobId: 'fake0002', url: 'https://www.zhipin.com/job_detail/fake0002.html', title: '前端工程师2', company: '示例公司2', experience: '3-5年', degree: '大专' },
  );
  assert.equal('salaryText' in cards[0], false);
  // 实习卡片：标签为「天/周、月数、学历」。
  const intern = readCards(createSearchPage({ jobs: [fakeJob(3, { experience: '5天/周', degree: '3个月' })] }).doc)[0];
  assert.equal(intern.experience, '');
  assert.equal(intern.degree, '');
  assert.equal(jobIdFromHref('/job_detail/a~b_c-1.html?ka=1'), 'a~b_c-1');
  assert.equal(jobIdFromHref('/gongsi/x.html'), null);
});

test('筛选框显示核验（AC-03）', () => {
  const { doc } = createSearchPage({ selected: { salary: true } });
  assert.equal(verifyFilterState(doc, { salary: '405' }).ok, true);
  assert.deepEqual(verifyFilterState(doc, { salary: '405', degree: '203' }).problems, [{ kind: 'degree', expected: 'selected', actual: 'none' }]);
  assert.deepEqual(verifyFilterState(doc, {}).problems, [{ kind: 'salary', expected: 'none', actual: 'selected' }]);
});

test('阻断检测：隐藏模板不算，验证码、限制和未知弹窗算（AC-15、AC-17）', () => {
  assert.equal(detectBlocker(createSearchPage().doc), null);
  const captcha = createSearchPage({ extraHtml: '<div class="dialog-wrap">请完成安全验证</div>' }).doc;
  assert.equal(detectBlocker(captcha).kind, 'captcha');
  const limit = createSearchPage({ extraHtml: '<div class="dialog-wrap"><p>今日沟通人数已达上限</p></div>' }).doc;
  assert.equal(detectBlocker(limit).kind, 'limit');
  const unknown = createSearchPage({ extraHtml: '<div class="modal-box">发现新版本，立即体验</div>' }).doc;
  assert.equal(detectBlocker(unknown).kind, 'unknown_dialog');
  const verifyPage = createSearchPage({ url: 'https://www.zhipin.com/web/user/safe/verify-slider' }).doc;
  assert.equal(detectBlocker(verifyPage).kind, 'captcha');
});

test('列表状态', () => {
  assert.equal(listStatus(createSearchPage({ jobs: [fakeJob(1)] }).doc), 'ready');
  assert.equal(listStatus(createSearchPage({ jobs: [] }).doc), 'empty');
  // 真实无结果页：没有列表容器，只有「没有找到相关职位」。
  assert.equal(listStatus(createSearchPage({ emptyResult: true }).doc), 'empty');
});

test('选中卡片后详情区切换到该岗位', async () => {
  const { doc } = createSearchPage({ jobs: [fakeJob(1), fakeJob(2)] });
  const [, second] = readCards(doc);
  const d = await selectCard(doc, second, { timeoutMs: 1000 });
  assert.equal(d.jobId, 'fake0002');
  assert.equal(d.button.idle, true);
});

test('滚动加载：新增批次、到底、无变化（AC-16）', async () => {
  const page = createSearchPage({ jobs: [fakeJob(1)], moreBatches: [[fakeJob(2), fakeJob(3)]] });
  assert.deepEqual(await loadNextBatch(page.doc, { timeoutMs: 1000 }), { status: 'loaded', newIds: ['fake0002', 'fake0003'] });
  assert.deepEqual(await loadNextBatch(page.doc, { timeoutMs: 200 }), { status: 'end' });

  const stuck = createSearchPage({ jobs: [fakeJob(1)] });
  stuck.window.scrollTo = () => { stuck.doc.querySelector('.loading-wait').style.display = ''; };
  assert.deepEqual(await loadNextBatch(stuck.doc, { timeoutMs: 200 }), { status: 'stalled' });
});

async function ready(onChat) {
  const page = createSearchPage({ jobs: [fakeJob(1)], onChat });
  await selectCard(page.doc, readCards(page.doc)[0], { timeoutMs: 1000 });
  return page;
}

test('AC-06 成功：捕获短暂出现的「已向BOSS发送消息」弹窗', async () => {
  const page = await ready(greetSuccess({ showAfterMs: 40, removeAfterMs: 60 }));
  const r = await clickChatAndAwait(page.doc, { expectedJobId: 'fake0001', timeoutMs: 1000 });
  assert.deepEqual(r, { result: 'success', evidence: 'greet_dialog' });
  assert.deepEqual(page.state.clicks, ['fake0001']);
  assert.equal(await dismissGreetDialog(page.doc, { timeoutMs: 500 }), 'gone');
});

test('弹窗不自动消失时只点「留在此页」', async () => {
  const page = await ready(greetSuccess({ removeAfterMs: 60_000 }));
  await clickChatAndAwait(page.doc, { expectedJobId: 'fake0001', timeoutMs: 1000 });
  assert.equal(await dismissGreetDialog(page.doc, { timeoutMs: 50 }), 'dismissed');
});

test('AC-07/AC-08 无弹窗：待核对，且只点击一次', async () => {
  const page = await ready(greetNothing());
  const r = await clickChatAndAwait(page.doc, { expectedJobId: 'fake0001', timeoutMs: 150 });
  assert.deepEqual(r, { result: 'needs_review', reason: 'no_greet_dialog' });
  assert.equal(page.state.clicks.length, 1);
});

test('点击后出现限制提示：待核对并带阻断类型', async () => {
  const page = await ready(greetLimit());
  const r = await clickChatAndAwait(page.doc, { expectedJobId: 'fake0001', timeoutMs: 1000 });
  assert.equal(r.result, 'needs_review');
  assert.equal(r.blocker.kind, 'limit');
});

test('AC-17 点击后目标岗位变化：不记为成功', async () => {
  const page = await ready(greetWrongTarget());
  const r = await clickChatAndAwait(page.doc, { expectedJobId: 'fake0001', timeoutMs: 1000 });
  assert.deepEqual(r, { result: 'needs_review', reason: 'target_changed_after_click' });
});

test('点击前详情区不是目标岗位：不点击', async () => {
  const page = await ready(greetSuccess());
  const r = await clickChatAndAwait(page.doc, { expectedJobId: 'fake9999', timeoutMs: 200 });
  assert.equal(r.clicked, false);
  assert.equal(page.state.clicks.length, 0);
});

test('按钮已禁用时不点击', async () => {
  const page = await ready(greetSuccess());
  readDetail(page.doc).button.element.classList.add('is-disabled');
  const r = await clickChatAndAwait(page.doc, { expectedJobId: 'fake0001', timeoutMs: 200 });
  assert.equal(r.clicked, false);
  assert.equal(page.state.clicks.length, 0);
});
