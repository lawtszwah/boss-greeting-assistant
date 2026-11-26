// 任务运行状态与导航令牌（PRD §9）。与 ledger 共用存储但只写 'run' 键。
//
// 插件自身导航（切换关键词）前签发一次性令牌；新页面加载后由同一标签页消费，
// 令牌未过期且 URL 符合预期才继续。用户手动刷新时没有可用令牌，任务转为暂停，不续发。

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const TERMINAL = new Set([RUN_STATUS.PAUSED, RUN_STATUS.STOPPED, RUN_STATUS.COMPLETED, RUN_STATUS.FAILED]);

function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const randomToken = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * @param {{storage: object, now?: () => number, newToken?: () => string, navTtlMs?: number,
 *          urlMatches?: (actual: string, expected: string) => boolean}} deps
 */
export function createRunStore({
  storage,
  now = () => Date.now(),
  newToken = randomToken,
  navTtlMs = 60_000,
  urlMatches = (a, e) => a === e,
}) {
  const enqueue = createQueue();
  const load = async () => (await storage.get(['run'])).run ?? null;
  const save = (run) => storage.set({ run });

  async function mutate(taskId, fn) {
    return enqueue(async () => {
      const run = await load();
      if (!run || run.taskId !== taskId) return null;
      fn(run);
      run.updatedAt = now();
      await save(run);
      return run;
    });
  }

  return {
    get: () => enqueue(load),

    /**
     * 开始新任务，覆盖上一次的运行状态。调用方必须先取得 ledger 任务锁：
     * 拿到锁即说明没有存活的任务，遗留的 running 状态来自崩溃的页面。
     */
    start({ taskId, ownerTabId, config, cityCode }) {
      return enqueue(async () => {
        const prev = await load();
        const run = {
          taskId,
          ownerTabId,
          config,
          cityCode,
          status: RUN_STATUS.RUNNING,
          reason: null,
          keywordIndex: 0,
          batch: 0,
          expectedUrl: null,
          seenJobIds: [],
          counts: { contacted: 0, needsReview: 0, failed: 0, skipped: 0 },
          stopRequested: false,
          nav: null,
          startedAt: now(),
          updatedAt: now(),
          endedAt: null,
          replaced: prev && prev.status === RUN_STATUS.RUNNING ? { taskId: prev.taskId, reason: 'stale' } : null,
        };
        await save(run);
        return { ok: true, run };
      });
    },

    update(taskId, patch) {
      return mutate(taskId, (run) => Object.assign(run, typeof patch === 'function' ? patch(run) : patch));
    },

    /** 记录已处理的岗位 ID（跨关键词去重，AC-01）。 */
    markSeen(taskId, jobIds) {
      return mutate(taskId, (run) => {
        const set = new Set(run.seenJobIds);
        for (const id of jobIds) set.add(id);
        run.seenJobIds = [...set];
      });
    },

    bump(taskId, key, by = 1) {
      return mutate(taskId, (run) => {
        run.counts[key] = (run.counts[key] ?? 0) + by;
      });
    },

    requestStop(taskId) {
      return mutate(taskId, (run) => {
        if (run.status === RUN_STATUS.RUNNING) run.stopRequested = true;
      });
    },

    async isStopRequested(taskId) {
      const run = await enqueue(load);
      return !run || run.taskId !== taskId || run.stopRequested || run.status !== RUN_STATUS.RUNNING;
    },

    /** 插件自身导航前调用：签发令牌并记录预期 URL。 */
    issueNavToken(taskId, expectedUrl) {
      return mutate(taskId, (run) => {
        run.expectedUrl = expectedUrl;
        run.nav = { token: newToken(), expectedUrl, expiresAt: now() + navTtlMs };
      });
    },

    /**
     * 新页面加载后调用。返回 null（与本标签页无关），或 {run, resumable}。
     * 令牌一律用后即废；属于本标签页的运行中任务若没有有效令牌，则转为暂停（页面被刷新或手动导航）。
     */
    consumeNavToken({ tabId, url }) {
      return enqueue(async () => {
        const run = await load();
        if (!run || run.status !== RUN_STATUS.RUNNING || run.ownerTabId !== tabId) return null;
        const nav = run.nav;
        run.nav = null;
        run.updatedAt = now();
        let resumable = false;
        if (!nav) {
          run.status = RUN_STATUS.PAUSED;
          run.reason = 'page_reloaded';
        } else if (now() >= nav.expiresAt) {
          run.status = RUN_STATUS.PAUSED;
          run.reason = 'nav_token_expired';
        } else if (!urlMatches(url, nav.expectedUrl)) {
          run.status = RUN_STATUS.PAUSED;
          run.reason = 'unexpected_url';
        } else {
          resumable = true;
        }
        if (!resumable) run.endedAt = now();
        await save(run);
        return { run, resumable };
      });
    },

    /** 结束任务：暂停、停止、完成或失败。 */
    finish(taskId, status, reason = null) {
      if (!TERMINAL.has(status)) throw new Error(`invalid terminal status ${status}`);
      return mutate(taskId, (run) => {
        run.status = status;
        run.reason = reason;
        run.nav = null;
        run.endedAt = now();
      });
    },
  };
}
