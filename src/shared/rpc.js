// 内容脚本、弹窗与后台之间的 RPC。只开放列出的方法。

export const RPC_METHODS = Object.freeze({
  ledger: [
    'acquireLock',
    'heartbeat',
    'releaseLock',
    'checkEligibility',
    'markContactedFromPage',
    'recordSkip',
    'recordPreSendFailure',
    'beginAttempt',
    'cancelAttempt',
    'resolveAttempt',
    'listNeedsReview',
    'listByStatus',
    'lockStatus',
    'quotaStatus',
    'reviewJob',
    'requeueJob',
    'acceptTimeZoneChange',
  ],
  runs: [
    'get',
    'start',
    'update',
    'markSeen',
    'bump',
    'requestStop',
    'isStopRequested',
    'issueNavToken',
    'consumeNavToken',
    'finish',
  ],
  settings: ['getConfig', 'saveConfig', 'getRiskAck', 'ackRisk'],
  logs: ['append', 'list'],
  app: ['status', 'reconcile'],
});

/** 生成调用后台对象的代理；send 默认为 chrome.runtime.sendMessage。 */
export function createRpcClient(target, send = (m) => chrome.runtime.sendMessage(m)) {
  const client = {};
  for (const method of RPC_METHODS[target]) {
    client[method] = async (...args) => {
      const res = await send({ type: 'rpc', target, method, args });
      if (!res?.ok) throw new Error(res?.error ?? 'rpc failed');
      return res.value;
    };
  }
  return client;
}
