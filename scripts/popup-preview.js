// 弹窗预览：用内存存储和虚构数据代替 chrome API，在普通网页中查看界面。
// 打包：npm run preview，然后用静态服务器打开 dist/preview.html。
import { createMemoryStorage } from '../src/core/storage.js';
import { createLedger } from '../src/core/ledger.js';
import { createRunStore } from '../src/core/run-state.js';
import { createSettingsStore, RISK_NOTICE_VERSION } from '../src/core/settings.js';
import { createLogStore } from '../src/core/log-store.js';
import { createApp } from '../src/background/app.js';
import { initPopup } from '../src/popup/popup.js';

const scenario = new URLSearchParams(location.search).get('s') ?? 'running';
const storage = createMemoryStorage();
const ledger = createLedger({ storage });
const runs = createRunStore({ storage });
const logs = createLogStore({ storage });
const settings = createSettingsStore({ storage });
const app = createApp({ storage, ledger, runs, logs });

if (scenario !== 'first') await settings.ackRisk(RISK_NOTICE_VERSION);
if (scenario === 'running' || scenario === 'paused') {
  const config = (await settings.saveConfig({ keywords: ['前端', 'React', 'Vue'], degrees: ['本科'], salaryBucket: '405', sessionLimit: 10 })).config;
  await ledger.acquireLock({ taskId: 'demo', ownerTabId: 1 });
  await runs.start({ taskId: 'demo', ownerTabId: 1, config, cityCode: '101010100' });
  await runs.update('demo', { keywordIndex: 1, batch: 1 });
  for (let i = 1; i <= 4; i++) {
    const job = { jobId: `demo${i}`, title: `前端工程师（示例 ${i}）`, company: `示例科技 ${i}`, url: `https://www.zhipin.com/job_detail/demo${i}.html` };
    const r = await ledger.beginAttempt({ taskId: 'demo', job, sessionLimit: 10, dailyLimit: 30 });
    await ledger.resolveAttempt(r.attemptId, i === 4 ? { result: 'needs_review', error: 'no_greet_dialog' } : { result: 'success', evidence: 'greet_dialog' });
    await logs.append({ kind: i === 4 ? 'needs_review' : 'contacted', ...job, reason: i === 4 ? 'no_greet_dialog' : undefined });
  }
  await runs.bump('demo', 'contacted', 3);
  await runs.bump('demo', 'needsReview', 1);
  await runs.bump('demo', 'skipped', 5);
  await logs.append({ kind: 'skip', title: 'Java 开发（示例）', company: '示例外包', code: 'excluded_company', detail: '外包' });
  if (scenario === 'paused') await runs.finish('demo', 'paused', 'send_unverified');
}

// 预览页没有内容脚本；把弹窗所需的 setInterval 心跳交给真实时钟即可。
setInterval(() => ledger.heartbeat('demo'), 5000);

await initPopup(document, {
  ledger, runs, settings, logs, app,
  getActiveTab: async () => ({ id: 1, url: 'https://www.zhipin.com/web/geek/jobs?city=101010100' }),
  sendToTab: async (_id, msg) => {
    if (msg.type === 'pageInfo') return { isSearchPage: true, cityCode: '101010100', cityName: '北京', blocker: null };
    if (msg.type === 'start') return { ok: true, taskId: 'demo2' };
    return null;
  },
});
