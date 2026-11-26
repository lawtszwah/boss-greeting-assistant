// 后台 service worker：持有唯一的 ledger 与 run 存储实例，内容脚本通过消息调用。

import { createChromeStorage } from '../core/storage.js';
import { createLedger } from '../core/ledger.js';
import { createRunStore } from '../core/run-state.js';
import { verifySearchUrl } from '../page/search-url.js';
import { RPC_METHODS } from '../shared/rpc.js';

const storage = createChromeStorage(chrome.storage.local);
const targets = {
  ledger: createLedger({ storage }),
  runs: createRunStore({ storage, urlMatches: (a, e) => verifySearchUrl(a, e).ok }),
};

async function handle(msg, sender) {
  if (msg?.type === 'whoami') return { tabId: sender.tab?.id ?? null };
  if (msg?.type !== 'rpc') throw new Error('unknown message');
  const allowed = RPC_METHODS[msg.target];
  if (!allowed || !allowed.includes(msg.method)) throw new Error(`method not allowed: ${msg.target}.${msg.method}`);
  return targets[msg.target][msg.method](...(msg.args ?? []));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受本扩展内部的消息。
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

// 启动或唤醒时：没有存活锁则把遗留的未定尝试转为待核对，并清理过期日志。
targets.ledger.recoverInterrupted().catch(() => {});
targets.ledger.pruneLogs(30).catch(() => {});
