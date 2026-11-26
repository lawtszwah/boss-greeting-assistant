// 任务执行器（PRD §4、§6–§10）。串行处理岗位；所有依赖注入，便于用模拟页面测试。
//
// 一次运行只处理当前页面上的一个关键词；切换关键词时签发导航令牌并整页打开新搜索 URL，
// 新页面加载后由 resume() 接着执行。

import { validateConfig, snapshotConfig, randomDelayMs } from '../core/config.js';
import { evaluateJob, SKIP } from '../core/filter.js';
import { ATTEMPT_RESULT, REJECT, INELIGIBLE } from '../core/ledger.js';
import { RUN_STATUS } from '../core/run-state.js';
import { buildSearchUrl, verifySearchUrl, filterParams } from '../page/search-url.js';
import { TEXT } from '../page/selectors.js';

const MAX_CONSECUTIVE_PARSE_FAILURES = 3;

/** 暂停原因代码，供界面展示。 */
export const PAUSE = Object.freeze({
  BLOCKED: (kind) => `blocked_${kind}`,
  LIST_TIMEOUT: 'list_timeout',
  SEARCH_MISMATCH: 'search_not_applied',
  FILTER_MISMATCH: 'filter_not_applied',
  LIST_STALLED: 'list_stalled',
  PARSE_FAILURES: 'consecutive_parse_failures',
  SEND_UNVERIFIED: 'send_unverified',
  PLATFORM_LIMIT: 'platform_limit',
  LOCK_LOST: 'lock_lost',
  GREET_DIALOG_STUCK: 'greet_dialog_stuck',
});

const QUOTA_DONE = new Set([REJECT.SESSION_LIMIT, REJECT.DAILY_LIMIT]);
const INELIGIBLE_REASONS = new Set(Object.values(INELIGIBLE));

class Halt {
  constructor(status, reason) {
    this.status = status;
    this.reason = reason;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.ledger createLedger() 或其 RPC 代理
 * @param {object} deps.runs createRunStore() 或其 RPC 代理
 * @param {object} deps.page createPageAdapter(document)
 * @param {(url: string) => void} deps.navigate 整页打开 URL
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.random]
 * @param {(entry: object) => void} [deps.log]
 * @param {number} [deps.heartbeatMs] 0 表示不启动心跳定时器（测试用）
 * @param {() => string} [deps.newTaskId]
 * @param {() => Promise<boolean>} [deps.isRiskAcknowledged] 首次风险确认（AC-20）
 */
export function createTaskRunner({
  ledger,
  runs,
  page,
  navigate,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  log = () => {},
  heartbeatMs = 10_000,
  newTaskId = () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  isRiskAcknowledged = async () => true,
}) {
  let lockLost = false;

  async function checkpoint(taskId) {
    if (lockLost) throw new Halt(RUN_STATUS.PAUSED, PAUSE.LOCK_LOST);
    if (await runs.isStopRequested(taskId)) throw new Halt(RUN_STATUS.STOPPED, 'user_stop');
  }

  /** 可被停止打断的等待：每秒检查一次停止标志。 */
  async function wait(taskId, ms) {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 1000);
      await sleep(step);
      left -= step;
      await checkpoint(taskId);
    }
  }

  function checkBlocker() {
    const b = page.detectBlocker();
    if (b) throw new Halt(RUN_STATUS.PAUSED, PAUSE.BLOCKED(b.kind));
  }

  async function goToKeyword(run, keywordIndex) {
    const keyword = run.config.keywords[keywordIndex];
    const url = buildSearchUrl({ keyword, cityCode: run.cityCode, config: run.config });
    await runs.update(run.taskId, { keywordIndex, batch: 0 });
    await runs.issueNavToken(run.taskId, url);
    log({ kind: 'navigate', keyword, keywordIndex });
    navigate(url);
  }

  async function nextKeyword(run) {
    const next = run.keywordIndex + 1;
    if (next >= run.config.keywords.length) throw new Halt(RUN_STATUS.COMPLETED, 'all_keywords_done');
    await wait(run.taskId, randomDelayMs(run.config.actionIntervalSec, random));
    await goToKeyword(run, next);
    return 'navigated';
  }

  /** 处理一个岗位卡片。返回 'sent' | 'skipped'。 */
  async function processCard(run, card, state) {
    const { taskId, config } = run;
    const skip = async (code, detail) => {
      await ledger.recordSkip(taskId, card.jobId ?? `unknown-${state.unknownSeq++}`, code, detail);
      await runs.bump(taskId, 'skipped');
      log({ kind: 'skip', jobId: card.jobId, title: card.title, company: card.company, code, detail });
      return 'skipped';
    };

    const verdict = card.jobId ? evaluateJob(card, config) : { pass: false, code: SKIP.PARSE_FAILED, detail: '岗位 ID 缺失' };
    if (!verdict.pass) {
      if (verdict.code === SKIP.PARSE_FAILED) {
        state.parseFailures += 1;
        if (state.parseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
          await skip(verdict.code, verdict.detail);
          throw new Halt(RUN_STATUS.PAUSED, PAUSE.PARSE_FAILURES);
        }
      }
      return skip(verdict.code, verdict.detail);
    }
    state.parseFailures = 0;

    const job = { jobId: card.jobId, title: card.title, company: card.company, url: card.url };
    const eligibility = await ledger.checkEligibility(job, taskId);
    if (!eligibility.eligible) return skip(eligibility.reason);

    for (let attempt = 1; ; attempt++) {
      await checkpoint(taskId);
      checkBlocker();
      const detail = await page.selectCard(card);
      const failPreSend = async (error) => {
        const r = await ledger.recordPreSendFailure(taskId, job.jobId, error);
        log({ kind: 'pre_send_failure', jobId: job.jobId, error, canRetry: r.canRetry });
        return r.canRetry;
      };

      if (detail.jobId !== job.jobId || !detail.button) {
        if (await failPreSend('detail_not_switched')) continue;
        return skip(INELIGIBLE.PRE_SEND_RETRY_EXHAUSTED, 'detail_not_switched');
      }
      if (!detail.button.idle) {
        if (detail.button.text && detail.button.text !== TEXT.chatIdle) {
          // 平台明确显示已有沟通（如「继续沟通」），记为已沟通，不发送。
          await ledger.markContactedFromPage(job);
          return skip(INELIGIBLE.CONTACTED, detail.button.text);
        }
        if (await failPreSend('chat_button_disabled')) continue;
        return skip(INELIGIBLE.PRE_SEND_RETRY_EXHAUSTED, 'chat_button_disabled');
      }

      await checkpoint(taskId);
      const begin = await ledger.beginAttempt({
        taskId,
        job,
        sessionLimit: config.sessionLimit,
        dailyLimit: config.dailyLimit,
        entryState: detail.button.text,
      });
      if (!begin.ok) {
        if (QUOTA_DONE.has(begin.reason)) throw new Halt(RUN_STATUS.COMPLETED, begin.reason);
        if (INELIGIBLE_REASONS.has(begin.reason)) return skip(begin.reason);
        throw new Halt(RUN_STATUS.PAUSED, begin.reason);
      }

      // 持久化之后、点击之前再次检查停止（PRD §9）。此时尚未点击，可撤销尝试。
      try {
        await checkpoint(taskId);
      } catch (halt) {
        await ledger.cancelAttempt(begin.attemptId);
        throw halt;
      }

      const outcome = await page.clickChatAndAwait(job.jobId);
      if (outcome.clicked === false) {
        await ledger.cancelAttempt(begin.attemptId);
        if (await failPreSend(outcome.reason)) continue;
        return skip(INELIGIBLE.PRE_SEND_RETRY_EXHAUSTED, outcome.reason);
      }
      await settle(run, job, begin.attemptId, outcome);
      return 'sent';
    }
  }

  /** 记录点击结果；结果不明或受限时暂停。 */
  async function settle(run, job, attemptId, outcome) {
    const { taskId } = run;
    let result;
    if (outcome.result === 'success') result = ATTEMPT_RESULT.SUCCESS;
    else if (outcome.blocker?.kind === 'limit') result = ATTEMPT_RESULT.REJECTED;
    else result = ATTEMPT_RESULT.NEEDS_REVIEW;

    try {
      await ledger.resolveAttempt(attemptId, {
        result,
        evidence: outcome.evidence ?? null,
        error: outcome.reason ?? null,
      });
    } catch (error) {
      // 锁过期后被重新获取时，未定尝试已转为待核对（见 PR #4 审阅说明）。
      log({ kind: 'resolve_failed', jobId: job.jobId, error: String(error?.message ?? error) });
      await runs.bump(taskId, 'needsReview');
      throw new Halt(RUN_STATUS.PAUSED, PAUSE.LOCK_LOST);
    }

    if (result === ATTEMPT_RESULT.SUCCESS) {
      await runs.bump(taskId, 'contacted');
      log({ kind: 'contacted', jobId: job.jobId, title: job.title, company: job.company, evidence: outcome.evidence });
      const dismissed = await page.dismissGreetDialog();
      if (dismissed === 'stuck') throw new Halt(RUN_STATUS.PAUSED, PAUSE.GREET_DIALOG_STUCK);
      return;
    }
    await runs.bump(taskId, result === ATTEMPT_RESULT.REJECTED ? 'failed' : 'needsReview');
    log({ kind: result, jobId: job.jobId, title: job.title, company: job.company, reason: outcome.reason });
    throw new Halt(RUN_STATUS.PAUSED, result === ATTEMPT_RESULT.REJECTED ? PAUSE.PLATFORM_LIMIT : PAUSE.SEND_UNVERIFIED);
  }

  /** 在当前搜索页上执行，直到需要导航、结束或暂停。 */
  async function runOnPage(initialRun) {
    let run = initialRun;
    const { taskId, config } = run;
    const state = { parseFailures: 0, unknownSeq: 0 };

    checkBlocker();
    const listState = await page.waitList();
    checkBlocker();
    if (listState === 'timeout') throw new Halt(RUN_STATUS.PAUSED, PAUSE.LIST_TIMEOUT);

    const urlCheck = verifySearchUrl(page.url(), run.expectedUrl);
    if (!urlCheck.ok) {
      log({ kind: 'search_mismatch', mismatches: urlCheck.mismatches });
      throw new Halt(RUN_STATUS.PAUSED, PAUSE.SEARCH_MISMATCH);
    }
    const filterCheck = page.verifyFilterState(filterParams(config));
    if (!filterCheck.ok) {
      log({ kind: 'filter_mismatch', problems: filterCheck.problems });
      throw new Halt(RUN_STATUS.PAUSED, PAUSE.FILTER_MISMATCH);
    }
    if (listState === 'empty') {
      log({ kind: 'no_results', keyword: config.keywords[run.keywordIndex] });
      return nextKeyword(run);
    }

    const seen = new Set(run.seenJobIds);
    let batch = run.batch;
    for (;;) {
      const fresh = page.readCards().filter((c) => !c.jobId || !seen.has(c.jobId));
      for (const card of fresh) {
        await checkpoint(taskId);
        if (card.jobId) {
          seen.add(card.jobId);
          await runs.markSeen(taskId, [card.jobId]);
        }
        const r = await processCard(run, card, state);
        if (r === 'sent') await wait(taskId, randomDelayMs(config.sendIntervalSec, random));
      }

      batch += 1;
      run = await runs.update(taskId, { batch });
      if (batch >= config.maxBatchesPerKeyword) {
        log({ kind: 'batch_limit', keyword: config.keywords[run.keywordIndex] });
        return nextKeyword(run);
      }
      await wait(taskId, randomDelayMs(config.actionIntervalSec, random));
      checkBlocker();
      const more = await page.loadNextBatch();
      if (more.status === 'end') return nextKeyword(run);
      if (more.status === 'stalled') throw new Halt(RUN_STATUS.PAUSED, PAUSE.LIST_STALLED);
    }
  }

  async function execute(run) {
    lockLost = false;
    const timer = heartbeatMs
      ? setInterval(async () => {
          if (!(await ledger.heartbeat(run.taskId))) lockLost = true;
        }, heartbeatMs)
      : null;
    try {
      const r = await runOnPage(run);
      return { status: RUN_STATUS.RUNNING, next: r };
    } catch (e) {
      if (!(e instanceof Halt)) {
        log({ kind: 'error', error: String(e?.stack ?? e) });
        e = new Halt(RUN_STATUS.FAILED, 'unexpected_error');
      }
      await runs.finish(run.taskId, e.status, e.reason);
      await ledger.releaseLock(run.taskId);
      log({ kind: 'finished', status: e.status, reason: e.reason });
      return { status: e.status, reason: e.reason };
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  return {
    /**
     * 开始任务：校验配置、确认当前城市、取得任务锁，然后打开第一个关键词的搜索 URL。
     * @returns {Promise<{ok: true, taskId: string} | {ok: false, reason: string, errors?: object[]}>}
     */
    async start({ config: input, ownerTabId }) {
      if (!(await isRiskAcknowledged())) return { ok: false, reason: 'risk_not_acknowledged' };
      const { ok, errors, config } = validateConfig(input);
      if (!ok) return { ok: false, reason: 'invalid_config', errors };
      const cityCode = page.cityCode();
      if (!cityCode || !/^\d+$/.test(cityCode)) return { ok: false, reason: 'city_unknown' };
      const blocker = page.detectBlocker();
      if (blocker) return { ok: false, reason: PAUSE.BLOCKED(blocker.kind) };

      const taskId = newTaskId();
      const lock = await ledger.acquireLock({ taskId, ownerTabId });
      if (!lock.acquired) return { ok: false, reason: 'lock_held', heldBy: lock.heldBy };
      const started = await runs.start({ taskId, ownerTabId, config: snapshotConfig(config), cityCode });
      log({ kind: 'started', taskId, cityCode, recovered: lock.recovered });
      await goToKeyword(started.run, 0);
      return { ok: true, taskId };
    },

    /** 页面加载后调用：凭导航令牌继续；没有可继续的任务时返回 null。 */
    async resume({ tabId }) {
      const consumed = await runs.consumeNavToken({ tabId, url: page.url() });
      if (!consumed) return null;
      const { run, resumable } = consumed;
      if (!resumable) {
        // 页面被刷新或手动导航：不续发（PRD §9），释放任务锁。
        await ledger.releaseLock(run.taskId);
        log({ kind: 'finished', status: run.status, reason: run.reason });
        return { status: run.status, reason: run.reason };
      }
      const lock = await ledger.acquireLock({ taskId: run.taskId, ownerTabId: tabId });
      if (!lock.acquired) {
        await runs.finish(run.taskId, RUN_STATUS.PAUSED, PAUSE.LOCK_LOST);
        return { status: RUN_STATUS.PAUSED, reason: PAUSE.LOCK_LOST };
      }
      return execute(run);
    },

    stop: (taskId) => runs.requestStop(taskId),
  };
}
