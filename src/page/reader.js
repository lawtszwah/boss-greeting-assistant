// 页面读取：只读 DOM，不点击、不修改页面。所有函数接收 document，便于用模拟页面测试。

import { SEL, TEXT, FILTER_LABELS, BLOCKER_PATTERNS, BLOCKER_PATHS } from './selectors.js';
import { classifyTags } from '../core/filter.js';

const JOB_ID_RE = /\/job_detail\/([A-Za-z0-9_~-]+)\.html/;

export function jobIdFromHref(href) {
  return typeof href === 'string' ? href.match(JOB_ID_RE)?.[1] ?? null : null;
}

const text = (el) => (el?.textContent ?? '').trim();

/** 元素及其祖先均未被隐藏。jsdom 不做布局，因此只看样式与 hidden 属性。 */
export function isVisible(el) {
  const win = el?.ownerDocument?.defaultView;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hidden) return false;
    const cs = win?.getComputedStyle(node);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
  }
  return Boolean(el);
}

/**
 * 读取当前已加载的全部岗位卡片。薪资不读取（字体混淆，见 PRD §6.2）。
 * @returns {{jobId: string|null, url: string|null, title: string, company: string,
 *            experience: string, degree: string, tags: string[], element: Element}[]}
 */
export function readCards(doc) {
  return [...doc.querySelectorAll(SEL.card)].map((li) => {
    const link = li.querySelector(SEL.cardTitleLink);
    const href = link?.getAttribute('href') ?? null;
    const tags = [...li.querySelectorAll(SEL.cardTags)].map(text).filter(Boolean);
    const { experience, degree } = classifyTags(tags);
    return {
      jobId: jobIdFromHref(href),
      url: href ? new URL(href, doc.baseURI).toString().replace(/[?#].*$/, '') : null,
      title: text(link),
      company: text(li.querySelector(SEL.cardCompany)),
      experience,
      degree,
      tags,
      element: li,
    };
  });
}

/** 读取右侧详情区：当前岗位 ID 与沟通按钮状态。 */
export function readDetail(doc) {
  const detail = doc.querySelector(SEL.detail);
  if (!detail) return { present: false, jobId: null, button: null };
  const jobId = jobIdFromHref(detail.querySelector(SEL.detailJobLink)?.getAttribute('href'));
  const btn = detail.querySelector(SEL.chatButton);
  return {
    present: true,
    jobId,
    button: btn
      ? {
          element: btn,
          text: text(btn),
          disabled: btn.classList.contains(TEXT.disabledClass),
          idle: text(btn) === TEXT.chatIdle && !btn.classList.contains(TEXT.disabledClass),
        }
      : null,
  };
}

/** 读取各筛选框的显示文本，判断是否显示已选「标题(n)」。 */
export function readFilterState(doc) {
  const state = {};
  const labels = [...doc.querySelectorAll(`${SEL.filterBox} ${SEL.filterCurrent}`)].map(text);
  for (const [kind, label] of Object.entries(FILTER_LABELS)) {
    const shown = labels.find((l) => l.startsWith(label));
    state[kind] = shown === undefined ? 'missing' : /\(\d+\)$/.test(shown) ? 'selected' : 'none';
  }
  return state;
}

/**
 * 核验筛选框的显示与预期参数一致：设置了的必须显示已选，未设置的必须未选。
 * @param {Record<string, string>} expectedParams filterParams() 的结果
 */
export function verifyFilterState(doc, expectedParams) {
  const state = readFilterState(doc);
  const problems = [];
  for (const kind of Object.keys(FILTER_LABELS)) {
    const want = expectedParams[kind] ? 'selected' : 'none';
    if (state[kind] === 'missing') {
      if (want === 'selected') problems.push({ kind, expected: want, actual: 'missing' });
    } else if (state[kind] !== want) {
      problems.push({ kind, expected: want, actual: state[kind] });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

const KNOWN_DIALOG = (el) => el.closest(SEL.greetDialog);

/**
 * 检测阻断：验证码、访问限制、登录失效页面，以及任何可见的未知弹窗。
 * @returns {null | {kind: 'captcha'|'limit'|'login'|'unknown_dialog', detail: string}}
 */
export function detectBlocker(doc) {
  const path = doc.defaultView?.location?.pathname ?? '';
  for (const { kind, re } of BLOCKER_PATHS) if (re.test(path)) return { kind, detail: path };

  for (const el of doc.querySelectorAll(SEL.dialogCandidates)) {
    if (!isVisible(el) || KNOWN_DIALOG(el)) continue;
    // 只看最外层的可见弹窗，避免把同一弹窗的子元素重复上报。
    const outer = el.parentElement?.closest(SEL.dialogCandidates);
    if (outer && isVisible(outer)) continue;
    const t = text(el);
    if (!t) continue;
    for (const { kind, re } of BLOCKER_PATTERNS) if (re.test(t)) return { kind, detail: t.slice(0, 80) };
    return { kind: 'unknown_dialog', detail: t.slice(0, 80) };
  }

  const bodyText = text(doc.body);
  if (!doc.querySelector(SEL.listContainer)) {
    for (const { kind, re } of BLOCKER_PATTERNS) if (re.test(bodyText)) return { kind, detail: 'page' };
  }
  return null;
}

/** 列表状态：ready（有卡片）、empty（显示无结果，或容器在但无卡片且不在加载）、loading。 */
export function listStatus(doc) {
  const container = doc.querySelector(SEL.listContainer);
  if (container?.querySelector(SEL.card)) return 'ready';
  const emptyBox = doc.querySelector(SEL.emptyBox);
  if (emptyBox && isVisible(emptyBox)) return 'empty';
  if (!container) return 'loading';
  if (container.querySelector(SEL.card)) return 'ready';
  const loading = doc.querySelector(SEL.loading);
  return loading && isVisible(loading) ? 'loading' : 'empty';
}

/** 页面上显示的当前城市名，读不到时返回 null。 */
export function readCityName(doc) {
  return text(doc.querySelector(SEL.cityLabel)) || null;
}
