// 内容脚本入口：在搜索页加载时尝试凭导航令牌继续任务，并响应弹窗的开始、停止和页面信息请求。

import { createRpcClient } from '../shared/rpc.js';
import { createPageAdapter } from '../page/adapter.js';
import { createTaskRunner } from '../runner/task-runner.js';

const ledger = createRpcClient('ledger');
const runs = createRpcClient('runs');
const settings = createRpcClient('settings');
const logs = createRpcClient('logs');
const page = createPageAdapter(document);

let tabId = null;
let currentTaskId = null;

const runner = createTaskRunner({
  ledger,
  runs,
  page,
  // 延后跳转，让「开始」的回复先送达弹窗。
  navigate: (url) => setTimeout(() => window.location.assign(url), 100),
  log: (entry) => {
    if (entry.taskId) currentTaskId = entry.taskId;
    logs.append({ taskId: currentTaskId, ...entry }).catch(() => {});
  },
  isRiskAcknowledged: async () => (await settings.getRiskAck()).acknowledged,
});

async function init() {
  ({ tabId } = await chrome.runtime.sendMessage({ type: 'whoami' }));
  const run = await runs.get();
  if (run?.ownerTabId === tabId) currentTaskId = run.taskId;
  await runner.resume({ tabId });
}

function pageInfo() {
  return {
    isSearchPage: true,
    cityCode: page.cityCode(),
    cityName: page.cityName(),
    blocker: page.detectBlocker(),
    tabId,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'pageInfo') {
    sendResponse(pageInfo());
    return false;
  }
  if (msg?.type === 'start') {
    runner
      .start({ config: msg.config, ownerTabId: tabId })
      .then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.type === 'stop') {
    runner.stop(msg.taskId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  return false;
});

init().catch((e) => console.error('[boss-greeting-assistant] init failed', e));
