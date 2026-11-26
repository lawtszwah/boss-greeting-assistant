// 薪资解析与区间判断（PRD §6.2）。只认月薪；日薪、时薪、年薪、面议一律无法判定。

const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '(k|千|w|万)';
const NON_MONTHLY = /(元\s*\/\s*(天|日|时|小时|周|月)|\/\s*(天|日|时|小时|年)|日薪|时薪|年薪|每天|每小时|万\s*\/\s*年)/i;

const RANGE = new RegExp(`^${NUM}\\s*${UNIT}?\\s*[-~～—–至到]\\s*${NUM}\\s*${UNIT}$`, 'i');
const SINGLE = new RegExp(`^${NUM}\\s*${UNIT}$`, 'i');
const BELOW = new RegExp(`^${NUM}\\s*${UNIT}\\s*(以下|及以下)$`, 'i');
const ABOVE = new RegExp(`^${NUM}\\s*${UNIT}\\s*(以上|及以上|起)$`, 'i');

function toK(value, unit) {
  const n = Number(value);
  const u = (unit || '').toLowerCase();
  return u === 'w' || u === '万' ? n * 10 : n;
}

/** 去掉额外薪数（如「·13薪」），它不参与月薪判断。 */
function stripBonusMonths(text) {
  return text.replace(/[·•・]\s*\d+\s*薪/g, '').trim();
}

/**
 * 解析卡片上的薪资文本。
 * @returns {{kind: 'monthly', minK: number, maxK: number} | {kind: 'unknown', reason: string}}
 *   maxK 为 Infinity 表示「以上」。
 */
export function parseSalary(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'unknown', reason: 'missing' };
  const text = raw.trim().replace(/\s+/g, '');
  if (/面议/.test(text)) return { kind: 'unknown', reason: 'negotiable' };
  if (NON_MONTHLY.test(text)) return { kind: 'unknown', reason: 'not_monthly' };

  const t = stripBonusMonths(text);
  let m;
  if ((m = t.match(BELOW))) return { kind: 'monthly', minK: 0, maxK: toK(m[1], m[2]) };
  if ((m = t.match(ABOVE))) return { kind: 'monthly', minK: toK(m[1], m[2]), maxK: Infinity };
  if ((m = t.match(RANGE))) {
    // 「10-20K」前半段省略单位时沿用后半段单位。
    const minK = toK(m[1], m[2] || m[4]);
    const maxK = toK(m[3], m[4]);
    if (minK > maxK) return { kind: 'unknown', reason: 'unparsable' };
    return { kind: 'monthly', minK, maxK };
  }
  if ((m = t.match(SINGLE))) {
    const k = toK(m[1], m[2]);
    return { kind: 'monthly', minK: k, maxK: k };
  }
  return { kind: 'unknown', reason: 'unparsable' };
}

/**
 * 判断岗位薪资是否与用户设置的月薪区间有交集（含端点）。
 * @returns {'pass' | 'fail' | 'undeterminable'}
 */
export function matchSalary(salaryText, salaryMinK, salaryMaxK) {
  if (salaryMinK === null && salaryMaxK === null) return 'pass';
  const parsed = parseSalary(salaryText);
  if (parsed.kind !== 'monthly') return 'undeterminable';
  const lo = salaryMinK ?? 0;
  const hi = salaryMaxK ?? Infinity;
  return parsed.minK <= hi && parsed.maxK >= lo ? 'pass' : 'fail';
}
