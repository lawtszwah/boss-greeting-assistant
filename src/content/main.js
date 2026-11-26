// 内容脚本入口：在搜索页加载时尝试凭导航令牌继续任务，并响应开始、停止指令。

import { createRpcClient } from '../shared/rpc.js';
import { createPageAdapter } from '../page/adapter.js';
import { createTaskRunner } from '../runner/task-runner.js';

const ledger = createRpcClient('ledger');
const runs = createRpcClient('runs');

function makeRunner() {
  return createTaskRunner({
    ledger,
    runs,
    page: createPageAdapter(document),
    navigate: (url) => window.location.assign(url),
    log: (entry) => console.debug('[boss-greeting-assistant]', entry),
  });
}

let tabId = null;
let runner = null;

async function init() {
  ({ tabId } = await chrome.runtime.sendMessage({ type: 'whoami' }));
  runner = makeRunner();
  await runner.resume({ tabId });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !runner) return false;
  if (msg?.type === 'start') {
    runner.start({ config: msg.config, ownerTabId: tabId }).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg?.type === 'stop') {
    runner.stop(msg.taskId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

init().catch((e) => console.error('[boss-greeting-assistant] init failed', e));
