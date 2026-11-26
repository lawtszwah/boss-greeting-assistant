// 运行日志（PRD §11、§12）。只写 'logs' 键；默认保留 30 天，最多 1000 条。
// 日志只用于展示，不作为去重依据；去重历史由 ledger 保存，不受日志清理影响。

const DAY_MS = 24 * 60 * 60 * 1000;

function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** 只保留界面需要的字段，避免把页面元素等不可序列化的内容写入存储。 */
const FIELDS = ['kind', 'taskId', 'jobId', 'title', 'company', 'code', 'detail', 'reason', 'status', 'evidence', 'keyword', 'error'];
function sanitize(entry) {
  const out = {};
  for (const k of FIELDS) {
    const v = entry?.[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 200) : typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 200);
  }
  return out;
}

export function createLogStore({ storage, now = () => Date.now(), maxEntries = 1000, retentionDays = 30 }) {
  const enqueue = createQueue();
  const load = async () => (await storage.get(['logs'])).logs ?? [];

  return {
    append(entry) {
      return enqueue(async () => {
        const logs = await load();
        logs.push({ at: now(), ...sanitize(entry) });
        const cutoff = now() - retentionDays * DAY_MS;
        const kept = logs.filter((l) => l.at >= cutoff).slice(-maxEntries);
        await storage.set({ logs: kept });
      });
    },

    /** 最近的日志，新的在前。 */
    list(limit = 100) {
      return enqueue(async () => (await load()).slice(-limit).reverse());
    },
  };
}
