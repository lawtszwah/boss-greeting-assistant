// 配置默认值、规范化与校验（PRD §5）。纯函数，不依赖浏览器 API。

export const LIMITS = Object.freeze({
  maxKeywords: 10,
  sessionLimit: { min: 1, max: 30 },
  dailyLimit: { min: 1, max: 30 },
  sendIntervalMinSec: 15,
  actionIntervalMinSec: 3,
  maxBatchesPerKeyword: { min: 1, max: 20 },
});

/**
 * 平台原生薪资档位（2026-11-26 页面核实，见 docs/PAGE-ADAPTATION.md）。
 * 卡片薪资数字经字体混淆，插件不解码，薪资只通过原生筛选实现。
 */
export const SALARY_BUCKETS = Object.freeze({
  402: '3K以下',
  403: '3-5K',
  404: '5-10K',
  405: '10-20K',
  406: '20-50K',
  407: '50K以上',
});

/** 平台原生筛选项：页面显示文本 → URL 参数代码（同上来源）。 */
export const FILTER_CODES = Object.freeze({
  jobType: Object.freeze({ 全职: '1901', 兼职: '1903', 实习: '1902' }),
  experience: Object.freeze({
    在校生: '108',
    应届生: '102',
    经验不限: '101',
    '1年以内': '103',
    '1-3年': '104',
    '3-5年': '105',
    '5-10年': '106',
    '10年以上': '107',
  }),
  degree: Object.freeze({
    初中及以下: '209',
    '中专/中技': '208',
    高中: '206',
    大专: '202',
    本科: '203',
    硕士: '204',
    博士: '205',
  }),
});

export const DEFAULT_CONFIG = Object.freeze({
  keywords: [],
  // 求职类型、经验、学历：首版各最多选一个平台取值，空数组表示不限。
  // 通过平台原生筛选应用并核验；经验、学历另在卡片上复核。
  jobTypes: [],
  experiences: [],
  degrees: [],
  // 平台薪资档位代码，null 表示不限。
  salaryBucket: null,
  excludeKeywords: [],
  excludeCompanies: [],
  sessionLimit: 20,
  dailyLimit: 30,
  sendIntervalSec: Object.freeze({ min: 15, max: 30 }),
  actionIntervalSec: Object.freeze({ min: 3, max: 8 }),
  maxBatchesPerKeyword: 5,
});

/** 去首尾空白、去空项、按不区分大小写去重，保留首次出现的写法。 */
export function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return typeof value === 'number' ? value : Number(value);
}

/** 把用户输入合并到默认值上，得到结构完整的配置（未校验）。 */
export function normalizeConfig(input = {}) {
  const d = DEFAULT_CONFIG;
  return {
    keywords: normalizeList(input.keywords),
    jobTypes: normalizeList(input.jobTypes),
    experiences: normalizeList(input.experiences),
    degrees: normalizeList(input.degrees),
    salaryBucket:
      input.salaryBucket === null || input.salaryBucket === undefined || input.salaryBucket === ''
        ? null
        : String(input.salaryBucket),
    excludeKeywords: normalizeList(input.excludeKeywords),
    excludeCompanies: normalizeList(input.excludeCompanies),
    sessionLimit: toNumber(input.sessionLimit, d.sessionLimit),
    dailyLimit: toNumber(input.dailyLimit, d.dailyLimit),
    sendIntervalSec: {
      min: toNumber(input.sendIntervalSec?.min, d.sendIntervalSec.min),
      max: toNumber(input.sendIntervalSec?.max, d.sendIntervalSec.max),
    },
    actionIntervalSec: {
      min: toNumber(input.actionIntervalSec?.min, d.actionIntervalSec.min),
      max: toNumber(input.actionIntervalSec?.max, d.actionIntervalSec.max),
    },
    maxBatchesPerKeyword: toNumber(input.maxBatchesPerKeyword, d.maxBatchesPerKeyword),
  };
}

const isInt = (n) => Number.isInteger(n);
const inRange = (n, { min, max }) => isInt(n) && n >= min && n <= max;
const isNonNegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function validateInterval(errors, field, interval, minSec, label) {
  const { min, max } = interval;
  if (!isNonNegative(min) || !isNonNegative(max)) {
    errors.push({ field, message: `${label}必须是数字` });
  } else if (min < minSec) {
    errors.push({ field, message: `${label}最小值不能少于 ${minSec} 秒` });
  } else if (max < min) {
    errors.push({ field, message: `${label}最大值不能小于最小值` });
  }
}

/**
 * 规范化并校验配置。
 * @returns {{ ok: boolean, errors: {field: string, message: string}[], config: object }}
 */
export function validateConfig(input) {
  const config = normalizeConfig(input);
  const errors = [];

  if (config.keywords.length === 0) {
    errors.push({ field: 'keywords', message: '至少填写一个搜索关键词' });
  } else if (config.keywords.length > LIMITS.maxKeywords) {
    errors.push({ field: 'keywords', message: `搜索关键词最多 ${LIMITS.maxKeywords} 个` });
  }

  for (const [field, kind, label] of [
    ['jobTypes', 'jobType', '求职类型'],
    ['experiences', 'experience', '工作经验'],
    ['degrees', 'degree', '学历'],
  ]) {
    const values = config[field];
    if (values.length > 1) {
      errors.push({ field, message: `${label}首版只能选择一个` });
    } else if (values.length === 1 && !Object.hasOwn(FILTER_CODES[kind], values[0])) {
      errors.push({ field, message: `${label}须选择平台提供的选项` });
    }
  }

  if (config.salaryBucket !== null && !Object.hasOwn(SALARY_BUCKETS, config.salaryBucket)) {
    errors.push({ field: 'salaryBucket', message: '薪资须选择平台提供的档位' });
  }

  if (!inRange(config.sessionLimit, LIMITS.sessionLimit)) {
    errors.push({ field: 'sessionLimit', message: '本次发送上限须为 1–30 的整数' });
  }
  if (!inRange(config.dailyLimit, LIMITS.dailyLimit)) {
    errors.push({ field: 'dailyLimit', message: '当日发送上限须为 1–30 的整数' });
  }
  if (!inRange(config.maxBatchesPerKeyword, LIMITS.maxBatchesPerKeyword)) {
    errors.push({ field: 'maxBatchesPerKeyword', message: '每关键词最大批次数须为 1–20 的整数' });
  }

  validateInterval(errors, 'sendIntervalSec', config.sendIntervalSec, LIMITS.sendIntervalMinSec, '操作间隔');
  validateInterval(errors, 'actionIntervalSec', config.actionIntervalSec, LIMITS.actionIntervalMinSec, '非发送操作间隔');

  return { ok: errors.length === 0, errors, config };
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/** 任务启动时的配置快照；运行中的配置修改不影响已启动任务。 */
export function snapshotConfig(config) {
  return deepFreeze(structuredClone(config));
}

/** 在 [min, max] 秒内取随机等待毫秒数。random 可注入以便测试。 */
export function randomDelayMs({ min, max }, random = Math.random) {
  return Math.round((min + (max - min) * random()) * 1000);
}
