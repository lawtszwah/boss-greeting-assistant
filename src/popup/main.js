// 弹窗入口：把 chrome API 接到 initPopup。
import { createRpcClient } from '../shared/rpc.js';
import { initPopup } from './popup.js';

initPopup(document, {
  ledger: createRpcClient('ledger'),
  runs: createRpcClient('runs'),
  settings: createRpcClient('settings'),
  logs: createRpcClient('logs'),
  app: createRpcClient('app'),
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { id: tab.id, url: tab.url ?? '' } : null;
  },
  sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
}).catch((e) => {
  document.body.textContent = `加载失败：${e?.message ?? e}`;
});
