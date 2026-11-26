// 页面操作：选中卡片、滚动加载下一批、点击「立即沟通」并判定结果。
// 唯一可能触发发送的操作是 clickChatAndAwait；调用前必须已由 ledger.beginAttempt 持久化记录。

import { SEL, TEXT } from './selectors.js';
import { readCards, readDetail, detectBlocker, isVisible } from './reader.js';
import { EVIDENCE } from '../core/ledger.js';

/** 轮询直到 predicate 返回真值或超时。返回该值或 null。 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 点击卡片信息区，等待详情区切换到该岗位。 */
export async function selectCard(doc, card, { timeoutMs = 5000 } = {}) {
  const target = card.element.querySelector(SEL.cardInfo) ?? card.element;
  target.click();
  const detail = await waitFor(() => {
    const d = readDetail(doc);
    return d.jobId === card.jobId ? d : null;
  }, { timeoutMs });
  return detail ?? { present: false, jobId: readDetail(doc).jobId, button: null, timedOut: true };
}

/**
 * 滚动到列表底部，等待新增岗位。
 * @returns {Promise<{status: 'loaded', newIds: string[]} | {status: 'end'} | {status: 'stalled'}>}
 *   end：列表未增长且不在加载；stalled：一直在加载或页面无变化，需暂停（PRD §10）。
 */
export async function loadNextBatch(doc, { timeoutMs = 8000 } = {}) {
  const win = doc.defaultView;
  const before = new Set(readCards(doc).map((c) => c.jobId));
  win.scrollTo(0, doc.body.scrollHeight);
  doc.querySelector(SEL.listContainer)?.lastElementChild?.scrollIntoView?.({ block: 'end' });

  let sawLoading = false;
  const grown = await waitFor(() => {
    const loading = doc.querySelector(SEL.loading);
    if (loading && isVisible(loading)) sawLoading = true;
    const ids = readCards(doc).map((c) => c.jobId).filter((id) => id && !before.has(id));
    return ids.length ? ids : null;
  }, { timeoutMs });
  if (grown) return { status: 'loaded', newIds: grown };
  const loading = doc.querySelector(SEL.loading);
  return sawLoading && loading && isVisible(loading) ? { status: 'stalled' } : { status: 'end' };
}

/**
 * 点击当前详情区的「立即沟通」并等待平台的发送成功弹窗（PRD §7.2、§7.3）。
 * 弹窗约 450 ms 出现、约 1.8 s 消失，用 MutationObserver 捕获，避免轮询错过。
 *
 * @returns {Promise<
 *   {result: 'success', evidence: 'greet_dialog'} |
 *   {result: 'needs_review', reason: string, blocker?: object}
 * >}
 */
export async function clickChatAndAwait(doc, { expectedJobId, timeoutMs = 5000 }) {
  const win = doc.defaultView;
  const before = readDetail(doc);
  if (before.jobId !== expectedJobId || !before.button?.idle) {
    // 调用方应先核验；走到这里说明状态在核验后变化，未点击即返回。
    return { result: 'needs_review', reason: 'target_changed_before_click', clicked: false };
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };

    const check = () => {
      const dialog = doc.querySelector(SEL.greetDialog);
      if (dialog && (dialog.querySelector(SEL.greetHeader)?.textContent ?? '').includes(TEXT.greetSent)) {
        const now = readDetail(doc);
        if (now.jobId !== expectedJobId) {
          finish({ result: 'needs_review', reason: 'target_changed_after_click' });
        } else {
          finish({ result: 'success', evidence: EVIDENCE.GREET_DIALOG });
        }
        return;
      }
      if (win.location.pathname !== before.pathname && before.pathname) {
        finish({ result: 'needs_review', reason: 'navigated_after_click' });
        return;
      }
      const blocker = detectBlocker(doc);
      if (blocker) finish({ result: 'needs_review', reason: `blocked_${blocker.kind}`, blocker });
    };

    before.pathname = win.location.pathname;
    const observer = new win.MutationObserver(check);
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => finish({ result: 'needs_review', reason: 'no_greet_dialog' }), timeoutMs);

    before.button.element.click();
    check();
  });
}

/** 成功弹窗仍在时点击「留在此页」关闭它；不点击「继续沟通」。 */
export async function dismissGreetDialog(doc, { timeoutMs = 3000 } = {}) {
  const gone = await waitFor(() => !doc.querySelector(SEL.greetDialog), { timeoutMs });
  if (gone) return 'gone';
  const stay = doc.querySelector(SEL.greetStay);
  if (!stay) return 'stuck';
  stay.click();
  return (await waitFor(() => !doc.querySelector(SEL.greetDialog), { timeoutMs: 2000 })) ? 'dismissed' : 'stuck';
}
