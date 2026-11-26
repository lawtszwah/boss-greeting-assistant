// 任务执行器端到端测试：模拟页面 + 真实 ledger/run 存储。覆盖 M2 验收重点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchPage, fakeJob, greetSuccess, greetNothing, greetLimit } from './fixtures/search-page.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { createLedger } from '../src/core/ledger.js';
import { createRunStore, RUN_STATUS } from '../src/core/run-state.js';
import { createPageAdapter } from '../src/page/adapter.js';
import { createTaskRunner, PAUSE } from '../src/runner/task-runner.js';
import { verifySearchUrl } from '../src/page/search-url.js';

const FAST = { list: 300, select: 300, greet: 300, batch: 200, dismiss: 300 };
const START_URL = 'https://www.zhipin.com/web/geek/jobs?city=101010100';

/**
 * 模拟一个标签页：start → 每次 navigate 后按新 URL 生成页面并 resume，直到不再导航。
 * @param {object} o
 * @param {Record<string, object[]>} o.jobsByKeyword
 * @param {Record<string, object[][]>} [o.moreByKeyword]
 * @param {(url: URL) => object} [o.pageOptions] 覆盖某个 URL 下的页面行为
 */
async function simulate(o) {
  const storage = o.storage ?? createMemoryStorage();
  const clock = { t: Date.UTC(2026, 10, 27, 1) };
  const ledger = o.ledger ?? createLedger({ storage, now: () => clock.t, timeZone: () => 'Australia/Brisbane' });
  const runs = createRunStore({ storage, now: () => clock.t, urlMatches: (a, e) => verifySearchUrl(a, e).ok });
  const logs = [];
  const clicks = [];
  const visited = [];
  let pendingUrl = null;

  const makePage = (url) => {
    const u = new URL(url);
    const keyword = u.searchParams.get('query');
    const selected = {
      jobType: u.searchParams.has('jobType'),
      salary: u.searchParams.has('salary'),
      experience: u.searchParams.has('experience'),
      degree: u.searchParams.has('degree'),
    };
    const page = createSearchPage({
      url,
      jobs: o.jobsByKeyword?.[keyword] ?? [],
      moreBatches: o.moreByKeyword?.[keyword] ?? [],
      selected,
      onChat: o.onChat ?? greetSuccess({ showAfterMs: 10, removeAfterMs: 30 }),
      ...(o.pageOptions?.(u) ?? {}),
    });
    const origClick = page.state.clicks;
    page.state.clicks = { push: (id) => { clicks.push(id); origClick.push(id); } };
    if (o.stall) page.window.scrollTo = () => { page.doc.querySelector('.loading-wait').style.display = ''; };
    return page;
  };

  const runnerFor = (page) =>
    createTaskRunner({
      ledger: o.wrapLedger ? o.wrapLedger(ledger, runs) : ledger,
      runs,
      page: createPageAdapter(page.doc, FAST),
      navigate: (url) => { pendingUrl = url; },
      sleep: o.sleep ? (ms) => o.sleep(ms, { runs, ledger }) : async () => {},
      random: () => 0,
      log: (e) => logs.push(e),
      heartbeatMs: 0,
      ...(o.isRiskAcknowledged ? { isRiskAcknowledged: o.isRiskAcknowledged } : {}),
    });

  const startPage = makePage(o.startUrl ?? START_URL);
  const started = await runnerFor(startPage).start({ config: { keywords: ['前端'], ...o.config }, ownerTabId: 7 });
  let last = null;
  for (let hops = 0; started.ok && pendingUrl && hops < 20; hops++) {
    const url = o.redirect ? o.redirect(pendingUrl) : pendingUrl;
    pendingUrl = null;
    visited.push(url);
    last = await runnerFor(makePage(url)).resume({ tabId: 7 });
  }
  const run = await runs.get();
  return { started, last, run, logs, clicks, visited, ledger, runs, storage, clock, makePage, runnerFor };
}

const kw = (url) => new URL(url).searchParams.get('query');

test('AC-01 多关键词分别搜索，跨词重复岗位只处理一次', async () => {
  const shared = fakeJob(9);
  const r = await simulate({
    config: { keywords: ['前端', 'React', 'Vue'] },
    jobsByKeyword: {
      前端: [fakeJob(1), shared],
      React: [shared, fakeJob(2, { title: 'React 前端' })],
      Vue: [fakeJob(3, { title: 'Vue 前端' })],
    },
  });
  assert.deepEqual(r.visited.map(kw), ['前端', 'React', 'Vue']);
  assert.deepEqual(r.clicks, ['fake0001', 'fake0009', 'fake0002', 'fake0003']);
  assert.equal(r.run.status, RUN_STATUS.COMPLETED);
  assert.equal(r.run.counts.contacted, 4);
});

test('经验设为应届生：卡片显示「在校/应届」或实习卡片没有经验标签时都会处理', async () => {
  const r = await simulate({
    config: { keywords: ['前端'], experiences: ['应届生'] },
    jobsByKeyword: {
      前端: [
        fakeJob(1, { experience: '在校/应届' }),
        fakeJob(2, { experience: '5天/周', degree: '3个月' }),
        fakeJob(3, { experience: '3-5年' }),
      ],
    },
  });
  assert.deepEqual(r.clicks, ['fake0001', 'fake0002']);
  assert.equal(r.run.counts.skipped, 1);
});

test('关键词复核和排除项：不点击', async () => {
  const r = await simulate({
    config: { keywords: ['前端'], excludeCompanies: ['外包'] },
    jobsByKeyword: { 前端: [fakeJob(1, { company: '某某外包' }), fakeJob(2, { title: 'Java 工程师' }), fakeJob(3)] },
  });
  assert.deepEqual(r.clicks, ['fake0003']);
  assert.equal(r.run.counts.skipped, 2);
});

test('AC-02 页面未切换到新关键词：不使用旧列表发送', async () => {
  const r = await simulate({
    config: { keywords: ['前端', 'React'] },
    jobsByKeyword: { 前端: [fakeJob(1)], React: [fakeJob(2, { title: 'React' })] },
    // 第二次导航后页面仍停留在上一个关键词。
    redirect: (url) => (kw(url) === 'React' ? url.replace(/query=[^&]+/, 'query=%E5%89%8D%E7%AB%AF') : url),
  });
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.equal(r.run.status, RUN_STATUS.PAUSED);
  assert.equal(r.run.reason, 'unexpected_url');
});

test('搜索后城市被改：暂停且不发送', async () => {
  const r = await simulate({
    jobsByKeyword: { 前端: [fakeJob(1)] },
    redirect: (url) => url.replace('city=101010100', 'city=101280100'),
  });
  assert.deepEqual(r.clicks, []);
  assert.equal(r.run.reason, 'unexpected_url');
});

test('AC-03 筛选未生效：暂停并指出条件，不发送', async () => {
  const r = await simulate({
    config: { keywords: ['前端'], degrees: ['本科'] },
    jobsByKeyword: { 前端: [fakeJob(1)] },
    pageOptions: () => ({ selected: {} }),
  });
  assert.deepEqual(r.clicks, []);
  assert.equal(r.run.reason, PAUSE.FILTER_MISMATCH);
  assert.deepEqual(r.logs.find((l) => l.kind === 'filter_mismatch').problems, [{ kind: 'degree', expected: 'selected', actual: 'none' }]);
});

test('AC-07/AC-08 无成功弹窗：待核对、暂停、不重发', async () => {
  const r = await simulate({ jobsByKeyword: { 前端: [fakeJob(1), fakeJob(2)] }, onChat: greetNothing() });
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.equal(r.run.reason, PAUSE.SEND_UNVERIFIED);
  assert.equal(r.run.counts.needsReview, 1);
  assert.deepEqual((await r.ledger.listNeedsReview()).map((j) => j.jobId), ['fake0001']);
  assert.equal((await r.ledger.quotaStatus(r.run.taskId)).dailyUsed, 1);
});

test('平台提示沟通上限：记为失败并暂停', async () => {
  const r = await simulate({ jobsByKeyword: { 前端: [fakeJob(1), fakeJob(2)] }, onChat: greetLimit() });
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.equal(r.run.reason, PAUSE.PLATFORM_LIMIT);
  assert.equal(r.run.counts.failed, 1);
});

test('AC-11 本次额度用完后正常结束', async () => {
  const r = await simulate({
    config: { keywords: ['前端'], sessionLimit: 2 },
    jobsByKeyword: { 前端: [fakeJob(1), fakeJob(2), fakeJob(3)] },
  });
  assert.deepEqual(r.clicks, ['fake0001', 'fake0002']);
  assert.equal(r.run.status, RUN_STATUS.COMPLETED);
  assert.equal(r.run.reason, 'session_limit_reached');
});

test('AC-10 已沟通岗位在新任务中跳过', async () => {
  const storage = createMemoryStorage();
  await simulate({ storage, jobsByKeyword: { 前端: [fakeJob(1)] } });
  const r = await simulate({ storage, jobsByKeyword: { 前端: [fakeJob(1), fakeJob(2)] } });
  assert.deepEqual(r.clicks, ['fake0002']);
});

test('AC-12 发送间隔中停止：不再发送', async () => {
  let stopped = false;
  const r = await simulate({
    jobsByKeyword: { 前端: [fakeJob(1), fakeJob(2), fakeJob(3)] },
    sleep: async (ms, { runs }) => {
      if (!stopped) { stopped = true; await runs.requestStop((await runs.get()).taskId); }
    },
  });
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.equal(r.run.status, RUN_STATUS.STOPPED);
});

test('AC-12 记录尝试后、点击前停止：撤销尝试，不点击、不占额度', async () => {
  const r = await simulate({
    jobsByKeyword: { 前端: [fakeJob(1)] },
    wrapLedger: (ledger, runs) => ({
      ...ledger,
      async beginAttempt(args) {
        const res = await ledger.beginAttempt(args);
        await runs.requestStop(args.taskId);
        return res;
      },
    }),
  });
  assert.deepEqual(r.clicks, []);
  assert.equal(r.run.status, RUN_STATUS.STOPPED);
  assert.equal((await r.ledger.quotaStatus(r.run.taskId)).dailyUsed, 0);
  assert.deepEqual(await r.ledger.listNeedsReview(), []);
  assert.equal((await r.ledger.checkEligibility(fakeJobRecord(1), 'later')).eligible, true);
});

function fakeJobRecord(i) {
  const j = fakeJob(i);
  return { jobId: j.id, title: j.title, company: j.company };
}

test('AC-15 验证码：暂停，不发送', async () => {
  const r = await simulate({
    jobsByKeyword: { 前端: [fakeJob(1)] },
    pageOptions: (u) => (u.searchParams.has('query') ? { extraHtml: '<div class="dialog-wrap">请完成安全验证</div>' } : {}),
  });
  assert.deepEqual(r.clicks, []);
  assert.equal(r.run.reason, 'blocked_captcha');
});

test('AC-17 未知弹窗：暂停，不盲点', async () => {
  const r = await simulate({
    jobsByKeyword: { 前端: [fakeJob(1)] },
    pageOptions: (u) => (u.searchParams.has('query') ? { extraHtml: '<div class="modal-box">发现新版本</div>' } : {}),
  });
  assert.deepEqual(r.clicks, []);
  assert.equal(r.run.reason, 'blocked_unknown_dialog');
});

test('AC-16 无结果换关键词；滚动加载批次与批次上限', async () => {
  const r = await simulate({
    config: { keywords: ['前端', 'React'], maxBatchesPerKeyword: 2 },
    jobsByKeyword: { 前端: [], React: [fakeJob(1, { title: 'React' })] },
    moreByKeyword: { React: [[fakeJob(2, { title: 'React' })], [fakeJob(3, { title: 'React' })]] },
  });
  assert.deepEqual(r.clicks, ['fake0001', 'fake0002']);
  assert.equal(r.run.status, RUN_STATUS.COMPLETED);
  assert.ok(r.logs.some((l) => l.kind === 'no_results'));
  assert.ok(r.logs.some((l) => l.kind === 'batch_limit'));
});

test('AC-16 真实无结果页（无列表容器）：换下一个关键词', async () => {
  const r = await simulate({
    config: { keywords: ['前端', 'React'] },
    jobsByKeyword: { React: [fakeJob(1, { title: 'React' })] },
    pageOptions: (u) => (u.searchParams.get('query') === '前端' ? { emptyResult: true } : {}),
  });
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.equal(r.run.status, RUN_STATUS.COMPLETED);
  assert.ok(r.logs.some((l) => l.kind === 'no_results' && l.keyword === '前端'));
});

test('AC-16 滚动加载无进展：暂停', async () => {
  const r = await simulate({ jobsByKeyword: { 前端: [fakeJob(1)] }, stall: true });
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.equal(r.run.reason, PAUSE.LIST_STALLED);
});

test('连续 3 个岗位解析失败：暂停', async () => {
  const r = await simulate({
    jobsByKeyword: { 前端: [fakeJob(1, { company: '' }), fakeJob(2, { company: '' }), fakeJob(3, { company: '' }), fakeJob(4)] },
  });
  assert.deepEqual(r.clicks, []);
  assert.equal(r.run.reason, PAUSE.PARSE_FAILURES);
});

test('AC-19 用户手动刷新：不续发并释放任务锁', async () => {
  const r = await simulate({ config: { keywords: ['前端', 'React'] }, jobsByKeyword: { 前端: [fakeJob(1)] } });
  assert.equal(r.run.status, RUN_STATUS.COMPLETED);

  // 新任务开始后，模拟用户在第一个关键词页面上刷新：页面再次加载但没有令牌。
  const storage = createMemoryStorage();
  const sim = await simulate({ storage, config: { keywords: ['前端'] }, jobsByKeyword: { 前端: [] } });
  const runs = sim.runs;
  await runs.update(sim.run.taskId, { status: RUN_STATUS.RUNNING, nav: null });
  const page = sim.makePage(sim.visited[0]);
  const res = await sim.runnerFor(page).resume({ tabId: 7 });
  assert.equal(res.status, RUN_STATUS.PAUSED);
  assert.equal(res.reason, 'page_reloaded');
  assert.equal((await sim.ledger.acquireLock({ taskId: 'other', ownerTabId: 8 })).acquired, true);
});

test('AC-19 导航令牌过期：不续发', async () => {
  const storage = createMemoryStorage();
  const clock = { t: 0 };
  const runs = createRunStore({ storage, now: () => clock.t, navTtlMs: 1000 });
  await runs.start({ taskId: 't', ownerTabId: 1, config: {}, cityCode: '1' });
  await runs.issueNavToken('t', 'https://x/');
  clock.t = 1500;
  const c = await runs.consumeNavToken({ tabId: 1, url: 'https://x/' });
  assert.equal(c.resumable, false);
  assert.equal(c.run.reason, 'nav_token_expired');
  assert.equal(await runs.consumeNavToken({ tabId: 1, url: 'https://x/' }), null);
});

test('令牌只能由任务所属标签页消费，且只能用一次', async () => {
  const storage = createMemoryStorage();
  const runs = createRunStore({ storage });
  await runs.start({ taskId: 't', ownerTabId: 1, config: {}, cityCode: '1' });
  await runs.issueNavToken('t', 'https://x/');
  assert.equal(await runs.consumeNavToken({ tabId: 2, url: 'https://x/' }), null);
  assert.equal((await runs.consumeNavToken({ tabId: 1, url: 'https://x/' })).resumable, true);
  const again = await runs.consumeNavToken({ tabId: 1, url: 'https://x/' });
  assert.equal(again.resumable, false);
  assert.equal(again.run.reason, 'page_reloaded');
});

test('AC-14 已有任务运行时，另一个标签页不能开始', async () => {
  const storage = createMemoryStorage();
  const ledger = createLedger({ storage });
  await ledger.acquireLock({ taskId: 'running', ownerTabId: 1 });
  const r = await simulate({ storage, ledger, jobsByKeyword: { 前端: [fakeJob(1)] } });
  assert.equal(r.started.ok, false);
  assert.equal(r.started.reason, 'lock_held');
  assert.deepEqual(r.clicks, []);
});

test('开始页面已有验证码时不启动', async () => {
  const r = await simulate({
    jobsByKeyword: {},
    pageOptions: () => ({ extraHtml: '<div class="dialog-wrap">请完成安全验证</div>' }),
  });
  assert.deepEqual(r.started, { ok: false, reason: 'blocked_captcha' });
});

test('上次页面崩溃留下的运行状态不阻止新任务', async () => {
  const storage = createMemoryStorage();
  const stale = createRunStore({ storage });
  await stale.start({ taskId: 'crashed', ownerTabId: 3, config: {}, cityCode: '101010100' });
  const r = await simulate({ storage, jobsByKeyword: { 前端: [fakeJob(1)] } });
  assert.equal(r.started.ok, true);
  assert.deepEqual(r.clicks, ['fake0001']);
  assert.deepEqual(r.run.replaced, { taskId: 'crashed', reason: 'stale' });
});

test('无法确认当前城市时不启动', async () => {
  const r = await simulate({ startUrl: 'https://www.zhipin.com/web/geek/jobs', jobsByKeyword: {} });
  assert.deepEqual(r.started, { ok: false, reason: 'city_unknown' });
});

test('AC-20 未确认风险说明时不启动', async () => {
  const r = await simulate({ jobsByKeyword: { 前端: [fakeJob(1)] }, isRiskAcknowledged: async () => false });
  assert.deepEqual(r.started, { ok: false, reason: 'risk_not_acknowledged' });
  assert.deepEqual(r.clicks, []);
});

test('配置无效时不启动', async () => {
  const r = await simulate({ config: { keywords: [] }, jobsByKeyword: {} });
  assert.equal(r.started.reason, 'invalid_config');
});
