// 搜索 URL 的构造与核验（PRD §6.1）。不使用页面搜索框：实测其提交可能改变城市。

import { ORIGIN, SEARCH_PATH } from './selectors.js';
import { FILTER_CODES } from '../core/config.js';

/** 把配置中的单个筛选取值映射为平台代码；不限返回 null，无法映射抛错。 */
function singleCode(kind, values) {
  if (!values || values.length === 0) return null;
  if (values.length > 1) throw new Error(`${kind} 首版只支持选择一个取值`);
  const code = FILTER_CODES[kind][values[0]];
  if (!code) throw new Error(`${kind} 取值无法对应平台筛选：${values[0]}`);
  return code;
}

/**
 * 由配置得到平台筛选参数。经验、学历、求职类型首版各只支持一个取值，
 * 以便与平台单个筛选项对应并核验（PRD §6.2 不能声称已筛选）。
 * @returns {Record<string, string>}
 */
export function filterParams(config) {
  const out = {};
  const jobType = singleCode('jobType', config.jobTypes);
  const experience = singleCode('experience', config.experiences);
  const degree = singleCode('degree', config.degrees);
  if (jobType) out.jobType = jobType;
  if (config.salaryBucket) out.salary = String(config.salaryBucket);
  if (experience) out.experience = experience;
  if (degree) out.degree = degree;
  return out;
}

export function buildSearchUrl({ keyword, cityCode, config }) {
  if (!keyword) throw new Error('keyword is required');
  if (!/^\d+$/.test(String(cityCode ?? ''))) throw new Error('cityCode is required');
  const u = new URL(SEARCH_PATH, ORIGIN);
  u.searchParams.set('query', keyword);
  u.searchParams.set('city', String(cityCode));
  for (const [k, v] of Object.entries(filterParams(config))) u.searchParams.set(k, v);
  return u.toString();
}

const CHECKED_KEYS = ['query', 'city', 'jobType', 'salary', 'experience', 'degree'];

/**
 * 核验当前页面 URL 与预期一致：关键词、城市、每个筛选参数都必须相同，
 * 多出或缺少筛选参数也算不一致。
 * @returns {{ok: true} | {ok: false, mismatches: {key: string, expected: string|null, actual: string|null}[]}}
 */
export function verifySearchUrl(actualUrl, expectedUrl) {
  let actual;
  let expected;
  try {
    actual = new URL(actualUrl);
    expected = new URL(expectedUrl);
  } catch {
    return { ok: false, mismatches: [{ key: 'url', expected: expectedUrl, actual: actualUrl }] };
  }
  const mismatches = [];
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    mismatches.push({ key: 'path', expected: expected.pathname, actual: actual.pathname });
  }
  for (const key of CHECKED_KEYS) {
    const e = expected.searchParams.get(key);
    const a = actual.searchParams.get(key);
    if (e !== a) mismatches.push({ key, expected: e, actual: a });
  }
  return mismatches.length ? { ok: false, mismatches } : { ok: true };
}
