// 设置表单与配置对象之间的转换。纯函数，不接触 DOM。

import { DEFAULT_CONFIG } from '../core/config.js';

const lines = (v) => String(v ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
const one = (v) => (v ? [v] : []);

/** 把表单值（字符串字典）转换为配置输入，交给 validateConfig 校验。 */
export function formToConfig(f) {
  return {
    keywords: lines(f.keywords),
    jobTypes: one(f.jobType),
    experiences: one(f.experience),
    degrees: one(f.degree),
    salaryBucket: f.salaryBucket || null,
    excludeKeywords: lines(f.excludeKeywords),
    excludeCompanies: lines(f.excludeCompanies),
    sessionLimit: f.sessionLimit,
    dailyLimit: f.dailyLimit,
    sendIntervalSec: { min: f.sendIntervalMin, max: f.sendIntervalMax },
    actionIntervalSec: { min: f.actionIntervalMin, max: f.actionIntervalMax },
    maxBatchesPerKeyword: f.maxBatchesPerKeyword,
  };
}

/** 把已保存的配置转换为表单值；没有保存过时使用默认值。 */
export function configToForm(config) {
  const c = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  return {
    keywords: c.keywords.join('\n'),
    jobType: c.jobTypes[0] ?? '',
    experience: c.experiences[0] ?? '',
    degree: c.degrees[0] ?? '',
    salaryBucket: c.salaryBucket ?? '',
    excludeKeywords: c.excludeKeywords.join('\n'),
    excludeCompanies: c.excludeCompanies.join('\n'),
    sessionLimit: String(c.sessionLimit),
    dailyLimit: String(c.dailyLimit),
    sendIntervalMin: String(c.sendIntervalSec.min),
    sendIntervalMax: String(c.sendIntervalSec.max),
    actionIntervalMin: String(c.actionIntervalSec.min),
    actionIntervalMax: String(c.actionIntervalSec.max),
    maxBatchesPerKeyword: String(c.maxBatchesPerKeyword),
  };
}

/** 数字字段：空串保持为空串，交给校验报错；其余转为数字。 */
export const NUMBER_FIELDS = Object.freeze([
  'sessionLimit',
  'dailyLimit',
  'sendIntervalMin',
  'sendIntervalMax',
  'actionIntervalMin',
  'actionIntervalMax',
  'maxBatchesPerKeyword',
]);

/** 配置校验错误的字段 → 表单字段名。 */
export const ERROR_FIELD = Object.freeze({
  keywords: 'keywords',
  jobTypes: 'jobType',
  experiences: 'experience',
  degrees: 'degree',
  salaryBucket: 'salaryBucket',
  sessionLimit: 'sessionLimit',
  dailyLimit: 'dailyLimit',
  sendIntervalSec: 'sendIntervalMin',
  actionIntervalSec: 'actionIntervalMin',
  maxBatchesPerKeyword: 'maxBatchesPerKeyword',
});

const STATUS_TEXT = {
  running: '运行中',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
};

export const statusText = (run) => (run ? STATUS_TEXT[run.status] ?? run.status : '未运行');

const REASON_TEXT = {
  user_stop: '你点击了停止',
  all_keywords_done: '全部关键词已处理完',
  session_limit_reached: '已达到本次发送上限',
  daily_limit_reached: '已达到当日发送上限',
  timezone_changed: '时区发生变化，请核对当日额度',
  storage_low: '本地存储空间不足',
  storage_error: '无法保存记录，已停止发送',
  lock_not_held: '任务锁已失效',
  lock_lost: '任务锁丢失，结果不明的岗位已转为待核对',
  lock_held: '已有任务在其他标签页运行',
  list_timeout: '岗位列表加载超时',
  search_not_applied: '搜索关键词或城市未按设置生效',
  filter_not_applied: '筛选条件未按设置生效',
  list_stalled: '加载更多岗位没有进展',
  consecutive_parse_failures: '连续 3 个岗位解析失败，页面可能已改版',
  send_unverified: '点击后未看到发送成功提示，已转为待核对',
  platform_limit: '平台提示沟通受限',
  greet_dialog_stuck: '发送成功提示未能关闭',
  page_reloaded: '页面被刷新或手动跳转，任务不会自动继续',
  nav_token_expired: '页面加载超时，任务不会自动继续',
  unexpected_url: '页面不是预期的搜索结果，任务不会自动继续',
  interrupted: '页面关闭或浏览器退出，任务已中断',
  unexpected_error: '发生未预期的错误',
  blocked_captcha: '出现验证码，请在平台完成验证',
  blocked_limit: '平台提示访问或沟通受限',
  blocked_login: '登录已失效，请在平台重新登录',
  blocked_unknown_dialog: '出现无法识别的弹窗，请在平台上处理',
  risk_not_acknowledged: '请先阅读并确认风险说明',
  invalid_config: '设置有误，请检查',
  city_unknown: '无法确认当前城市，请在搜索页选择城市',
  not_search_page: '请先打开 BOSS 直聘的岗位搜索页',
};

export const reasonText = (code) => (code ? REASON_TEXT[code] ?? code : '');

const CODE_TEXT = {
  parse_failed: '解析失败',
  keyword_miss: '标题和标签不含关键词',
  excluded_keyword: '命中排除关键词',
  excluded_company: '命中排除公司',
  experience_mismatch: '经验不符',
  experience_undeterminable: '经验无法判定',
  degree_mismatch: '学历不符',
  degree_undeterminable: '学历无法判定',
  contacted: '已沟通过',
  needs_review: '待核对中',
  confirmed_not_sent: '已确认未发送，未重新加入',
  recruiter_already_contacted_in_task: '本次已联系过该招聘者',
  pre_send_retry_exhausted: '点击前多次失败',
  missing_job_id: '缺少岗位 ID',
  no_greet_dialog: '未出现发送成功提示',
  target_changed_after_click: '点击后岗位发生变化',
  target_changed_before_click: '点击前岗位发生变化',
  navigated_after_click: '点击后页面跳转',
  detail_not_switched: '详情未切换到该岗位',
  chat_button_disabled: '沟通按钮不可用',
};

/** 跳过原因、待核对原因等代码的中文说明；未知代码原样返回。 */
export const codeText = (code) => (code ? CODE_TEXT[code] ?? (code.startsWith('blocked_') ? reasonText(code) : code) : '');
