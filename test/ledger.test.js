// 去重、额度、发送记录与任务锁。覆盖 AC-04、AC-08、AC-09、AC-10、AC-11、AC-14、AC-18 的规则层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/core/storage.js';
import { createLedger, INELIGIBLE, REJECT, JOB_STATUS, ATTEMPT_RESULT, localDateKey } from '../src/core/ledger.js';

function setup({ start = Date.UTC(2026, 10, 26, 2, 0), tz = 'Australia/Brisbane', storage } = {}) {
  const clock = { t: start, tz };
  let n = 0;
  const st = storage ?? createMemoryStorage();
  const ledger = createLedger({
    storage: st,
    now: () => clock.t,
    timeZone: () => clock.tz,
    newId: () => `a${++n}`,
  });
  return { ledger, storage: st, clock };
}

const job = (id, extra = {}) => ({ jobId: id, title: `岗位${id}`, company: '示例公司', url: `https://example.com/${id}`, ...extra });
const limits = { sessionLimit: 20, dailyLimit: 30 };

async function send(ledger, taskId, j, result = ATTEMPT_RESULT.SUCCESS, lim = limits) {
  const r = await ledger.beginAttempt({ taskId, job: j, ...lim });
  if (r.ok) await ledger.resolveAttempt(r.attemptId, { result, evidence: result === 'success' ? 'success_toast' : null });
  return r;
}

test('发送前必须持有任务锁', async () => {
  const { ledger } = setup();
  const r = await ledger.beginAttempt({ taskId: 't1', job: job('1'), ...limits });
  assert.equal(r.reason, REJECT.LOCK_NOT_HELD);
});

test('AC-14 同一配置文件只能有一个运行任务；过期锁可接管', async () => {
  const { ledger, clock } = setup();
  assert.equal((await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 })).acquired, true);
  const second = await ledger.acquireLock({ taskId: 't2', ownerTabId: 2 });
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy.taskId, 't1');
  clock.t += 31_000;
  assert.equal((await ledger.acquireLock({ taskId: 't2', ownerTabId: 2 })).acquired, true);
});

test('心跳维持锁，释放后他人可获取', async () => {
  const { ledger, clock } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  clock.t += 20_000;
  await ledger.heartbeat('t1');
  clock.t += 20_000;
  assert.equal((await ledger.acquireLock({ taskId: 't2', ownerTabId: 2 })).acquired, false);
  await ledger.releaseLock('t1');
  assert.equal((await ledger.acquireLock({ taskId: 't2', ownerTabId: 2 })).acquired, true);
});

test('成功需要证据，已沟通岗位跨任务去重（AC-10）', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  const r = await ledger.beginAttempt({ taskId: 't1', job: job('1'), ...limits });
  await assert.rejects(ledger.resolveAttempt(r.attemptId, { result: 'success' }), /evidence/);
  await ledger.resolveAttempt(r.attemptId, { result: 'success', evidence: 'success_toast' });
  await assert.rejects(ledger.resolveAttempt(r.attemptId, { result: 'success', evidence: 'x' }), /already resolved/);
  await ledger.releaseLock('t1');

  await ledger.acquireLock({ taskId: 't2', ownerTabId: 1 });
  assert.deepEqual(await ledger.checkEligibility(job('1'), 't2'), { eligible: false, reason: INELIGIBLE.CONTACTED });
  assert.equal((await ledger.beginAttempt({ taskId: 't2', job: job('1'), ...limits })).reason, INELIGIBLE.CONTACTED);
});

test('同一任务内同一招聘者只沟通一次；同公司无招聘者标识不合并（AC-10）', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('1', { recruiterId: 'hr-a' }));
  assert.equal((await ledger.checkEligibility(job('2', { recruiterId: 'hr-a' }), 't1')).reason, INELIGIBLE.RECRUITER_IN_TASK);
  assert.equal((await ledger.checkEligibility(job('3', { recruiterId: 'hr-b' }), 't1')).eligible, true);
  assert.equal((await ledger.checkEligibility(job('4'), 't1')).eligible, true);
});

test('页面显示已沟通时记为已沟通', async () => {
  const { ledger } = setup();
  await ledger.markContactedFromPage(job('9'));
  assert.equal((await ledger.checkEligibility(job('9'), 't1')).reason, INELIGIBLE.CONTACTED);
});

test('AC-04 本次跳过不影响下次任务', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await ledger.recordSkip('t1', '5', 'salary_mismatch');
  await ledger.releaseLock('t1');
  await ledger.acquireLock({ taskId: 't2', ownerTabId: 1 });
  assert.equal((await ledger.checkEligibility(job('5'), 't2')).eligible, true);
});

test('发送前失败不占额度，可重试一次', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  assert.equal((await ledger.recordPreSendFailure('t1', '6', 'button not found')).canRetry, true);
  assert.equal((await ledger.checkEligibility(job('6'), 't1')).eligible, true);
  assert.equal((await ledger.recordPreSendFailure('t1', '6', 'button not found')).canRetry, false);
  assert.equal((await ledger.checkEligibility(job('6'), 't1')).reason, INELIGIBLE.PRE_SEND_RETRY_EXHAUSTED);
  assert.equal((await ledger.quotaStatus('t1')).dailyUsed, 0);
});

test('AC-08 结果不明：占额度、进入待核对、不自动重发', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('7'), ATTEMPT_RESULT.NEEDS_REVIEW);
  const q = await ledger.quotaStatus('t1');
  assert.equal(q.dailyUsed, 1);
  assert.equal(q.sessionUsed, 1);
  assert.equal((await ledger.checkEligibility(job('7'), 't1')).reason, INELIGIBLE.NEEDS_REVIEW);
  assert.deepEqual((await ledger.listNeedsReview()).map((j) => j.jobId), ['7']);
});

test('平台明确拒绝也进入待核对', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('8'), ATTEMPT_RESULT.REJECTED);
  assert.equal((await ledger.checkEligibility(job('8'), 't1')).reason, INELIGIBLE.NEEDS_REVIEW);
});

test('AC-09 页面中断后未定尝试转为待核对，重启不重复发送', async () => {
  const { ledger, storage, clock } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  const r = await ledger.beginAttempt({ taskId: 't1', job: job('10'), ...limits });
  assert.equal(r.ok, true);
  // 页面崩溃：未调用 resolveAttempt，锁随后过期。用同一存储重建 ledger，模拟后台重启。
  clock.t += 60_000;
  const restarted = createLedger({ storage, now: () => clock.t, timeZone: () => clock.tz, newId: () => 'b1' });
  assert.deepEqual(await restarted.recoverInterrupted(), [r.attemptId]);
  assert.equal(storage.dump().attempts[r.attemptId].result, ATTEMPT_RESULT.INTERRUPTED);
  await restarted.acquireLock({ taskId: 't2', ownerTabId: 1 });
  assert.equal((await restarted.checkEligibility(job('10'), 't2')).reason, INELIGIBLE.NEEDS_REVIEW);
});

test('锁仍存活时不恢复，避免误改运行中的尝试', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await ledger.beginAttempt({ taskId: 't1', job: job('11'), ...limits });
  assert.deepEqual(await ledger.recoverInterrupted(), []);
});

test('人工核对：确认未发送后须显式重新加入，额度不回退', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('12'), ATTEMPT_RESULT.NEEDS_REVIEW);
  assert.equal(await ledger.reviewJob('12', 'keep'), JOB_STATUS.NEEDS_REVIEW);
  assert.equal(await ledger.reviewJob('12', 'not_sent'), JOB_STATUS.CONFIRMED_NOT_SENT);
  assert.equal((await ledger.checkEligibility(job('12'), 't1')).reason, INELIGIBLE.CONFIRMED_NOT_SENT);
  await ledger.requeueJob('12');
  assert.equal((await ledger.checkEligibility(job('12'), 't1')).eligible, true);
  assert.equal((await ledger.quotaStatus('t1')).dailyUsed, 1);
  await assert.rejects(ledger.reviewJob('12', 'contacted'), /not awaiting review/);
});

test('人工核对为已沟通', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('13'), ATTEMPT_RESULT.NEEDS_REVIEW);
  await ledger.reviewJob('13', 'contacted');
  assert.equal((await ledger.checkEligibility(job('13'), 't1')).reason, INELIGIBLE.CONTACTED);
});

test('AC-11 本次额度包含不确定尝试', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  const lim = { sessionLimit: 2, dailyLimit: 30 };
  await send(ledger, 't1', job('a'), ATTEMPT_RESULT.SUCCESS, lim);
  await send(ledger, 't1', job('b'), ATTEMPT_RESULT.NEEDS_REVIEW, lim);
  assert.equal((await ledger.beginAttempt({ taskId: 't1', job: job('c'), ...lim })).reason, REJECT.SESSION_LIMIT);
});

test('AC-11 当日额度跨任务累计，次日重置', async () => {
  const { ledger, clock } = setup();
  const lim = { sessionLimit: 20, dailyLimit: 2 };
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('a'), ATTEMPT_RESULT.SUCCESS, lim);
  await ledger.releaseLock('t1');
  await ledger.acquireLock({ taskId: 't2', ownerTabId: 1 });
  await send(ledger, 't2', job('b'), ATTEMPT_RESULT.SUCCESS, lim);
  assert.equal((await ledger.beginAttempt({ taskId: 't2', job: job('c'), ...lim })).reason, REJECT.DAILY_LIMIT);
  clock.t += 24 * 60 * 60 * 1000;
  assert.equal((await ledger.beginAttempt({ taskId: 't2', job: job('c'), ...lim })).ok, true);
});

test('时区变化时暂停，用户核对后继续累计不清零', async () => {
  const { ledger, clock } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('a'));
  clock.tz = 'Asia/Shanghai';
  assert.equal((await ledger.beginAttempt({ taskId: 't1', job: job('b'), ...limits })).reason, REJECT.TIMEZONE_CHANGED);
  assert.equal((await ledger.quotaStatus('t1')).timeZoneChanged, true);
  await ledger.acceptTimeZoneChange();
  assert.equal((await ledger.quotaStatus('t1')).dailyUsed, 1);
  assert.equal((await ledger.beginAttempt({ taskId: 't1', job: job('b'), ...limits })).ok, true);
});

test('AC-18 存储写入失败时拒绝发送', async () => {
  const storage = createMemoryStorage();
  const { ledger } = setup({ storage });
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  storage.state.failWrites = true;
  const r = await ledger.beginAttempt({ taskId: 't1', job: job('x'), ...limits });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.STORAGE_ERROR);
});

test('AC-18 存储空间不足时拒绝发送', async () => {
  const storage = createMemoryStorage({}, { quotaBytes: 200 });
  const { ledger } = setup({ storage });
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  assert.equal((await ledger.beginAttempt({ taskId: 't1', job: job('x'), ...limits })).reason, REJECT.STORAGE_LOW);
});

test('并发调用被串行化，不会超出额度', async () => {
  const { ledger } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  const lim = { sessionLimit: 3, dailyLimit: 30 };
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => ledger.beginAttempt({ taskId: 't1', job: job(`p${i}`), ...lim })),
  );
  assert.equal(results.filter((r) => r.ok).length, 3);
});

test('清理日志保留去重历史', async () => {
  const { ledger, storage, clock } = setup();
  await ledger.acquireLock({ taskId: 't1', ownerTabId: 1 });
  await send(ledger, 't1', job('old'));
  await ledger.releaseLock('t1');
  clock.t += 31 * 24 * 60 * 60 * 1000;
  assert.equal(await ledger.pruneLogs(30), 2);
  assert.deepEqual(storage.dump().attempts, {});
  assert.equal((await ledger.checkEligibility(job('old'), 't9')).reason, INELIGIBLE.CONTACTED);
});

test('本地日期按时区计算', () => {
  const ms = Date.UTC(2026, 10, 26, 15, 0); // 布里斯班已是 27 日凌晨
  assert.equal(localDateKey(ms, 'Australia/Brisbane'), '2026-11-27');
  assert.equal(localDateKey(ms, 'UTC'), '2026-11-26');
});
