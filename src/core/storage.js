// 存储适配器。业务层只依赖 get/set/getBytesInUse 三个异步方法。

/** chrome.storage.local 的默认配额（未申请 unlimitedStorage 时）。 */
export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;

/** 内存实现，用于测试。failWrites 为 true 时 set 抛错，用于模拟存储失败。 */
export function createMemoryStorage(initial = {}, options = {}) {
  let data = structuredClone(initial);
  const state = { failWrites: options.failWrites ?? false };
  return {
    state,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      if (state.failWrites) throw new Error('storage write failed');
      data = { ...data, ...structuredClone(items) };
    },
    async getBytesInUse() {
      return new TextEncoder().encode(JSON.stringify(data)).length;
    },
    quotaBytes: options.quotaBytes ?? DEFAULT_QUOTA_BYTES,
    dump: () => structuredClone(data),
  };
}

/** chrome.storage 实现。 */
export function createChromeStorage(area = globalThis.chrome?.storage?.local) {
  if (!area) throw new Error('chrome.storage is unavailable');
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    getBytesInUse: () => area.getBytesInUse(null),
    quotaBytes: area.QUOTA_BYTES ?? DEFAULT_QUOTA_BYTES,
  };
}
