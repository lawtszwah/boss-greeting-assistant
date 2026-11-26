// 发送记录、去重、额度与任务锁（PRD §8、§9、§12）。
//
// 所有写操作经同一串行队列执行。扩展中应只在后台 service worker 创建一个 ledger 实例，
// 内容脚本通过消息调用，保证同一浏览器配置文件内只有一个写入者。

import { DEFAULT_QUOTA_BYTES } from './storage.js';

/** 跨任务的岗位状态。 */
export const JOB_STATUS = Object.freeze({
  IN_FLIGHT: 'in_flight', // 已保存尝试记录、可能已点击，结果未定
  CONTACTED: 'contacted', // 已沟通
  NEEDS_REVIEW: 'needs_review', // 待核对
  CONFIRMED_NOT_SENT: 'confirmed_not_sent', // 用户确认未发送，未重新加入
  REQUEUED: 'requeued', // 用户确认未发送并显式重新加入
});

/** 成功证据类型。发送成功只接受 GREET_DIALOG；PAGE_STATE 仅用于页面显示的已有沟通。 */
export const EVIDENCE = Object.freeze({
  GREET_DIALOG: 'greet_dialog', // 「已向BOSS发送消息」弹窗
  PAGE_STATE: 'page_state',
});

export const ATTEMPT_RESULT = Object.freeze({
  IN_FLIGHT: 'in_flight',
  SUCCESS: 'success',
  NEEDS_REVIEW: 'needs_review',
  REJECTED: 'rejected', // 平台明确拒绝；需用户确认未发送后才可重试
  INTERRUPTED: 'interrupted', // 任务中断时仍未定，恢复后转为待核对
});

/** 不合格原因。 */
export const INELIGIBLE = Object.freeze({
  CONTACTED: 'contacted',
  NEEDS_REVIEW: 'needs_review',
  CONFIRMED_NOT_SENT: 'confirmed_not_sent',
  RECRUITER_IN_TASK: 'recruiter_already_contacted_in_task',
  PRE_SEND_RETRY_EXHAUSTED: 'pre_send_retry_exhausted',
  MISSING_JOB_ID: 'missing_job_id',
});

export const REJECT = Object.freeze({
  SESSION_LIMIT: 'session_limit_reached',
  DAILY_LIMIT: 'daily_limit_reached',
  TIMEZONE_CHANGED: 'timezone_changed',
  STORAGE_LOW: 'storage_low',
  STORAGE_ERROR: 'storage_error',
  LOCK_NOT_HELD: 'lock_not_held',
});

const MAX_PRE_SEND_FAILURES = 2; // 首次失败 + 一次重试
const STORAGE_HEADROOM_RATIO = 0.9;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEYS = ['history', 'attempts', 'quota', 'tasks', 'lock'];

/** 按时区取本地日期 YYYY-MM-DD。 */
export function localDateKey(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

let idCounter = 0;
const defaultId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * @param {{storage: object, now?: () => number, timeZone?: () => string, newId?: () => string,
 *          lockTtlMs?: number}} deps
 */
export function createLedger({
  storage,
  now = () => Date.now(),
  timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  newId = defaultId,
  lockTtlMs = 30_000,
}) {
  const enqueue = createQueue();

  async function load() {
    const raw = await storage.get(KEYS);
    return {
      history: raw.history ?? {},
      attempts: raw.attempts ?? {},
      quota: raw.quota ?? null,
      tasks: raw.tasks ?? {},
      lock: raw.lock ?? null,
    };
  }

  function taskState(s, taskId) {
    s.tasks[taskId] ??= { createdAt: now(), skips: {}, preSendFailures: {}, recruiters: [] };
    return s.tasks[taskId];
  }

  function lockIsLive(lock) {
    return Boolean(lock) && now() - lock.heartbeatAt < lockTtlMs;
  }

  function ineligibleReason(s, job, taskId) {
    if (!job?.jobId) return INELIGIBLE.MISSING_JOB_ID;
    const status = s.history[job.jobId]?.status;
    if (status === JOB_STATUS.CONTACTED) return INELIGIBLE.CONTACTED;
    if (status === JOB_STATUS.IN_FLIGHT || status === JOB_STATUS.NEEDS_REVIEW) return INELIGIBLE.NEEDS_REVIEW;
    if (status === JOB_STATUS.CONFIRMED_NOT_SENT) return INELIGIBLE.CONFIRMED_NOT_SENT;
    const t = s.tasks[taskId];
    if (t) {
      if ((t.preSendFailures[job.jobId] ?? 0) >= MAX_PRE_SEND_FAILURES) {
        return INELIGIBLE.PRE_SEND_RETRY_EXHAUSTED;
      }
      if (job.recruiterId && t.recruiters.includes(job.recruiterId)) return INELIGIBLE.RECRUITER_IN_TASK;
    }
    return null;
  }

  function jobSummary(job) {
    return {
      title: job.title ?? '',
      company: job.company ?? '',
      url: job.url ?? '',
      ...(job.recruiterId ? { recruiterId: job.recruiterId } : {}),
    };
  }

  /** 读取当日额度；日期变化时重置。时区与记录不一致时返回 null 表示需暂停核对。 */
  function currentQuota(s) {
    const tz = timeZone();
    const date = localDateKey(now(), tz);
    if (!s.quota) return { date, timeZone: tz, count: 0 };
    if (s.quota.timeZone !== tz) return null;
    if (s.quota.date !== date) return { date, timeZone: tz, count: 0 };
    return s.quota;
  }

  // 恢复：未定的发送尝试转为待核对，不当作从未发送（AC-09）。
  function recoverInFlight(s) {
    const recovered = [];
    for (const attempt of Object.values(s.attempts)) {
      if (attempt.result !== ATTEMPT_RESULT.IN_FLIGHT) continue;
      attempt.result = ATTEMPT_RESULT.INTERRUPTED;
      attempt.resolvedAt = now();
      const h = s.history[attempt.jobId];
      if (h && h.status === JOB_STATUS.IN_FLIGHT) {
        h.status = JOB_STATUS.NEEDS_REVIEW;
        h.updatedAt = now();
      }
      recovered.push(attempt.id);
    }
    return recovered;
  }

  async function save(s, keys) {
    const items = {};
    for (const k of keys) items[k] = s[k];
    await storage.set(items);
  }

  return {
    /** 获取任务锁。同一持有者重入不改状态；其他持有者须等锁释放或过期（AC-14）。 */
    acquireLock({ taskId, ownerTabId }) {
      return enqueue(async () => {
        const s = await load();
        if (lockIsLive(s.lock)) {
          if (s.lock.taskId === taskId && s.lock.ownerTabId === ownerTabId) {
            return { acquired: true, recovered: [] };
          }
          return { acquired: false, heldBy: { taskId: s.lock.taskId, ownerTabId: s.lock.ownerTabId } };
        }
        const recovered = recoverInFlight(s);
        s.lock = { taskId, ownerTabId, acquiredAt: now(), heartbeatAt: now() };
        taskState(s, taskId);
        await save(s, ['lock', 'attempts', 'history', 'tasks']);
        return { acquired: true, recovered };
      });
    },

    heartbeat(taskId) {
      return enqueue(async () => {
        const s = await load();
        if (!lockIsLive(s.lock) || s.lock.taskId !== taskId) return false;
        s.lock.heartbeatAt = now();
        await save(s, ['lock']);
        return true;
      });
    },

    releaseLock(taskId) {
      return enqueue(async () => {
        const s = await load();
        if (!s.lock || s.lock.taskId !== taskId) return false;
        s.lock = null;
        await save(s, ['lock']);
        return true;
      });
    },

    /** 启动或后台唤醒时调用：没有存活锁的情况下，把遗留未定尝试转为待核对。 */
    recoverInterrupted() {
      return enqueue(async () => {
        const s = await load();
        if (lockIsLive(s.lock)) return [];
        const recovered = recoverInFlight(s);
        if (recovered.length) await save(s, ['attempts', 'history']);
        return recovered;
      });
    },

    /** 发送前去重检查（不写入）。 */
    checkEligibility(job, taskId) {
      return enqueue(async () => {
        const reason = ineligibleReason(await load(), job, taskId);
        return reason ? { eligible: false, reason } : { eligible: true };
      });
    },

    /** 页面可靠显示该岗位已有沟通时记为已沟通（PRD §8）。 */
    markContactedFromPage(job) {
      return enqueue(async () => {
        const s = await load();
        const prev = s.history[job.jobId];
        if (prev?.status === JOB_STATUS.CONTACTED) return;
        s.history[job.jobId] = { ...jobSummary(job), status: JOB_STATUS.CONTACTED, evidence: EVIDENCE.PAGE_STATE, updatedAt: now() };
        await save(s, ['history']);
      });
    },

    recordSkip(taskId, jobId, code, detail) {
      return enqueue(async () => {
        const s = await load();
        taskState(s, taskId).skips[jobId] = { code, ...(detail ? { detail } : {}), at: now() };
        await save(s, ['tasks']);
      });
    },

    /** 发送前失败：确认尚未触发任何可能发送的操作。不占额度，同一任务内可重试一次。 */
    recordPreSendFailure(taskId, jobId, error) {
      return enqueue(async () => {
        const s = await load();
        const t = taskState(s, taskId);
        t.preSendFailures[jobId] = (t.preSendFailures[jobId] ?? 0) + 1;
        await save(s, ['tasks']);
        return { canRetry: t.preSendFailures[jobId] < MAX_PRE_SEND_FAILURES, error };
      });
    },

    /**
     * 点击「立即沟通」之前调用：检查锁、去重、本次与当日额度、存储空间，
     * 通过后先持久化尝试记录并占用额度。返回 ok:false 时调用方不得点击。
     */
    beginAttempt({ taskId, job, sessionLimit, dailyLimit, entryState }) {
      return enqueue(async () => {
        const s = await load();
        if (!lockIsLive(s.lock) || s.lock.taskId !== taskId) return { ok: false, reason: REJECT.LOCK_NOT_HELD };

        const ineligible = ineligibleReason(s, job, taskId);
        if (ineligible) return { ok: false, reason: ineligible };

        const sessionCount = Object.values(s.attempts).filter((a) => a.taskId === taskId).length;
        if (sessionCount >= sessionLimit) return { ok: false, reason: REJECT.SESSION_LIMIT };

        const quota = currentQuota(s);
        if (!quota) return { ok: false, reason: REJECT.TIMEZONE_CHANGED };
        if (quota.count >= dailyLimit) return { ok: false, reason: REJECT.DAILY_LIMIT };

        const used = await storage.getBytesInUse();
        if (used >= (storage.quotaBytes ?? DEFAULT_QUOTA_BYTES) * STORAGE_HEADROOM_RATIO) {
          return { ok: false, reason: REJECT.STORAGE_LOW };
        }

        const id = newId();
        s.attempts[id] = {
          id,
          taskId,
          jobId: job.jobId,
          startedAt: now(),
          entryState: entryState ?? null,
          result: ATTEMPT_RESULT.IN_FLIGHT,
        };
        s.history[job.jobId] = { ...jobSummary(job), status: JOB_STATUS.IN_FLIGHT, attemptId: id, updatedAt: now() };
        s.quota = { ...quota, count: quota.count + 1 };
        if (job.recruiterId) {
          const t = taskState(s, taskId);
          if (!t.recruiters.includes(job.recruiterId)) t.recruiters.push(job.recruiterId);
        } else {
          taskState(s, taskId);
        }

        try {
          await save(s, ['attempts', 'history', 'quota', 'tasks']);
        } catch (error) {
          return { ok: false, reason: REJECT.STORAGE_ERROR, error: String(error?.message ?? error) };
        }
        return { ok: true, attemptId: id, sessionUsed: sessionCount + 1, dailyUsed: quota.count + 1 };
      });
    },

    /**
     * 记录发送结果。success 只接受 EVIDENCE.GREET_DIALOG。
     * 未知结果用 needs_review；平台明确拒绝用 rejected。
     */
    resolveAttempt(attemptId, { result, evidence = null, error = null }) {
      return enqueue(async () => {
        const s = await load();
        const attempt = s.attempts[attemptId];
        if (!attempt) throw new Error(`unknown attempt ${attemptId}`);
        if (attempt.result !== ATTEMPT_RESULT.IN_FLIGHT) {
          throw new Error(`attempt ${attemptId} already resolved as ${attempt.result}`);
        }
        if (result === ATTEMPT_RESULT.SUCCESS && evidence !== EVIDENCE.GREET_DIALOG) {
          throw new Error(`success requires ${EVIDENCE.GREET_DIALOG} evidence`);
        }
        if (![ATTEMPT_RESULT.SUCCESS, ATTEMPT_RESULT.NEEDS_REVIEW, ATTEMPT_RESULT.REJECTED].includes(result)) {
          throw new Error(`invalid result ${result}`);
        }
        Object.assign(attempt, { result, evidence, error, resolvedAt: now() });
        const h = s.history[attempt.jobId];
        h.status = result === ATTEMPT_RESULT.SUCCESS ? JOB_STATUS.CONTACTED : JOB_STATUS.NEEDS_REVIEW;
        h.updatedAt = now();
        await save(s, ['attempts', 'history']);
        return h.status;
      });
    },

    /** 待核对列表。 */
    listNeedsReview() {
      return enqueue(async () => {
        const s = await load();
        return Object.entries(s.history)
          .filter(([, h]) => h.status === JOB_STATUS.NEEDS_REVIEW)
          .map(([jobId, h]) => ({ jobId, ...h }));
      });
    },

    /** 用户核对：'contacted' | 'not_sent' | 'keep'。已占用额度不回退。 */
    reviewJob(jobId, decision) {
      return enqueue(async () => {
        const s = await load();
        const h = s.history[jobId];
        if (!h || h.status !== JOB_STATUS.NEEDS_REVIEW) throw new Error(`job ${jobId} is not awaiting review`);
        if (decision === 'keep') return h.status;
        if (decision === 'contacted') h.status = JOB_STATUS.CONTACTED;
        else if (decision === 'not_sent') h.status = JOB_STATUS.CONFIRMED_NOT_SENT;
        else throw new Error(`invalid decision ${decision}`);
        h.reviewedAt = now();
        h.updatedAt = now();
        await save(s, ['history']);
        return h.status;
      });
    },

    /** 用户显式把「确认未发送」的岗位重新加入后续任务。 */
    requeueJob(jobId) {
      return enqueue(async () => {
        const s = await load();
        const h = s.history[jobId];
        if (!h || h.status !== JOB_STATUS.CONFIRMED_NOT_SENT) throw new Error(`job ${jobId} is not confirmed as not sent`);
        h.status = JOB_STATUS.REQUEUED;
        h.updatedAt = now();
        await save(s, ['history']);
      });
    },

    /** 额度概况，供界面展示。 */
    quotaStatus(taskId) {
      return enqueue(async () => {
        const s = await load();
        const quota = currentQuota(s);
        return {
          dailyUsed: quota?.count ?? null,
          timeZoneChanged: quota === null,
          sessionUsed: Object.values(s.attempts).filter((a) => a.taskId === taskId).length,
        };
      });
    },

    /** 用户核对时区变化后，以当前时区继续累计当日额度，不清零。 */
    acceptTimeZoneChange() {
      return enqueue(async () => {
        const s = await load();
        if (!s.quota) return;
        const tz = timeZone();
        s.quota = { date: localDateKey(now(), tz), timeZone: tz, count: s.quota.count };
        await save(s, ['quota']);
      });
    },

    /**
     * 清理超过保留期的详细日志（尝试记录、任务内跳过记录）。
     * 已沟通与待核对等去重历史不清理（PRD §12）。
     */
    pruneLogs(retentionDays = 30) {
      return enqueue(async () => {
        const s = await load();
        const cutoff = now() - retentionDays * DAY_MS;
        let removed = 0;
        for (const [id, a] of Object.entries(s.attempts)) {
          if (a.result !== ATTEMPT_RESULT.IN_FLIGHT && (a.resolvedAt ?? a.startedAt) < cutoff) {
            delete s.attempts[id];
            removed++;
          }
        }
        for (const [id, t] of Object.entries(s.tasks)) {
          if (t.createdAt < cutoff && s.lock?.taskId !== id) {
            delete s.tasks[id];
            removed++;
          }
        }
        if (removed) await save(s, ['attempts', 'tasks']);
        return removed;
      });
    },
  };
}
