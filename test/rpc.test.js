import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPC_METHODS, createRpcClient } from '../src/shared/rpc.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { createLedger } from '../src/core/ledger.js';
import { createRunStore } from '../src/core/run-state.js';

function jsonBridge(targets) {
  // 模拟 chrome.runtime 消息：参数和返回值都经过 JSON 序列化。
  return async (msg) => {
    const m = JSON.parse(JSON.stringify(msg));
    if (!RPC_METHODS[m.target]?.includes(m.method)) return { ok: false, error: 'method not allowed' };
    try {
      const value = await targets[m.target][m.method](...m.args);
      return JSON.parse(JSON.stringify({ ok: true, value: value ?? null }));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
}

test('开放的 RPC 方法都存在于后台对象上', () => {
  const storage = createMemoryStorage();
  const targets = { ledger: createLedger({ storage }), runs: createRunStore({ storage }) };
  for (const [target, methods] of Object.entries(RPC_METHODS)) {
    for (const m of methods) assert.equal(typeof targets[target][m], 'function', `${target}.${m}`);
  }
});

test('经 JSON 序列化的 RPC 完成一次发送流程，错误能传回调用方', async () => {
  const storage = createMemoryStorage();
  const targets = { ledger: createLedger({ storage }), runs: createRunStore({ storage }) };
  const send = jsonBridge(targets);
  const ledger = createRpcClient('ledger', send);
  const runs = createRpcClient('runs', send);

  assert.equal((await ledger.acquireLock({ taskId: 't', ownerTabId: 1 })).acquired, true);
  const started = await runs.start({ taskId: 't', ownerTabId: 1, config: { keywords: ['a'] }, cityCode: '101010100' });
  assert.equal(started.ok, true);
  const job = { jobId: 'j1', title: '岗位', company: '公司', url: 'https://example.com/j1' };
  const begin = await ledger.beginAttempt({ taskId: 't', job, sessionLimit: 5, dailyLimit: 5 });
  assert.equal(begin.ok, true);
  assert.equal(await ledger.resolveAttempt(begin.attemptId, { result: 'success', evidence: 'greet_dialog' }), 'contacted');
  await assert.rejects(ledger.resolveAttempt(begin.attemptId, { result: 'success', evidence: 'greet_dialog' }), /already resolved/);
  assert.equal(await runs.isStopRequested('t'), false);

  const raw = createRpcClient('ledger', async (m) => send({ ...m, method: 'pruneLogs' }));
  await assert.rejects(raw.heartbeat('t'), /not allowed/);
});
