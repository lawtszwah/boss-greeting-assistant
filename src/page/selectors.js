// 平台网页端的选择器与参数。来源：docs/PAGE-ADAPTATION.md（2026-11-26 核实）。
// 页面改版时只需更新本文件和适配说明。

export const ORIGIN = 'https://www.zhipin.com';
export const SEARCH_PATH = '/web/geek/jobs';

export const SEL = Object.freeze({
  cityLabel: '.cur-city-label',
  listContainer: '.job-list-container',
  card: 'li.job-card-box',
  cardTitleLink: 'a.job-name',
  cardInfo: '.job-info',
  cardTags: '.tag-list li',
  cardCompany: '.job-card-footer .boss-name',
  loading: '.loading-wait',
  // 无结果时没有列表容器，显示「没有找到相关职位」（2026-11-27 核实）。
  emptyBox: '.job-empty-box',

  detail: '.job-detail-container',
  detailJobLink: 'a[href*="/job_detail/"]',
  chatButton: '.job-detail-op a.op-btn-chat',

  filterBox: '.condition-filter-select',
  filterCurrent: '.current-select',

  greetDialog: '.greet-boss-dialog',
  greetHeader: '.greet-boss-header',
  greetStay: '.greet-boss-footer a.cancel-btn',

  dialogCandidates: '[class*="dialog"], [class*="modal"], [class*="popup"], [class*="layer"]',
});

export const TEXT = Object.freeze({
  chatIdle: '立即沟通',
  greetSent: '已向BOSS发送消息',
  disabledClass: 'is-disabled',
});

/** 筛选框标题；已选时显示为「标题(n)」。 */
export const FILTER_LABELS = Object.freeze({
  jobType: '求职类型',
  salary: '薪资待遇',
  experience: '工作经验',
  degree: '学历要求',
});

export { FILTER_CODES } from '../core/config.js';

// 阻断页面或弹窗的文本特征。未核实的平台提示一律按「未知弹窗」处理并暂停。
export const BLOCKER_PATTERNS = Object.freeze([
  { kind: 'captcha', re: /安全验证|滑块|拖动.*验证|请完成验证|人机验证/ },
  { kind: 'limit', re: /上限|次数已用完|沟通.*受限|操作过于频繁|频繁/ },
  { kind: 'login', re: /请先登录|登录后|扫码登录/ },
]);

export const BLOCKER_PATHS = Object.freeze([
  { kind: 'captcha', re: /\/web\/user\/safe|verify/i },
  { kind: 'login', re: /\/web\/user\/?(\?|$)|\/login/i },
]);
