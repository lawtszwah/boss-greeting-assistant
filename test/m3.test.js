// M3：设置、风险确认、日志、后台对账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/core/storage.js';
import { createLedger, JOB_STATUS } from '../src/core/ledger.js';
import { createRunStore, RUN_STATUS } from '../src/core/run-state.js';
import { createSettingsStore, RISK_NOTICE_VERSION } from '../src/core/settings.js';
import { createLogStore } from '../src/core/log-store.js';
import { createApp } from '../src/background/app.js';
import { formToConfig, configToForm, reasonText, codeText, summarizeConfig } from '../src/popup/form.js';
import { validateConfig } from '../src/core/config.js';

test('设置：校验通过才保存', async () => {
  const s = createSettingsStore({ storage: createMemoryStorage() });
  assert.equal(await s.getConfig(), null);
  const bad = await s.saveConfig({ keywords: [] });
  assert.equal(bad.ok, false);
  assert.equal(await s.getConfig(), null);
  const good = await s.saveConfig({ keywords: ['前端'], sessionLimit: 5 });
  assert.equal(good.ok, true);
  assert.equal((await s.getConfig()).sessionLimit, 5);
});

test('AC-20 风险确认：版本一致才算确认', async () => {
  const storage = createMemoryStorage();
  const s = createSettingsStore({ storage, now: () => 42 });
  assert.equal((await s.getRiskAck()).acknowledged, false);
  await assert.rejects(s.ackRisk('old'), /版本/);
  await s.ackRisk(RISK_NOTICE_VERSION);
  assert.deepEqual(await s.getRiskAck(), { acknowledged: true, ack: { version: RISK_NOTICE_VERSION, at: 42 }, version: RISK_NOTICE_VERSION });
  await storage.set({ riskAck: { version: '2000-01-01', at: 1 } });
  assert.equal((await s.getRiskAck()).acknowledged, false);
});

test('日志：只保存允许的字段，按数量和天数裁剪', async () => {
  const clock = { t: 0 };
  const logs = createLogStore({ storage: createMemoryStorage(), now: () => clock.t, maxEntries: 3, retentionDays: 1 });
  await logs.append({ kind: 'skip', title: '岗位', element: { big: 'object' }, mismatches: [1, 2] });
  assert.deepEqual(await logs.list(), [{ at: 0, kind: 'skip', title: '岗位' }]);
  for (let i = 0; i < 5; i++) await logs.append({ kind: 'k', jobId: `j${i}` });
  assert.deepEqual((await logs.list()).map((l) => l.jobId), ['j4', 'j3', 'j2']);
  clock.t = 2 * 24 * 60 * 60 * 1000;
  await logs.append({ kind: 'new' });
  assert.deepEqual((await logs.list()).map((l) => l.kind), ['new']);
});

function backend() {
  const storage = createMemoryStorage();
  const clock = { t: Date.UTC(2026, 10, 27, 1) };
  const ledger = createLedger({ storage, now: () => clock.t, timeZone: () => 'Australia/Brisbane' });
  const runs = createRunStore({ storage, now: () => clock.t });
  const logs = createLogStore({ storage, now: () => clock.t });
  return { storage, clock, ledger, runs, logs, app: createApp({ storage, ledger, runs, logs }) };
}

test('AC-09/AC-13 对账：页面关闭后锁过期，任务标为中断、未定尝试转为待核对', async () => {
  const b = backend();
  await b.ledger.acquireLock({ taskId: 't', ownerTabId: 1 });
  await b.runs.start({ taskId: 't', ownerTabId: 1, config: { keywords: ['a'] }, cityCode: '1' });
  await b.ledger.beginAttempt({ taskId: 't', job: { jobId: 'j1', title: 'x', company: 'y' }, sessionLimit: 5, dailyLimit: 5 });

  // 锁仍存活：保持运行中。
  let st = await b.app.status();
  assert.equal(st.run.status, RUN_STATUS.RUNNING);
  assert.equal(st.needsReview.length, 0);

  b.clock.t += 31_000;
  st = await b.app.status();
  assert.equal(st.run.status, RUN_STATUS.PAUSED);
  assert.equal(st.run.reason, 'interrupted');
  assert.deepEqual(st.needsReview.map((j) => j.jobId), ['j1']);
  assert.equal(st.quota.dailyUsed, 1);
  assert.equal((await b.logs.list())[0].reason, 'interrupted');
});

test('状态汇总包含已确认未发送列表和存储用量', async () => {
  const b = backend();
  await b.ledger.acquireLock({ taskId: 't', ownerTabId: 1 });
  const r = await b.ledger.beginAttempt({ taskId: 't', job: { jobId: 'j1', title: 'x', company: 'y' }, sessionLimit: 5, dailyLimit: 5 });
  await b.ledger.resolveAttempt(r.attemptId, { result: 'needs_review' });
  await b.ledger.reviewJob('j1', 'not_sent');
  const st = await b.app.status();
  assert.deepEqual(st.confirmedNotSent.map((j) => j.jobId), ['j1']);
  assert.equal(st.run, null);
  assert.ok(st.storage.bytes > 0 && st.storage.quota > st.storage.bytes);
  assert.deepEqual((await b.ledger.listByStatus(JOB_STATUS.CONFIRMED_NOT_SENT)).length, 1);
});

test('表单与配置互转', () => {
  const f = configToForm(null);
  assert.equal(f.sessionLimit, '20');
  const cfg = formToConfig({ ...f, keywords: '前端\nReact， Vue', jobType: '全职', salaryBucket: '405', sessionLimit: 5 });
  const v = validateConfig(cfg);
  assert.equal(v.ok, true);
  assert.deepEqual(v.config.keywords, ['前端', 'React', 'Vue']);
  assert.deepEqual(v.config.jobTypes, ['全职']);
  assert.deepEqual(v.config.experiences, []);
  assert.equal(v.config.salaryBucket, '405');
  assert.deepEqual(configToForm(v.config).keywords, '前端\nReact\nVue');
  assert.equal(reasonText('send_unverified'), '点击后未看到发送成功提示，已转为待核对');
  assert.equal(reasonText('custom_code'), 'custom_code');
  assert.equal(codeText('excluded_company'), '命中排除公司');
  assert.equal(codeText('blocked_captcha'), '出现验证码，请在平台完成验证');
});

test('配置摘要：今日剩余额度限制本次最多发送数', () => {
  const { config } = validateConfig({ keywords: ['前端'], sessionLimit: 5, dailyLimit: 6, salaryBucket: '405', degrees: ['本科'] });
  const rows = Object.fromEntries(summarizeConfig(config, { cityName: '深圳', cityCode: '101280600', dailyUsed: 4 }));
  assert.equal(rows['本次最多发送'], '2 条（本次上限 5，今日还剩 2）');
  assert.equal(rows['平台筛选'], '薪资 10-20K，学历 本科');
  assert.equal(rows['排除关键词'], '无');
  assert.equal(rows['城市'], '深圳（101280600）');
});
