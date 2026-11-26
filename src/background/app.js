// 后台的组合操作：对账与状态汇总。与 chrome API 解耦，便于测试。

import { RUN_STATUS } from '../core/run-state.js';
import { JOB_STATUS } from '../core/ledger.js';
import { DEFAULT_QUOTA_BYTES } from '../core/storage.js';

export function createApp({ storage, ledger, runs, logs }) {
  /**
   * 对账（PRD §9）：任务显示运行中但任务锁已过期（页面关闭、崩溃或浏览器退出），
   * 则把任务标为暂停，并把遗留的未定尝试转为待核对，避免永久显示「运行中」。
   */
  async function reconcile() {
    const recovered = await ledger.recoverInterrupted();
    const lock = await ledger.lockStatus();
    let run = await runs.get();
    if (run && run.status === RUN_STATUS.RUNNING && !(lock.live && lock.taskId === run.taskId)) {
      run = await runs.finish(run.taskId, RUN_STATUS.PAUSED, 'interrupted');
      await logs.append({ kind: 'finished', taskId: run.taskId, status: RUN_STATUS.PAUSED, reason: 'interrupted' });
    }
    return { run, lock, recovered };
  }

  return {
    reconcile,

    /** 弹窗一次取回需要展示的全部状态。 */
    async status() {
      const { run, lock } = await reconcile();
      const quota = await ledger.quotaStatus(run?.taskId ?? null);
      const needsReview = await ledger.listByStatus(JOB_STATUS.NEEDS_REVIEW);
      const confirmedNotSent = await ledger.listByStatus(JOB_STATUS.CONFIRMED_NOT_SENT);
      const bytes = await storage.getBytesInUse();
      return {
        run,
        lock,
        quota,
        needsReview,
        confirmedNotSent,
        storage: { bytes, quota: storage.quotaBytes ?? DEFAULT_QUOTA_BYTES },
      };
    },
  };
}
