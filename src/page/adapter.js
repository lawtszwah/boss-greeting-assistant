// 把页面读取与操作绑定到一个 document，供任务执行器使用。

import { readCards, readDetail, verifyFilterState, detectBlocker, listStatus } from './reader.js';
import { selectCard, loadNextBatch, clickChatAndAwait, dismissGreetDialog, waitFor } from './actions.js';

export const DEFAULT_TIMEOUTS = Object.freeze({
  list: 15_000,
  select: 5_000,
  greet: 5_000,
  batch: 8_000,
  dismiss: 3_000,
});

export function createPageAdapter(doc, timeouts = {}) {
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  return {
    url: () => doc.defaultView.location.href,
    cityCode: () => new URL(doc.defaultView.location.href).searchParams.get('city'),
    detectBlocker: () => detectBlocker(doc),
    /** 等待列表就绪或明确无结果；超时返回 'timeout'。 */
    async waitList() {
      const s = await waitFor(() => {
        const st = listStatus(doc);
        return st === 'loading' ? null : st;
      }, { timeoutMs: t.list, intervalMs: 200 });
      return s ?? 'timeout';
    },
    readCards: () => readCards(doc),
    readDetail: () => readDetail(doc),
    verifyFilterState: (params) => verifyFilterState(doc, params),
    selectCard: (card) => selectCard(doc, card, { timeoutMs: t.select }),
    clickChatAndAwait: (jobId) => clickChatAndAwait(doc, { expectedJobId: jobId, timeoutMs: t.greet }),
    dismissGreetDialog: () => dismissGreetDialog(doc, { timeoutMs: t.dismiss }),
    loadNextBatch: () => loadNextBatch(doc, { timeoutMs: t.batch }),
  };
}
