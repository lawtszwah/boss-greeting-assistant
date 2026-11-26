// 弹窗界面：真实 popup.html + 真实后台存储，chrome 标签页 API 用模拟实现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createMemoryStorage } from '../src/core/storage.js';
import { createLedger } from '../src/core/ledger.js';
import { createRunStore } from '../src/core/run-state.js';
import { createSettingsStore, RISK_NOTICE_VERSION } from '../src/core/settings.js';
import { createLogStore } from '../src/core/log-store.js';
import { createApp } from '../src/background/app.js';
import { initPopup } from '../src/popup/popup.js';

const html = (await readFile(new URL('../src/popup/popup.html', import.meta.url), 'utf8')).replace(/<script[^>]*><\/script>/, '');
const SEARCH = 'https://www.zhipin.com/web/geek/jobs?city=101010100';

async function open({ acked = true, tabUrl = SEARCH, pageInfo = { isSearchPage: true, cityCode: '101010100', cityName: '北京', blocker: null }, onStart, backend } = {}) {
  const b = backend ?? (() => {
    const storage = createMemoryStorage();
    const ledger = createLedger({ storage });
    const runs = createRunStore({ storage });
    const logs = createLogStore({ storage });
    return { storage, ledger, runs, logs, settings: createSettingsStore({ storage }), app: createApp({ storage, ledger, runs, logs }) };
  })();
  if (acked) await b.settings.ackRisk(RISK_NOTICE_VERSION);
  const dom = new JSDOM(html, { url: 'chrome-extension://test/popup.html' });
  const doc = dom.window.document;
  const sent = [];
  const api = {
    ...b,
    pollMs: 0,
    getActiveTab: async () => (tabUrl ? { id: 5, url: tabUrl } : null),
    sendToTab: async (id, msg) => {
      sent.push({ id, msg });
      if (msg.type === 'pageInfo') return pageInfo;
      if (msg.type === 'start') return onStart ? onStart(msg, b) : { ok: true, taskId: 't1' };
      return null;
    },
  };
  const popup = await initPopup(doc, api);
  const $ = (id) => doc.getElementById(id);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { b, doc, $, sent, popup, settle, form: $('settings-form'), window: dom.window };
}

test('AC-20 未确认风险时只显示风险说明，确认后显示主界面', async () => {
  const p = await open({ acked: false });
  assert.equal(p.$('risk').hidden, false);
  assert.equal(p.$('app').hidden, true);
  assert.equal(p.$('risk-confirm').disabled, true);
  assert.ok(p.$('risk-list').children.length >= 5);
  p.$('risk-check').click();
  assert.equal(p.$('risk-confirm').disabled, false);
  p.$('risk-confirm').click();
  await p.settle();
  assert.equal(p.$('app').hidden, false);
  assert.equal(p.$('risk').hidden, true);
  assert.equal((await p.b.settings.getRiskAck()).acknowledged, true);
});

test('不在搜索页时提示且开始按钮不可用', async () => {
  const p = await open({ tabUrl: 'https://example.com/' });
  assert.equal(p.$('page-warning').hidden, false);
  assert.match(p.$('page-warning').textContent, /岗位搜索页/);
  assert.equal(p.$('start').disabled, true);
  assert.equal(p.sent.length, 0);
});

test('页面有验证码时提示且开始按钮不可用', async () => {
  const p = await open({ pageInfo: { isSearchPage: true, cityCode: '101010100', cityName: '北京', blocker: { kind: 'captcha' } } });
  assert.match(p.$('page-warning').textContent, /验证码/);
  assert.equal(p.$('start').disabled, true);
});

test('首次打开展开设置并显示默认值、城市和下拉选项', async () => {
  const p = await open();
  assert.equal(p.$('settings').open, true);
  assert.equal(p.form.elements.sessionLimit.value, '20');
  assert.equal(p.$('city').textContent, '北京（101010100）');
  assert.ok([...p.form.elements.salaryBucket.options].some((o) => o.textContent === '10-20K'));
  assert.equal(p.$('start').disabled, false);
});

test('设置有误时显示错误并标红，不发送开始', async () => {
  const p = await open();
  p.form.elements.keywords.value = '';
  p.form.elements.sendIntervalMin.value = '5';
  p.$('start').click();
  await p.settle();
  const errors = [...p.$('form-errors').children].map((li) => li.textContent);
  assert.ok(errors.some((t) => /关键词/.test(t)));
  assert.ok(errors.some((t) => /15 秒/.test(t)));
  assert.ok(p.form.elements.keywords.classList.contains('invalid'));
  assert.equal(p.sent.filter((s) => s.msg.type === 'start').length, 0);
});

test('开始：保存设置并把校验后的配置发给当前标签页', async () => {
  const p = await open();
  p.form.elements.keywords.value = '前端\nReact';
  p.form.elements.degree.value = '本科';
  p.form.elements.sessionLimit.value = '1';
  p.$('start').click();
  await p.settle();
  const start = p.sent.find((s) => s.msg.type === 'start');
  assert.equal(start.id, 5);
  assert.deepEqual(start.msg.config.keywords, ['前端', 'React']);
  assert.deepEqual(start.msg.config.degrees, ['本科']);
  assert.equal(start.msg.config.sessionLimit, 1);
  assert.match(p.$('message').textContent, /任务已开始/);
  assert.equal((await p.b.settings.getConfig()).sessionLimit, 1);
});

test('开始失败时显示原因', async () => {
  const p = await open({ onStart: () => ({ ok: false, reason: 'lock_held' }) });
  p.form.elements.keywords.value = '前端';
  p.$('start').click();
  await p.settle();
  assert.match(p.$('message').textContent, /其他标签页/);
  assert.ok(p.$('message').classList.contains('error'));
});

test('AC-12/AC-13 运行中显示进度和停止按钮；停止写入停止标志', async () => {
  const p0 = await open();
  const b = p0.b;
  await b.ledger.acquireLock({ taskId: 't1', ownerTabId: 5 });
  await b.runs.start({ taskId: 't1', ownerTabId: 5, config: { keywords: ['前端', 'React'], sessionLimit: 3, dailyLimit: 30 }, cityCode: '101010100' });
  await b.runs.update('t1', { keywordIndex: 1, batch: 0 });
  await b.runs.bump('t1', 'contacted', 2);
  // 重新打开弹窗：状态来自存储（AC-13）。
  const p = await open({ backend: b, acked: false });
  assert.equal(p.$('status-pill').textContent, '运行中');
  assert.equal(p.$('start').hidden, true);
  assert.equal(p.$('stop').hidden, false);
  assert.equal(p.$('c-contacted').textContent, '2');
  assert.match(p.$('position').textContent, /关键词 2\/2「React」/);
  p.$('stop').click();
  await p.settle();
  assert.equal((await b.runs.get()).stopRequested, true);
  assert.equal(p.$('status-pill').textContent, '停止中');
  assert.equal(p.$('stop').disabled, true);
});

test('待核对：标记已沟通、确认未发送、重新加入', async () => {
  const p0 = await open();
  const b = p0.b;
  await b.ledger.acquireLock({ taskId: 't', ownerTabId: 1 });
  for (const id of ['j1', 'j2']) {
    const r = await b.ledger.beginAttempt({ taskId: 't', job: { jobId: id, title: `岗位${id}`, company: '公司', url: `https://www.zhipin.com/job_detail/${id}.html` }, sessionLimit: 5, dailyLimit: 5 });
    await b.ledger.resolveAttempt(r.attemptId, { result: 'needs_review' });
  }
  const p = await open({ backend: b, acked: false });
  assert.equal(p.$('review-count').textContent, '2');
  const item = (id) => p.$('review-list').querySelector(`[data-job-id="${id}"]`);
  assert.equal(item('j1').querySelector('a').getAttribute('href'), 'https://www.zhipin.com/job_detail/j1.html');
  assert.equal(item('j1').querySelector('a').getAttribute('rel'), 'noopener noreferrer');

  [...item('j1').querySelectorAll('button')].find((x) => x.textContent === '已沟通').click();
  await p.settle();
  [...item('j2').querySelectorAll('button')].find((x) => x.textContent === '确认未发送').click();
  await p.settle();
  assert.equal(p.$('review-count').textContent, '0');
  assert.equal(p.$('not-sent-section').hidden, false);
  p.$('not-sent-list').querySelector('button').click();
  await p.settle();
  assert.equal((await b.ledger.checkEligibility({ jobId: 'j2' }, 'next')).eligible, true);
  assert.equal((await b.ledger.checkEligibility({ jobId: 'j1' }, 'next')).reason, 'contacted');
});

test('岗位标题和日志以文本渲染，不解析 HTML', async () => {
  const p0 = await open();
  const b = p0.b;
  await b.ledger.acquireLock({ taskId: 't', ownerTabId: 1 });
  const evil = '<img src=x onerror=alert(1)>';
  const r = await b.ledger.beginAttempt({ taskId: 't', job: { jobId: 'j1', title: evil, company: evil }, sessionLimit: 5, dailyLimit: 5 });
  await b.ledger.resolveAttempt(r.attemptId, { result: 'needs_review' });
  await b.logs.append({ kind: 'contacted', title: evil, company: evil });
  const p = await open({ backend: b, acked: false });
  assert.equal(p.doc.querySelectorAll('img').length, 0);
  assert.ok(p.$('review-list').textContent.includes(evil));
  assert.ok(p.$('log-list').textContent.includes(evil));
});
