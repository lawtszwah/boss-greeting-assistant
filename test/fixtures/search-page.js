// 模拟搜索页：结构仿照 docs/PAGE-ADAPTATION.md 记录的类名，岗位与公司均为虚构。
import { JSDOM } from 'jsdom';

// 模拟页面的计时器不应阻止测试进程退出。
const later = (fn, ms) => setTimeout(fn, ms).unref();

export function fakeJob(i, over = {}) {
  return {
    id: `fake${String(i).padStart(4, '0')}`,
    title: `前端工程师${i}`,
    company: `示例公司${i}`,
    experience: '3-5年',
    degree: '本科',
    ...over,
  };
}

const cardHtml = (j) => `
  <li class="job-card-box">
    <div class="job-info">
      <div class="job-title clearfix">
        <a href="/job_detail/${j.id}.html" class="job-name">${j.title}</a>
        <span class="job-salary">-K</span>
      </div>
      <ul class="tag-list"><li>${j.experience}</li><li>${j.degree}</li></ul>
    </div>
    <div class="job-card-footer">
      <a href="/gongsi/x.html" class="boss-info"><span class="boss-name">${j.company}</span></a>
      <span class="company-location">北京</span>
    </div>
  </li>`;

const filterBox = (label, selected) =>
  `<div class="condition-filter-select"><div class="current-select"><span class="placeholder-text">${label}${selected ? '(1)' : ''}</span></div></div>`;

/**
 * @param {object} opts
 * @param {object[]} opts.jobs 首批岗位
 * @param {object[][]} [opts.moreBatches] 滚动后依次追加的批次
 * @param {Record<string, boolean>} [opts.selected] 各筛选框是否显示已选
 * @param {(ctx) => void} [opts.onChat] 点击「立即沟通」时的平台行为
 * @param {string} [opts.url]
 */
export function createSearchPage({
  jobs = [],
  moreBatches = [],
  selected = {},
  onChat = greetSuccess(),
  url = 'https://www.zhipin.com/web/geek/jobs?query=%E5%89%8D%E7%AB%AF&city=101010100',
  extraHtml = '',
} = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="search-condition">
        ${filterBox('求职类型', selected.jobType)}${filterBox('薪资待遇', selected.salary)}
        ${filterBox('工作经验', selected.experience)}${filterBox('学历要求', selected.degree)}
        ${filterBox('公司规模', false)}${filterBox('融资阶段', false)}
      </div>
      <div class="dialog-wrap upload-resume-dialog" style="display:none">上传附件简历</div>
      <ul class="job-list-container">${jobs.map(cardHtml).join('')}</ul>
      <div class="loading-wait" style="display:none"></div>
      <div class="job-detail-container"></div>
      ${extraHtml}
    </body></html>`,
    { url, pretendToBeVisual: true },
  );
  const { window } = dom;
  const doc = window.document;
  const state = { clicks: [], all: [...jobs], batches: [...moreBatches], current: null, contacted: new Set() };

  const renderDetail = (j) => {
    doc.querySelector('.job-detail-container').innerHTML = `
      <div class="job-detail-box"><div class="job-detail-header">
        <div class="job-detail-op clearfix">
          <a class="op-btn op-btn-like">收藏</a>
          <a href="javascript:;" class="op-btn op-btn-chat">立即沟通</a>
        </div></div>
        <div class="job-detail-body"><a href="https://www.zhipin.com/job_detail/${j.id}.html?ka=x">查看</a></div>
      </div>`;
    doc.querySelector('.op-btn-chat').addEventListener('click', (ev) => {
      ev.preventDefault();
      state.clicks.push(j.id);
      onChat({ window, doc, job: j, state, button: ev.currentTarget });
    });
  };

  doc.querySelector('.job-list-container').addEventListener('click', (ev) => {
    const li = ev.target.closest('li.job-card-box');
    if (!li) return;
    const id = li.querySelector('a.job-name').getAttribute('href').match(/job_detail\/(\w+)\.html/)[1];
    state.current = state.all.find((j) => j.id === id);
    later(() => renderDetail(state.current), 20);
  });

  window.scrollTo = () => {
    const next = state.batches.shift();
    if (!next) return;
    const loading = doc.querySelector('.loading-wait');
    loading.style.display = '';
    later(() => {
      doc.querySelector('.job-list-container').insertAdjacentHTML('beforeend', next.map(cardHtml).join(''));
      state.all.push(...next);
      loading.style.display = 'none';
    }, 30);
  };

  return { dom, window, doc, state };
}

/** 平台行为：禁用按钮，约 40 ms 后弹出成功弹窗，约 150 ms 后自动移除。 */
export function greetSuccess({ showAfterMs = 40, removeAfterMs = 150 } = {}) {
  return ({ doc, button, job, state }) => {
    button.classList.add('is-disabled');
    later(() => {
      doc.body.insertAdjacentHTML(
        'beforeend',
        `<div class="greet-boss-dialog"><div class="greet-boss-container">
          <div class="greet-boss-header">已向BOSS发送消息</div>
          <div class="greet-boss-body"><div class="greet-con">（虚构招呼语）</div></div>
          <div class="greet-boss-footer"><a class="default-btn cancel-btn">留在此页</a><a class="default-btn sure-btn">继续沟通</a></div>
        </div></div>`,
      );
      state.contacted.add(job.id);
      const dlg = doc.querySelector('.greet-boss-dialog');
      dlg.querySelector('.cancel-btn').addEventListener('click', () => dlg.remove());
      later(() => { dlg.remove(); button.classList.remove('is-disabled'); }, removeAfterMs);
    }, showAfterMs);
  };
}

/** 平台行为：没有任何反应。 */
export const greetNothing = () => () => {};

/** 平台行为：弹出沟通上限提示。 */
export const greetLimit = () => ({ doc }) => {
  later(() => doc.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap"><p>今日沟通人数已达上限</p></div>'), 30);
};

/** 平台行为：点击后详情区切换到另一个岗位再弹窗（目标不一致）。 */
export const greetWrongTarget = () => ({ doc }) => {
  later(() => {
    doc.querySelector('.job-detail-body a').setAttribute('href', '/job_detail/other999.html');
    greetSuccess({ showAfterMs: 0 })({ doc, button: doc.querySelector('.op-btn-chat'), job: { id: 'other999' }, state: { contacted: new Set() } });
  }, 20);
};
