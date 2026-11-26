// 岗位卡片筛选（PRD §6.2）。输入是页面适配层提取出的字段，不接触 DOM。

/** 跳过原因代码。仅作用于本次任务（PRD §8「本次跳过」）。 */
export const SKIP = Object.freeze({
  PARSE_FAILED: 'parse_failed',
  KEYWORD_MISS: 'keyword_miss',
  EXCLUDED_KEYWORD: 'excluded_keyword',
  EXCLUDED_COMPANY: 'excluded_company',
  EXPERIENCE_MISMATCH: 'experience_mismatch',
  DEGREE_MISMATCH: 'degree_mismatch',
});

/** 卡片上可能出现的学历标签（2026-11-26 核实），用于从标签中识别学历。 */
export const DEGREE_TAGS = Object.freeze(['初中及以下', '中专/中技', '高中', '大专', '本科', '硕士', '博士', '学历不限']);

/** 识别经验标签：X年、X年以内/以上、在校/应届、应届生、在校生、经验不限。实习的「天/周」「个月」不算。 */
const EXPERIENCE_TAG_RE = /^(经验不限|在校\/应届|应届生|在校生|\d+(-\d+)?年(以内|以上)?)$/;

/**
 * 按内容从卡片标签中识别经验和学历，不依赖标签顺序：
 * 实习岗位的标签为「N天/周、N个月、学历」，没有经验标签（2026-11-26 核实）。
 */
export function classifyTags(tags) {
  const list = (tags ?? []).map((t) => String(t).trim());
  return {
    experience: list.find((t) => EXPERIENCE_TAG_RE.test(t)) ?? '',
    degree: list.find((t) => DEGREE_TAGS.includes(t)) ?? '',
  };
}

// 卡片显示这些取值时，表示岗位对该条件没有要求，任何用户设置都接受。
const EXPERIENCE_ANY = ['经验不限'];
const DEGREE_ANY = ['学历不限'];

/**
 * 平台筛选项与卡片显示文本不一致的情况（2026-11-26 核实）：
 * 筛选「应届生」或「在校生」时，卡片显示「在校/应届」。
 */
const EXPERIENCE_ALIASES = Object.freeze({
  应届生: ['应届生', '在校/应届'],
  在校生: ['在校生', '在校/应届'],
});

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

function containsAny(haystacks, needles) {
  const hs = haystacks.map(lower).filter(Boolean);
  return needles.find((n) => hs.some((h) => h.includes(lower(n))));
}

/**
 * 卡片复核：只拦下明确冲突的值。卡片上没有对应标签时放行，
 * 因为该条件已由平台原生筛选应用，并在开始处理前核验过 URL 参数和筛选框状态（PRD §6.2）。
 */
function matchEnum(value, accepted, anyValues, aliases = {}) {
  if (accepted.length === 0 || !nonEmpty(value)) return 'pass';
  const v = lower(value);
  if (anyValues.some((a) => lower(a) === v)) return 'pass';
  return accepted.some((a) => (aliases[a] ?? [a]).some((x) => lower(x) === v)) ? 'pass' : 'fail';
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

  if (matchEnum(job.experience, config.experiences, EXPERIENCE_ANY, EXPERIENCE_ALIASES) === 'fail') {
    return { pass: false, code: SKIP.EXPERIENCE_MISMATCH, detail: job.experience };
  }
  if (matchEnum(job.degree, config.degrees, DEGREE_ANY) === 'fail') {
    return { pass: false, code: SKIP.DEGREE_MISMATCH, detail: job.degree };
  }

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
