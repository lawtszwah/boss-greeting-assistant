// 弹窗界面（PRD §11）。所有外部调用经注入的 api 完成，便于用模拟 API 测试。
//
// 关闭弹窗不影响任务：任务在内容脚本中运行，状态保存在后台存储里；
// 每次打开弹窗都从存储读取真实状态（AC-13）。

import { SALARY_BUCKETS, FILTER_CODES } from '../core/config.js';
import { RISK_NOTICE } from '../core/settings.js';
import { formToConfig, configToForm, NUMBER_FIELDS, ERROR_FIELD, statusText, reasonText, codeText } from './form.js';

const SEARCH_URL_RE = /^https:\/\/www\.zhipin\.com\/web\/geek\/jobs/;

function el(doc, tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function fillSelect(doc, select, options) {
  select.replaceChildren(el(doc, 'option', { value: '', textContent: '不限' }), ...options.map(([v, t]) => el(doc, 'option', { value: v, textContent: t })));
}

const fmtTime = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const LOG_TEXT = {
  started: () => '任务开始',
  navigate: (e) => `搜索关键词「${e.keyword}」`,
  contacted: (e) => `已沟通：${e.title} · ${e.company}（平台默认招呼语）`,
  skip: (e) => `跳过：${e.title ?? e.jobId ?? ''}${e.company ? ` · ${e.company}` : ''}（${codeText(e.code)}${e.detail ? `：${e.detail}` : ''}）`,
  needs_review: (e) => `待核对：${e.title} · ${e.company}（${codeText(e.reason)}）`,
  rejected: (e) => `发送失败：${e.title} · ${e.company}（${codeText(e.reason)}）`,
  pre_send_failure: (e) => `未点击：${e.jobId}（${codeText(e.error)}）`,
  no_results: (e) => `「${e.keyword}」没有结果`,
  batch_limit: (e) => `「${e.keyword}」已达批次上限`,
  search_mismatch: () => '搜索条件未生效',
  filter_mismatch: () => '筛选条件未生效',
  resolve_failed: (e) => `结果记录失败：${e.jobId}`,
  finished: (e) => `任务结束：${statusText({ status: e.status })}${e.reason ? `，${reasonText(e.reason)}` : ''}`,
  error: (e) => `错误：${e.error}`,
};
const logText = (e) => (LOG_TEXT[e.kind] ?? ((x) => x.kind))(e);

/**
 * @param {Document} doc
 * @param {object} api
 * @param {object} api.ledger @param {object} api.runs @param {object} api.settings
 * @param {object} api.logs @param {object} api.app RPC 客户端
 * @param {() => Promise<{id: number, url: string}|null>} api.getActiveTab
 * @param {(tabId: number, msg: object) => Promise<any>} api.sendToTab
 * @param {number} [api.pollMs]
 */
export async function initPopup(doc, api) {
  const $ = (id) => doc.getElementById(id);
  const form = $('settings-form');
  const ui = { tab: null, pageInfo: null, status: null, busy: false };

  const showMessage = (text, isError = false) => {
    $('message').textContent = text;
    $('message').className = `message${isError ? ' error' : ''}`;
  };

  // 下拉选项
  fillSelect(doc, form.elements.jobType, Object.keys(FILTER_CODES.jobType).map((k) => [k, k]));
  fillSelect(doc, form.elements.experience, Object.keys(FILTER_CODES.experience).map((k) => [k, k]));
  fillSelect(doc, form.elements.degree, Object.keys(FILTER_CODES.degree).map((k) => [k, k]));
  fillSelect(doc, form.elements.salaryBucket, Object.entries(SALARY_BUCKETS));

  // 风险确认（AC-20）
  $('risk-list').replaceChildren(...RISK_NOTICE.map((t) => el(doc, 'li', { textContent: t })));
  $('risk-check').addEventListener('change', () => { $('risk-confirm').disabled = !$('risk-check').checked; });
  $('show-risk').addEventListener('click', () => {
    $('risk').hidden = !$('risk').hidden;
  });

  async function refreshRisk() {
    const r = await api.settings.getRiskAck();
    $('risk').hidden = r.acknowledged;
    $('risk-check').checked = r.acknowledged;
    $('risk-check').disabled = r.acknowledged;
    $('risk-confirm').hidden = r.acknowledged;
    $('app').hidden = !r.acknowledged;
    ui.riskVersion = r.version;
    return r.acknowledged;
  }
  $('risk-confirm').addEventListener('click', async () => {
    await api.settings.ackRisk(ui.riskVersion);
    await refreshRisk();
    await refresh();
  });

  // 设置表单
  function readForm() {
    const f = {};
    for (const name of Object.keys(configToForm(null))) {
      const v = form.elements[name].value;
      f[name] = NUMBER_FIELDS.includes(name) ? (v === '' ? '' : Number(v)) : v;
    }
    return f;
  }
  function writeForm(config) {
    for (const [name, v] of Object.entries(configToForm(config))) form.elements[name].value = v;
  }
  function showErrors(errors) {
    for (const node of form.querySelectorAll('.invalid')) node.classList.remove('invalid');
    $('form-errors').replaceChildren(...errors.map((e) => el(doc, 'li', { textContent: e.message })));
    for (const e of errors) form.elements[ERROR_FIELD[e.field]]?.classList.add('invalid');
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const res = await api.settings.saveConfig(formToConfig(readForm()));
    showErrors(res.errors);
    $('saved').textContent = res.ok ? '已保存' : '';
    if (res.ok) {
      ui.savedConfig = res.config;
      writeForm(res.config);
    }
    renderButtons();
  });

  // 开始与停止
  $('start').addEventListener('click', async () => {
    if (ui.busy) return;
    ui.busy = true;
    renderButtons();
    try {
      const res = await api.settings.saveConfig(formToConfig(readForm()));
      showErrors(res.errors);
      if (!res.ok) {
        $('settings').open = true;
        showMessage(reasonText('invalid_config'), true);
        return;
      }
      ui.savedConfig = res.config;
      if (!ui.tab || !ui.pageInfo) {
        showMessage(reasonText('not_search_page'), true);
        return;
      }
      const r = await api.sendToTab(ui.tab.id, { type: 'start', config: res.config });
      if (r?.ok) showMessage('任务已开始，正在打开第一个关键词的搜索结果。关闭此弹窗不影响任务。');
      else showMessage(reasonText(r?.reason ?? 'unexpected_error'), true);
    } catch (e) {
      showMessage(`无法开始：${e?.message ?? e}`, true);
    } finally {
      ui.busy = false;
      await refresh();
    }
  });

  $('stop').addEventListener('click', async () => {
    const run = ui.status?.run;
    if (!run) return;
    await api.runs.requestStop(run.taskId);
    showMessage('已请求停止：不会再开始新的发送，正在处理的结果会照常记录。');
    await refresh();
  });

  $('tz-accept').addEventListener('click', async () => {
    await api.ledger.acceptTimeZoneChange();
    await refresh();
  });

  // 待核对
  function reviewItem(item, buttons) {
    const title = item.url
      ? el(doc, 'a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', textContent: item.title || item.jobId })
      : item.title || item.jobId;
    return el(
      doc,
      'li',
      { dataset: { jobId: item.jobId } },
      el(doc, 'div', { className: 'title' }, title),
      el(doc, 'div', { className: 'small muted', textContent: `${item.company ?? ''} · ${fmtTime(item.updatedAt ?? 0)}` }),
      el(doc, 'div', { className: 'btns' }, ...buttons),
    );
  }
  const actionButton = (label, onClick) => {
    const b = el(doc, 'button', { type: 'button', className: 'small', textContent: label });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await onClick(); } finally { await refresh(); }
    });
    return b;
  };

  function renderReview(status) {
    $('review-count').textContent = String(status.needsReview.length);
    $('review-list').replaceChildren(
      ...(status.needsReview.length
        ? status.needsReview.map((item) =>
            reviewItem(item, [
              actionButton('已沟通', () => api.ledger.reviewJob(item.jobId, 'contacted')),
              actionButton('确认未发送', () => api.ledger.reviewJob(item.jobId, 'not_sent')),
            ]))
        : [el(doc, 'li', { className: 'small muted', textContent: '没有待核对的岗位' })]),
    );
    $('not-sent-section').hidden = status.confirmedNotSent.length === 0;
    $('not-sent-count').textContent = String(status.confirmedNotSent.length);
    $('not-sent-list').replaceChildren(
      ...status.confirmedNotSent.map((item) =>
        reviewItem(item, [actionButton('重新加入后续任务', () => api.ledger.requeueJob(item.jobId))])),
    );
  }

  // 状态
  function renderButtons() {
    const running = ui.status?.run?.status === 'running';
    $('start').hidden = running;
    $('stop').hidden = !running;
    $('stop').disabled = Boolean(ui.status?.run?.stopRequested);
    $('start').disabled = ui.busy || !ui.pageInfo || Boolean(ui.pageInfo?.blocker);
  }

  function renderStatus(status) {
    const { run, quota } = status;
    const pill = $('status-pill');
    pill.textContent = run?.stopRequested && run.status === 'running' ? '停止中' : statusText(run);
    pill.dataset.status = run?.status ?? 'idle';

    const c = run?.counts ?? {};
    $('c-contacted').textContent = String(c.contacted ?? 0);
    $('c-review').textContent = String(status.needsReview.length);
    $('c-failed').textContent = String(c.failed ?? 0);
    $('c-skipped').textContent = String(c.skipped ?? 0);

    const cfg = run?.config ?? ui.savedConfig;
    $('q-session').textContent = String(run?.status === 'running' ? quota.sessionUsed : 0);
    $('q-session-max').textContent = cfg ? String(cfg.sessionLimit) : '—';
    $('q-daily').textContent = quota.dailyUsed === null ? '—' : String(quota.dailyUsed);
    $('q-daily-max').textContent = cfg ? String(cfg.dailyLimit) : '—';
    $('timezone').hidden = !quota.timeZoneChanged;

    if (run?.status === 'running') {
      const kw = run.config.keywords[run.keywordIndex];
      $('position').textContent = `关键词 ${run.keywordIndex + 1}/${run.config.keywords.length}「${kw}」· 第 ${run.batch + 1} 批`;
    } else if (run) {
      $('position').textContent = `上次任务${statusText(run)}${run.reason ? `：${reasonText(run.reason)}` : ''}`;
    } else {
      $('position').textContent = '';
    }

    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    $('storage').textContent = `本地存储 ${kb(status.storage.bytes)} / ${kb(status.storage.quota)}`;
  }

  function renderPage() {
    const info = ui.pageInfo;
    $('city').textContent = info ? `${info.cityName ?? '未知'}${info.cityCode ? `（${info.cityCode}）` : ''}` : '—';
    let warning = '';
    if (!info) warning = reasonText('not_search_page');
    else if (!info.cityCode) warning = reasonText('city_unknown');
    else if (info.blocker) warning = reasonText(`blocked_${info.blocker.kind}`);
    $('page-warning').hidden = !warning;
    $('page-warning').textContent = warning;
  }

  async function renderLogs() {
    const entries = await api.logs.list(50);
    $('log-list').replaceChildren(
      ...(entries.length
        ? entries.map((e) => el(doc, 'li', {}, el(doc, 'time', { textContent: fmtTime(e.at) }), logText(e)))
        : [el(doc, 'li', { className: 'muted', textContent: '暂无日志' })]),
    );
  }

  async function loadPage() {
    ui.tab = await api.getActiveTab();
    ui.pageInfo = null;
    if (ui.tab && SEARCH_URL_RE.test(ui.tab.url ?? '')) {
      try {
        ui.pageInfo = await api.sendToTab(ui.tab.id, { type: 'pageInfo' });
      } catch {
        ui.pageInfo = null; // 内容脚本尚未加载，例如扩展刚安装、页面未刷新。
      }
    }
  }

  async function refresh() {
    ui.status = await api.app.status();
    renderStatus(ui.status);
    renderReview(ui.status);
    renderButtons();
    await renderLogs();
  }

  // 启动
  const acknowledged = await refreshRisk();
  const saved = await api.settings.getConfig();
  ui.savedConfig = saved;
  writeForm(saved);
  if (!saved) $('settings').open = true;
  await loadPage();
  renderPage();
  if (acknowledged) await refresh();

  const pollMs = api.pollMs ?? 1000;
  const timer = pollMs ? setInterval(() => { refresh().catch(() => {}); }, pollMs) : null;
  return { refresh, stop: () => timer && clearInterval(timer), loadPage: async () => { await loadPage(); renderPage(); renderButtons(); } };
}
