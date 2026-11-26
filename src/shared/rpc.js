// 内容脚本与后台之间的 RPC。只开放执行器需要的方法。

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
    'quotaStatus',
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
