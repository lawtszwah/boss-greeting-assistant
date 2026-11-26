// 岗位卡片筛选（PRD §6.2）。输入是页面适配层提取出的字段，不接触 DOM。

/** 跳过原因代码。仅作用于本次任务（PRD §8「本次跳过」）。 */
export const SKIP = Object.freeze({
  PARSE_FAILED: 'parse_failed',
  KEYWORD_MISS: 'keyword_miss',
  EXCLUDED_KEYWORD: 'excluded_keyword',
  EXCLUDED_COMPANY: 'excluded_company',
  EXPERIENCE_MISMATCH: 'experience_mismatch',
  EXPERIENCE_UNDETERMINABLE: 'experience_undeterminable',
  DEGREE_MISMATCH: 'degree_mismatch',
  DEGREE_UNDETERMINABLE: 'degree_undeterminable',
});

// 卡片显示这些取值时，表示岗位对该条件没有要求，任何用户设置都接受。
const EXPERIENCE_ANY = ['经验不限', '不限'];
const DEGREE_ANY = ['学历不限', '不限'];

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

function containsAny(haystacks, needles) {
  const hs = haystacks.map(lower).filter(Boolean);
  return needles.find((n) => hs.some((h) => h.includes(lower(n))));
}

function matchEnum(value, accepted, anyValues) {
  if (accepted.length === 0) return 'pass';
  if (!nonEmpty(value)) return 'undeterminable';
  const v = lower(value);
  if (anyValues.some((a) => lower(a) === v)) return 'pass';
  return accepted.some((a) => lower(a) === v) ? 'pass' : 'fail';
}

/**
 * @param {{title?: string, company?: string, experience?: string,
 *          degree?: string, tags?: string[]}} job
 * @param {object} config 已校验的配置
 * @returns {{pass: true} | {pass: false, code: string, detail?: string}}
 */
export function evaluateJob(job, config) {
  if (!nonEmpty(job.title) || !nonEmpty(job.company)) {
    return { pass: false, code: SKIP.PARSE_FAILED, detail: '标题或公司缺失' };
  }
  const tags = Array.isArray(job.tags) ? job.tags : [];

  const excludedCompany = containsAny([job.company], config.excludeCompanies);
  if (excludedCompany) return { pass: false, code: SKIP.EXCLUDED_COMPANY, detail: excludedCompany };

  const excludedKeyword = containsAny([job.title, job.company, ...tags], config.excludeKeywords);
  if (excludedKeyword) return { pass: false, code: SKIP.EXCLUDED_KEYWORD, detail: excludedKeyword };

  if (!containsAny([job.title, ...tags], config.keywords)) {
    return { pass: false, code: SKIP.KEYWORD_MISS };
  }

  // 薪资由平台原生筛选负责，卡片薪资经字体混淆，不在此复核。

  const exp = matchEnum(job.experience, config.experiences, EXPERIENCE_ANY);
  if (exp === 'fail') return { pass: false, code: SKIP.EXPERIENCE_MISMATCH, detail: job.experience };
  if (exp === 'undeterminable') return { pass: false, code: SKIP.EXPERIENCE_UNDETERMINABLE };

  const deg = matchEnum(job.degree, config.degrees, DEGREE_ANY);
  if (deg === 'fail') return { pass: false, code: SKIP.DEGREE_MISMATCH, detail: job.degree };
  if (deg === 'undeterminable') return { pass: false, code: SKIP.DEGREE_UNDETERMINABLE };

  return { pass: true };
}

/** 去除跟踪参数和锚点，得到用于记录的岗位链接。岗位 ID 的提取规则待 H-04 核实后在页面适配层实现。 */
export function normalizeJobUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}
