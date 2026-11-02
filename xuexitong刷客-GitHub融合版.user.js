// ==UserScript==
// @name         学习通刷课助手（顺序播放外观 + GitHub 逻辑）
// @namespace    cx-auto-study.merged
// @version      3.0.0
// @description  外观为「顺序播放」深色小面板；核心逻辑抓自 GitHub 开源项目 DaRin1403/xuexitong-autostudy（MIT），并参考 Flyer2333/xuexitong-ai-assistant、Xiongxiangyu2778/chaoxing-auto-study、zhu-hailin/chaoxing-ai-assistant 的任务点完成判据与栏目遍历思路：自动完成视频/音频/文档/图片任务点、多视频连播、完成状态校验、自动进入下一节；默认原速、跳过测验、不答题；人脸/滑块验证自动暂停。
// @author       DaRin1403（逻辑，MIT）· 本地（外观整合）
// @license      MIT
// @homepageURL  https://github.com/DaRin1403/xuexitong-autostudy
// @match        *://*.chaoxing.com/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      api.deepseek.com
// @connect      cdn.jsdelivr.net
// @noframes
// ==/UserScript==
//
// 说明：
//   引擎逻辑来自 GitHub 项目 DaRin1403/xuexitong-autostudy（MIT 许可）。
//   本文件在其基础上换了「顺序播放」面板外观，并按需求调整了默认项：
//     · 原速播放（1x），不静音以外的加速
//     · 章节测验默认跳过，不答题、不交卷
//     · 任务点完成判据补充了 .ans-job-icon[aria-label="任务点已完成"]
//     · 处理完所有任务点后再进入下一节；面板可随时停止/启动
//   仅供个人学习研究，使用风险自负。

(function () {
  'use strict';

  /* ==================== 配置 ==================== */
  // 逻辑来源：https://github.com/DaRin1403/xuexitong-autostudy （MIT）
  // 默认值按「原速、只刷任务点、不答题」调整过。
  const DEFAULT_CONFIG = {
    speed: 1,                // 视频倍速：1 = 原速（默认，最稳）；可调 1~2
    autoVideo: true,         // 视频任务点
    autoAudio: true,         // 音频任务点
    autoDocs: true,          // 文档 / PPT / PDF 任务点
    autoImage: true,         // 图片任务点
    autoWork: false,         // 章节测验 / 学习检测：默认关（不答题、不交卷）
    autoSubmit: false,       // 自动交卷：始终关闭
    autoJump: true,          // 本节任务点完成后自动进入下一节
    answerIntervalMin: 0,
    answerIntervalMax: 0,
    submitDelayMin: 0,
    submitDelayMax: 0,
    minAccuracy: 0.6,
    quizDelayMin: 0,
    quizDelayMax: 0,
    dailyLimitMinutes: 0,    // 每日刷课时长上限（分钟），0 = 不限
    deliberateErrorRate: 0,
    aiEnabled: false,
    aiKey: '',
    aiUrl: 'https://api.deepseek.com/v1/chat/completions',
    aiModel: 'deepseek-reasoner',
    useTiku: false,
    reportUrl: '',           // 调试用，留空关闭
  };

  function loadConfig() {
    try {
      const saved = (typeof GM_getValue !== 'undefined')
        ? GM_getValue('cxConfig', null)
        : JSON.parse(localStorage.getItem('cxConfig') || 'null');
      if (saved && typeof saved === 'object') return Object.assign({}, DEFAULT_CONFIG, saved);
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULT_CONFIG);
  }
  function saveConfig(cfg) {
    try {
      if (typeof GM_setValue !== 'undefined') GM_setValue('cxConfig', cfg);
      else localStorage.setItem('cxConfig', JSON.stringify(cfg));
    } catch (e) { /* ignore */ }
  }
  let CONFIG = loadConfig();
  // 强制项：测验不自动做、不自动交卷；倍速限制在 1~2。
  CONFIG.autoWork = false;
  CONFIG.autoSubmit = false;
  if (!(CONFIG.speed >= 1)) CONFIG.speed = 1;
  if (CONFIG.speed > 2) CONFIG.speed = 2;
  // 第一次运行融合版时把倍速重置为原速 1x（之后用户可在 ⚙ 里自己改）
  try {
    if (!CONFIG.mergedV3) {
      CONFIG.speed = 1;
      CONFIG.mergedV3 = true;
      saveConfig(CONFIG);
    }
  } catch (e) { /* ignore */ }

  /* 题目收集器:做过的题(题干+选项+答案)自动积累,导出后交给 AI 整理成考前手册 */
  let COLLECTED = [];
  try {
    COLLECTED = (typeof GM_getValue !== 'undefined')
      ? GM_getValue('cxQuestions', [])
      : JSON.parse(localStorage.getItem('cxQuestions') || '[]');
    if (!Array.isArray(COLLECTED)) COLLECTED = [];
  } catch (e) { COLLECTED = []; }
  function recordQuestion(q, answer) {
    try {
      COLLECTED.push({ q: q.question, t: String(q.type), o: (q.options || []).join('§'), a: (answer || []).join('|') });
      if (COLLECTED.length > 5000) COLLECTED = COLLECTED.slice(-5000);
      if (typeof GM_setValue !== 'undefined') GM_setValue('cxQuestions', COLLECTED);
      else localStorage.setItem('cxQuestions', JSON.stringify(COLLECTED));
    } catch (e) { /* ignore */ }
  }
  function exportQuestions() {
    if (!COLLECTED.length) { log('📋 还没有收集到题目(做完学习检测/弹题后自动收集)', 'warn'); return; }
    const data = JSON.stringify(COLLECTED);
    const done = () => log(`📋 已导出 ${COLLECTED.length} 道题,全选复制发给 AI 助手`, 'ok');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data).then(done).catch(() => { showExportBox(data); });
      } else showExportBox(data);
    } catch (e) { showExportBox(data); }
  }
  function showExportBox(data) {
    const ta = document.createElement('textarea');
    ta.value = data;
    ta.style.cssText = 'position:fixed;left:16px;bottom:16px;width:460px;height:220px;z-index:2147483647;background:rgba(255,255,255,0.95);color:#3b3b43;border:1px solid rgba(255,255,255,0.6);border-radius:8px;padding:8px;font:12px monospace;box-shadow:0 8px 32px rgba(160,60,120,0.22)';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    ta.addEventListener('blur', () => { try { ta.remove(); } catch (e) {} });
    log('📋 题目数据已生成在左下角文本框,全选(Ctrl+A)复制后发给 AI 助手', 'ok');
  }

  /* ==================== 工具函数 ==================== */
  const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
  const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

  function waitElementLoaded(win, selector, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        try {
          if (win.document.querySelector(selector)) { clearInterval(timer); resolve(); return; }
        } catch (e) { /* iframe 未就绪 */ }
        if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('等待元素超时: ' + selector)); }
      }, 200);
    });
  }

  function waitIframeLoaded(iframe, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        try {
          if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') { clearInterval(timer); resolve(); return; }
        } catch (e) { /* ignore */ }
        if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('iframe 加载超时')); }
      }, 200);
    });
  }

  // HTML 转纯文本(保留 img/sub/sup/br)
  function clean(html) {
    if (html == null) return '';
    return String(html)
      .replace(/<((?!img|sub|sup|br)[^>]+)>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .trim();
  }
  // 去题型前缀【单选题】和分值后缀(2.0分)
  const cl = (str) => String(str).replace(/^【.*?】\s*/, '').replace(/\s*（\d+(\.\d+)?分）$/, '');

  // 跨域请求:油猴环境用 GM_xmlhttpRequest,普通环境降级 fetch
  function cxFetch(url, { method = 'GET', data = null, headers = {}, timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method, url, data, headers, timeout,
          onload: (res) => resolve(res.responseText),
          onerror: (err) => reject(err),
          ontimeout: () => reject(new Error('timeout'))
        });
      } else {
        fetch(url, { method, headers, body: data }).then((r) => r.text()).then(resolve).catch(reject);
      }
    });
  }

  /* ==================== 顺序播放面板（外观） ==================== */
  // 面板样式沿用本地「顺序播放」脚本：深色小面板、启动/停止、状态行、进度条、最近日志。
  // 下面只负责“外观 + 启停”，任务逻辑仍然是 GitHub 那套。

  const panelState = {
    status: '已停止。点“启动”开始。',
    note: '',
    progress: null,      // 0~100
    logs: [],            // { line, level }
  };
  const logLines = panelState.logs;   // 兼容原脚本里的状态上报
  let panelEls = null;
  let PAUSED = false;                  // 由「启动 / 停止」控制
  let lastRunAt = 0;                   // 上一次 chapterLoop 的启动时间（兜底轮询用）
  const RUN_KEY = 'cxRunEnabled';

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function renderPanel() {
    if (!panelEls) return;
    panelEls.status.textContent = panelState.status + (panelState.note ? '\n' + panelState.note : '');
    panelEls.btn.textContent = PAUSED ? '启动' : '停止';
    panelEls.btn.style.background = PAUSED ? '#3a4256' : '#2f6f4f';
    const pct = typeof panelState.progress === 'number'
      ? Math.max(0, Math.min(100, panelState.progress))
      : 0;
    panelEls.bar.style.width = pct + '%';
    const lines = panelState.logs.slice(-4).map((l) => {
      const color = l.level === 'ok' ? '#7ee787'
        : l.level === 'warn' ? '#f0b72f'
        : l.level === 'err' ? '#f85149' : '#9fb3c8';
      return '<div style="color:' + color + '">' + escHtml(l.line) + '</div>';
    });
    panelEls.logs.innerHTML = lines.join('');
    panelEls.logs.scrollTop = panelEls.logs.scrollHeight;
  }

  function setStatus(text, note) {
    panelState.status = text == null ? '' : String(text);
    if (typeof note !== 'undefined') panelState.note = note || '';
    renderPanel();
  }

  function log(msg, level = 'info') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = '[' + time + '] ' + msg;
    const color = level === 'ok' ? '#7ee787'
      : level === 'warn' ? '#f0b72f'
      : level === 'err' ? '#f85149' : '#58a6ff';
    try { console.log('%c[顺序播放] ' + line, 'color:' + color); } catch (e) { /* ignore */ }
    panelState.logs.push({ line: msg, level });
    if (panelState.logs.length > 60) panelState.logs.shift();
    renderPanel();
    try { scheduleReport(); } catch (e) { /* ignore */ }
  }

  function mkPanelBtn(text, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (title) b.title = title;
    b.style.cssText = 'font:inherit;font-size:11px;border:0;border-radius:6px;padding:3px 8px;cursor:pointer;background:#3a4256;color:#e6e9ef;line-height:1.4';
    return b;
  }

  function initPanel() {
    if (panelEls) return;
    const box = document.createElement('div');
    box.className = 'xt-seq-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:250px;box-sizing:border-box;' +
      'background:#1f2430;color:#e6e9ef;border-radius:10px;padding:10px 12px;' +
      'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35)';

    const hd = document.createElement('div');
    hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px';

    const title = document.createElement('span');
    title.textContent = '顺序播放';
    title.title = '按住可拖动面板';
    title.style.cssText = 'font-weight:600;cursor:move;user-select:none';

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:4px;align-items:center';
    const btn = mkPanelBtn('启动', '启动 / 停止');
    const gear = mkPanelBtn('⚙', '设置');
    const toggle = mkPanelBtn('▼', '展开 / 收起日志');
    right.appendChild(btn);
    right.appendChild(gear);
    right.appendChild(toggle);
    hd.appendChild(title);
    hd.appendChild(right);

    const status = document.createElement('div');
    status.style.cssText = 'opacity:.9;white-space:pre-wrap;word-break:break-word;min-height:2.6em';

    const barOuter = document.createElement('div');
    barOuter.style.cssText = 'height:4px;background:#3a4256;border-radius:2px;margin-top:7px;overflow:hidden';
    const bar = document.createElement('i');
    bar.style.cssText = 'display:block;height:100%;width:0;background:#5b9dd9;transition:width .3s';
    barOuter.appendChild(bar);

    const logs = document.createElement('div');
    logs.style.cssText = 'margin-top:8px;max-height:72px;overflow-y:auto;font-size:11px;line-height:1.5;' +
      'border-top:1px solid #2c3446;padding-top:6px;display:block';

    box.appendChild(hd);
    box.appendChild(status);
    box.appendChild(barOuter);
    box.appendChild(logs);

    // 拖动面板（按住标题栏空白处）
    let drag = null;
    hd.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      const r = box.getBoundingClientRect();
      drag = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top };
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    });
    document.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      box.style.left = (drag.left + ev.clientX - drag.x) + 'px';
      box.style.top = (drag.top + ev.clientY - drag.y) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = null; });

    btn.addEventListener('click', togglePause);
    gear.addEventListener('click', showConfigUI);
    toggle.addEventListener('click', () => {
      const hidden = logs.style.display === 'none';
      logs.style.display = hidden ? 'block' : 'none';
      toggle.textContent = hidden ? '▼' : '▲';
    });

    (document.body || document.documentElement).appendChild(box);
    panelEls = { box, btn, gear, toggle, status, bar, logs };
    renderPanel();
  }

  function togglePause() {
    PAUSED = !PAUSED;
    try {
      if (typeof GM_setValue !== 'undefined') GM_setValue(RUN_KEY, !PAUSED);
    } catch (e) { /* ignore */ }
    if (PAUSED) {
      log('⏸ 已停止：当前任务处理完不再继续', 'warn');
      setStatus('已停止。点“启动”开始。');
    } else {
      log('▶ 已启动', 'ok');
      setStatus('运行中…');
      lastRunAt = 0;   // 让 startWatch 的兜底轮询马上跑一轮
    }
    renderPanel();
  }

  function showConfigUI() {
    const old = document.getElementById('xtCfgPanel');
    if (old) { old.remove(); return; }
    const p = document.createElement('div');
    p.id = 'xtCfgPanel';
    p.style.cssText = 'position:fixed;right:16px;bottom:310px;z-index:2147483647;width:300px;box-sizing:border-box;' +
      'background:#1f2430;color:#e6e9ef;border:1px solid #2c3446;border-radius:10px;padding:12px;' +
      'font:12px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';

    const rows = [
      ['视频倍速', '<input id="xtSpeed" type="number" min="1" max="2" step="0.25" value="' + CONFIG.speed + '">', '1 = 原速最稳；2 = 最快、风控风险最高'],
      ['自动切下一节', '<label><input id="xtJump" type="checkbox" ' + (CONFIG.autoJump ? 'checked' : '') + '> 开启</label>', '本节任务点都完成后自动进入下一节'],
      ['处理文档/PPT', '<label><input id="xtDocs" type="checkbox" ' + (CONFIG.autoDocs ? 'checked' : '') + '> 开启</label>', '教材、PPT、PDF 任务点自动滚到底'],
      ['处理音频/图片', '<label><input id="xtAudio" type="checkbox" ' + (CONFIG.autoAudio ? 'checked' : '') + '> 开启</label>', '音频、图片任务点自动处理'],
      ['自动刷题', '<label><input id="xtWork" type="checkbox" disabled> 本版不启用</label>', '本版不刷题：测验任务点直接跳过，不答题、不交卷，留给你自己处理'],
      ['每日上限（分钟）', '<input id="xtDaily" type="number" min="0" step="30" value="' + CONFIG.dailyLimitMinutes + '">', '0 = 不限'],
      ['状态上报地址（调试）', '<input id="xtReport" type="text" value="' + escHtml(CONFIG.reportUrl) + '" placeholder="留空关闭">', '只发往你自己填的本机地址'],
    ];
    let html = '<div style="font-weight:600;margin-bottom:8px">顺序播放 · 设置</div>';
    for (const r of rows) {
      html += '<div style="margin:8px 0;border-bottom:1px solid #2c3446;padding-bottom:8px">' +
        '<div style="font-weight:600">' + r[0] + '</div>' + r[1] +
        '<div style="font-size:11px;color:#8a97a8;margin-top:3px;line-height:1.5">' + r[2] + '</div></div>';
    }
    html += '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">' +
      '<button id="xtCfgClose" type="button">关闭</button>' +
      '<button id="xtCfgSave" type="button">保存</button></div>';
    p.innerHTML = html;
    document.body.appendChild(p);
    const inputs = p.querySelectorAll('input');
    for (const i of inputs) {
      i.style.cssText = 'box-sizing:border-box;background:#2c3446;color:#e6e9ef;border:1px solid #3a4256;border-radius:6px;padding:3px 6px;font:inherit';
      if (i.type === 'text') i.style.width = '100%';
      if (i.type === 'number') i.style.width = '80px';
    }
    const btns = p.querySelectorAll('button');
    for (const b of btns) {
      b.style.cssText = 'font:inherit;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;background:#3a4256;color:#e6e9ef';
    }
    document.getElementById('xtCfgSave').addEventListener('click', () => {
      CONFIG.speed = parseFloat(document.getElementById('xtSpeed').value) || 1;
      if (CONFIG.speed < 1) CONFIG.speed = 1;
      if (CONFIG.speed > 2) CONFIG.speed = 2;
      CONFIG.autoJump = document.getElementById('xtJump').checked;
      CONFIG.autoDocs = document.getElementById('xtDocs').checked;
      CONFIG.autoImage = document.getElementById('xtAudio').checked;
      CONFIG.autoAudio = document.getElementById('xtAudio').checked;
      CONFIG.autoWork = false;  // 固定不答题
      CONFIG.autoSubmit = false;
      CONFIG.dailyLimitMinutes = parseFloat(document.getElementById('xtDaily').value) || 0;
      CONFIG.reportUrl = document.getElementById('xtReport').value.trim();
      saveConfig(CONFIG);
      log('设置已保存（倍速 ' + CONFIG.speed + 'x）', 'ok');
      p.remove();
    });
    document.getElementById('xtCfgClose').addEventListener('click', () => p.remove());
  }


  /* ==================== 状态上报（原脚本保留，留空关闭） ==================== */
  let lastReportAt = 0;
  let reportTimer = null;

  function scriptVersion() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) return GM_info.script.version;
    } catch (e) { /* ignore */ }
    return '3.0.0';
  }

  function buildSnapshot() {
    let v = null;
    try { v = document.querySelector('video'); } catch (e) { /* ignore */ }
    return {
      at: Date.now(),
      time: new Date().toLocaleString('zh-CN'),
      version: scriptVersion(),
      url: location.href,
      title: document.title,
      status: panelState.status + (panelState.note ? ' ' + panelState.note : ''),
      config: { speed: CONFIG.speed, autoJump: CONFIG.autoJump, autoWork: CONFIG.autoWork },
      video: v ? {
        cur: Math.round(v.currentTime), dur: Math.round(v.duration) || null,
        rate: v.playbackRate, paused: v.paused, muted: v.muted
      } : null,
      logs: logLines.slice(-25).map((l) => l.line),
    };
  }

  function pushReport(force) {
    const url = String(CONFIG.reportUrl || '').trim();
    if (!url) return;
    const now = Date.now();
    if (!force && now - lastReportAt < 4000) return;
    lastReportAt = now;
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        data: JSON.stringify(buildSnapshot()),
        headers: { 'Content-Type': 'application/json' },
        timeout: 4000,
        onerror: () => {},
        ontimeout: () => {},
      });
    } catch (e) { /* ignore */ }
  }

  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => { reportTimer = null; pushReport(true); }, 800);
  }

  function startReporterHeartbeat() {
    if (!String(CONFIG.reportUrl || '').trim()) return;
    pushReport(true);
    setInterval(() => pushReport(false), 10000);
  }

  /* ==================== 答案通道 ==================== */
  // 免费题库站(协议参考社区成熟脚本,无 token 时部分接口仍返回免费额度答案)
  async function channelTikuHai(q) {
    try {
      const res = JSON.parse(await cxFetch('http://api.tikuhai.com/search', {
        method: 'POST',
        data: JSON.stringify({ question: q.question, type: q.type }),
        headers: { 'Content-Type': 'application/json' }
      }));
      if (res.code === -1) return { form: '题库海', answer: String(res.msg || '').split('#') };
      const a = (res.data && res.data.answer) || res.msg || '';
      return { form: '题库海', answer: String(a).split('#') };
    } catch (e) { return { form: '题库海', answer: [] }; }
  }
  async function channelYizhi(q) {
    try {
      const ip = Array.from({ length: 4 }, () => Math.floor(255 * Math.random())).join('.');
      const res = JSON.parse(await cxFetch('http://cx.icodef.com/wyn-nb?v=4', {
        method: 'POST',
        data: JSON.stringify({ question: q.question }),
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'X-Real-IP': ip }
      }));
      if (res.code !== 1) return { form: '一之题库', answer: [] };
      let data = String(res.data || '').replace(/javascript:void\(0\);/g, '').replace(/\n/g, '').trim();
      if (/(叛逆|公众号|李恒雅|一之)/.test(data)) return { form: '一之题库', answer: [] };
      return { form: '一之题库', answer: data.split('#') };
    } catch (e) { return { form: '一之题库', answer: [] }; }
  }
  async function channelYanxi(q) {
    try {
      const res = JSON.parse(await cxFetch('https://tk.enncy.cn/query', {
        method: 'POST',
        data: JSON.stringify({ title: q.question }),
        headers: { 'Content-Type': 'application/json' }
      }));
      if (res.code !== 1) return { form: '言溪题库', answer: [] };
      return { form: '言溪题库', answer: String(res.data.answer || '').split('#') };
    } catch (e) { return { form: '言溪题库', answer: [] }; }
  }
  async function channelMuketool(q) {
    try {
      const res = JSON.parse(await cxFetch('https://api.muketool.com/cx/v2/query', {
        method: 'POST',
        data: JSON.stringify({ question: q.question, type: parseInt(q.type, 10) || 0 }),
        headers: { 'Content-Type': 'application/json' }
      }));
      if (res.code !== 1) return { form: '木课工具', answer: [] };
      return { form: '木课工具', answer: String(res.data || '').split('#') };
    } catch (e) { return { form: '木课工具', answer: [] }; }
  }
  let aiFailCount = 0;
  let aiCooldownUntil = 0;
  let aiCooldownWarned = false;
  function channelAI(q) {
    return new Promise((resolve) => {
      if (Date.now() < aiCooldownUntil) {
        if (!aiCooldownWarned) {
          aiCooldownWarned = true;
          log('AI 通道冷却中(连续失败后暂停 10 分钟),请检查 ⚙ 里的 Key/平台/接口地址/模型', 'warn');
        }
        resolve({ form: 'AI(冷却中)', answer: [] });
        return;
      }
      const prompt = buildAIPrompt(q);
      const data = JSON.stringify({
        model: CONFIG.aiModel,
        messages: [
          { role: 'system', content: '你是答题助手。回复的第一个字符必须是最终答案,严禁输出思考过程、解释、重复题目或任何多余内容。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 300
      });
      const done = (answer, errLog) => {
        if (errLog) {
          aiFailCount++;
          log(`AI 请求失败(${aiFailCount}/3): ${errLog}`, 'err');
          if (aiFailCount >= 3) {
            aiCooldownUntil = Date.now() + 10 * 60 * 1000;
            aiCooldownWarned = false;
            aiFailCount = 0;
            log('AI 通道连续失败 3 次,暂停 10 分钟后自动重试。常见原因:Key 错误/余额不足/接口地址或模型名填错', 'warn');
          }
        } else {
          aiFailCount = 0;
          aiCooldownUntil = 0;
          aiCooldownWarned = false;
        }
        resolve({ form: 'AI', answer });
      };
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.aiUrl,
        data,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.aiKey },
        timeout: 30000,
        onload: (res) => {
          try {
            if (res.status !== 200) {
              done([], `HTTP ${res.status}: ${String(res.responseText).slice(0, 180)}`);
              return;
            }
            const obj = JSON.parse(res.responseText);
            let content = ((obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '').trim();
            // 推理模型(deepseek-reasoner)有时把结论放在 reasoning_content、content 留空——取推理末尾作答案
            if (!content) {
              const rc = ((obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.reasoning_content) || '').trim();
              content = rc.slice(-300);
            }
            if (!content) { done([], '返回内容为空'); return; }
            done(parseAIAnswer(q.type, content));
          } catch (e) {
            done([], '解析失败: ' + (e.message || e));
          }
        },
        onerror: () => { done([], '网络错误'); },
        ontimeout: () => { done([], '超时(30s)'); }
      });
    });
  }

  function buildAIPrompt(q) {
    const opts = (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}.${o}`).join(' ');
    const base = '你是一位专业的学习辅导老师,知识面广。规则:你的回复必须以最终答案开头(第一个字符就是答案),只输出答案本身,不要任何解释、思考或多余文字。';
    switch (String(q.type)) {
      case '3': return `${base}\n判断题。题目:${q.question}\n只输出"正确"或"错误"。`;
      case '1': return `${base}\n多选题。题目:${q.question}\n选项:${opts}\n只输出所有正确选项的字母组合(如 ABD)。`;
      case '2': return `${base}\n填空题。题目:${q.question}\n直接输出答案,多个空用 | 分隔。`;
      case '0': return `${base}\n单选题。题目:${q.question}\n选项:${opts}\n只输出正确选项的字母(如 C)。`;
      default: return `${base}\n简答题。题目:${q.question}\n输出完整答案:若题目要求字数(例如"不少于800字""800字以上"),必须写够该字数;直接给正文,不要"以下是""简答如下"之类的开场白,也不要写提纲。`;
    }
  }

  function parseAIAnswer(type, content) {
    content = String(content).trim();
    switch (String(type)) {
      case '3': return [/正确|对|√|true|是/i.test(content) ? '正确' : '错误'];
      case '1': { const m = content.match(/[A-Ha-h]{1,8}/); return m ? m[0].toUpperCase().split('') : [content]; }
      case '0': { const m = content.match(/[A-Ha-h]/); return m ? [m[0].toUpperCase()] : [content]; }
      case '2': return content.split('|').map((s) => s.trim()).filter(Boolean);
      default: return [content];
    }
  }

  // 答案通道:AI 优先(准确率最高),免费题库并行兜底
  function filterAnswers(arr) {
    return (arr || []).map(String).map(clean)
      .filter((a) => a && a !== '暂无答案' && a !== '略' && !/(付费|购买|卡密|升级|公众号|扫码|微信)/.test(a));
  }
  let aiKeyWarned = false;
  async function getAnswers(q) {
    if (CONFIG.aiEnabled && CONFIG.aiKey) {
      const r = await channelAI(q);
      const ans = filterAnswers(r.answer);
      if (ans.length) {
        log(`[AI] 查到答案: ${ans.join(' / ')}`, 'ok');
        return ans;
      }
    } else if (!aiKeyWarned) {
      aiKeyWarned = true;
      log('⚠ 未启用 AI 答题:点面板 ⚙ → 勾选「AI 答题」并填写 DeepSeek API Key,否则无法自动做题', 'warn');
    }
    const results = CONFIG.useTiku
      ? await Promise.all([channelTikuHai(q), channelYizhi(q), channelYanxi(q), channelMuketool(q)])
      : [];
    for (const r of results) {
      const ans = filterAnswers(r.answer);
      if (ans.length) {
        log(`[${r.form}] 查到答案: ${ans.join(' / ')}`, 'ok');
        return ans;
      }
    }
    log('未查到答案' + ((!CONFIG.aiEnabled || !CONFIG.aiKey) ? '(原因:AI 答题未启用,请点 ⚙ 配置)' : ''), 'warn');
    return [];
  }

  /* ==================== 题目提取 ==================== */
  // 章节测验(.TiMu 容器)
  function extractQuizQuestion(el) {
    try {
      const label = el.querySelector('.clearfix .fontLabel');
      const titleEl = label || el.querySelector('.Zy_TItle');
      const text = cl(clean(titleEl ? titleEl.innerHTML : ''));
      if (!text) return null;
      const typeInput = el.querySelector('input[name^=answertype]');
      const type = typeInput ? typeInput.value : '0';
      // 选项:多种结构兜底(学习通不同版本选项 DOM 不同)
      let options = Array.from(el.querySelectorAll('ul li .after')).map((o) => clean(o.innerHTML)).filter(Boolean);
      if (!options.length) options = Array.from(el.querySelectorAll('ul li')).map((o) => clean(o.innerHTML)).filter(Boolean);
      if (!options.length) options = Array.from(el.querySelectorAll('.answerBg, .num_option, .after')).map((o) => clean(o.innerHTML)).filter(Boolean);
      return { question: text, options, type };
    } catch (e) { return null; }
  }
  // 作业页(.questionLi 容器)
  function extractWorkQuestion(el) {
    try {
      const mark = el.querySelector('.mark_name');
      let html = mark ? mark.innerHTML : '';
      const idx = html.indexOf('</span>');
      const text = cl(clean(idx >= 0 ? html.substring(idx + 7) : html));
      if (!text) return null;
      const typeInput = el.querySelector('input[name^=answertype]');
      const type = typeInput ? typeInput.value : '0';
      const options = Array.from(el.querySelectorAll('.answer_p')).map((o) => clean(o.innerHTML));
      return { question: text, options, type };
    } catch (e) { return null; }
  }

  /* ==================== 自动作答 ==================== */
  function matchAnswer(answerArr, options) {
    const idx = [];
    const opts = (options || []).map((o) => cl(clean(String(o))));
    for (const raw of answerArr) {
      const a = cl(clean(String(raw)));
      if (!a) continue;
      const letters = /^[A-Ha-h]+$/.test(a) ? a.toUpperCase().split('') : [];
      for (let i = 0; i < opts.length; i++) {
        if (idx.includes(i)) continue;
        const letter = String.fromCharCode(65 + i);
        const opt = opts[i];
        if (!opt) continue;
        if (letters.includes(letter)) { idx.push(i); continue; }
        if (a.startsWith(letter + '.') || a.startsWith(letter + '、') || a.startsWith(letter + ':') || a.startsWith(letter + ')')) { idx.push(i); continue; }
        if (a.length >= 2 && (opt.includes(a) || a.includes(opt))) { idx.push(i); continue; }
        if (opt === a) idx.push(i);
      }
    }
    return idx;
  }

  // 清空当前已勾选的选项(重做时避免旧答案残留叠加)
  function clearCurrent(el) {
    el.querySelectorAll('input[type=radio], input[type=checkbox]').forEach((inp) => {
      if (inp.checked) { try { inp.click(); } catch (e) { /* ignore */ } }
    });
  }

  function setQuizAnswer(answerArr, q, el, win) {
    const $$ = (sel) => Array.from(el.querySelectorAll(sel));
    switch (String(q.type)) {
      case '0':
      case '1': {
        let idx = matchAnswer(answerArr, q.options);
        if (!idx.length) return false;
        // 拟人:单选题按配置概率故意点错(多选不故意错)
        if (String(q.type) === '0' && CONFIG.deliberateErrorRate > 0 && Math.random() < CONFIG.deliberateErrorRate && q.options && q.options.length > 1) {
          const wrongIdx = [];
          for (let i = 0; i < q.options.length; i++) if (!idx.includes(i)) wrongIdx.push(i);
          if (wrongIdx.length) {
            idx = [wrongIdx[Math.floor(Math.random() * wrongIdx.length)]];
            log('🎭 拟人模式:本题故意答错(配置概率)', 'info');
          }
        }
        clearCurrent(el);
        const lis = $$('ul li');
        if (lis.length) {
          lis.forEach((li, i) => {
            if (idx.includes(i)) {
              const input = li.querySelector('input[type=radio], input[type=checkbox]');
              try { if (input) input.click(); } catch (e) { /* ignore */ }
              try { li.click(); } catch (e) { /* ignore */ }
            }
          });
          return true;
        }
        // 兜底1:直接点第 idx 个选项控件
        const inputs = $$('input[type=radio], input[type=checkbox]');
        if (inputs.length) {
          idx.forEach((i) => { const inp = inputs[i]; if (inp) { try { inp.click(); } catch (e) { /* ignore */ } } });
          return true;
        }
        // 兜底2:点第 idx 个常见选项容器
        const optEls = $$('.answerBg, .num_option, .after, .ans-opt');
        if (optEls.length) {
          idx.forEach((i) => { const o = optEls[i]; if (o) { try { o.click(); } catch (e) { /* ignore */ } } });
          return true;
        }
        return false;
      }
      case '3': {
        const ans = String(answerArr[0] || '');
        const isTrue = /(^|[,|#])(True|true|正确|对|√|T|是)([,|#]|$)/.test(ans);
        const isFalse = /(^|[,|#])(False|false|错误|错|×|F|否)([,|#]|$)/.test(ans);
        if (!isTrue && !isFalse) return false;
        let wantTrue = isTrue, wantFalse = isFalse;
        if (CONFIG.deliberateErrorRate > 0 && Math.random() < CONFIG.deliberateErrorRate) {
          wantTrue = isFalse; wantFalse = isTrue;
          log('🎭 拟人模式:本题故意答错(配置概率)', 'info');
        }
        clearCurrent(el);
        $$('ul li').forEach((li) => {
          const input = li.querySelector('input');
          const val = input ? String(input.value) : '';
          if ((wantTrue && val === 'true') || (wantFalse && val === 'false')) {
            try { li.click(); } catch (e) { /* ignore */ }
          }
        });
        return true;
      }
      case '2':
      case '4':
      case '5':
      case '6':
      case '7':
      case '9': {
        return fillTextAnswer(el, answerArr, win);
      }
      default:
        return false;
    }
  }

  // ===== 文本类(填空/简答)填写:兼容 UEditor 等富文本编辑器(正文在 iframe 里) =====
  // 关键:UEditor 的正文是 iframe 内的 contenteditable body,顶层只有隐藏 textarea,
  // 直接给顶层 textarea 赋值用户看不到任何东西。这里必须逐层找、写完回读校验。
  function textValueOf(node) {
    try {
      if (!node) return '';
      if (typeof node.value === 'string' && node.value) return node.value;
      return (node.innerText || node.textContent || '').replace(/\s+/g, '');
    } catch (e) { return ''; }
  }
  function isRichHost(node, frame) {
    try {
      if (node && node.isContentEditable) return true;
      const tag = frame ? (frame.className || '') + ' ' + (frame.id || '') : '';
      return /edui|ueditor|cke|ql-editor|w-e-text/i.test(tag);
    } catch (e) { return false; }
  }
  function collectTextTargets(el) {
    const rich = [];   // 富文本(iframe body / contenteditable)
    const plain = [];  // textarea / 单行 input
    const seen = new Set();
    const pushRich = (doc, node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      rich.push({ kind: 'rich', doc, node });
    };
    const scanFrames = (root) => Array.from(root.querySelectorAll('iframe')).forEach((f) => {
      try {
        const doc = f.contentDocument;
        if (!doc || !doc.body) return;
        if (isRichHost(doc.body, f)) pushRich(doc, doc.body);
      } catch (e) { /* 跨域跳过 */ }
    });
    scanFrames(el);
    Array.from(el.querySelectorAll('[contenteditable="true"], [contenteditable=""]')).forEach((n) => pushRich(n.ownerDocument, n));
    // 有的页面把编辑器渲染在题目容器之外 → 扩大到整页再找一次
    if (!rich.length) {
      scanFrames(document);
      Array.from(document.querySelectorAll('[contenteditable="true"], .edui-body, .ql-editor, .w-e-text, .cke_editable')).forEach((n) => pushRich(n.ownerDocument, n));
    }
    const pushPlain = (n) => plain.push({
      kind: (n.tagName || '').toLowerCase() === 'textarea' ? 'textarea' : 'input',
      doc: n.ownerDocument,
      node: n,
      hidden: n.offsetParent === null
    });
    Array.from(el.querySelectorAll('textarea')).forEach(pushPlain);
    Array.from(el.querySelectorAll('input[type=text], input:not([type])')).forEach(pushPlain);
    if (!plain.length) {
      Array.from(document.querySelectorAll('textarea')).forEach(pushPlain);
      Array.from(document.querySelectorAll('.questionLi input[type=text], .TiMu input[type=text]')).forEach(pushPlain);
    }
    return { rich, plain };
  }
  function writeRich(t, text) {
    const { doc, node } = t;
    try { if (node.focus) node.focus(); } catch (e) { /* ignore */ }
    try {
      if (doc && doc.execCommand) {
        const sel = doc.getSelection ? doc.getSelection() : doc.defaultView.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(range);
        doc.execCommand('delete', false, null);
        doc.execCommand('insertText', false, text);
      }
    } catch (e) { /* ignore */ }
    if (textValueOf(node).length < Math.min(6, text.length)) {
      try { node.textContent = text; } catch (e) { /* ignore */ }
    }
    try {
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } catch (e) { /* ignore */ }
  }
  function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ''); }
  // UEditor 官方 API:能同步编辑器内部状态(提交时才带得走)
  function tryUE(win, text, need) {
    try {
      const UE = win && win.UE;
      if (!UE || !UE.instants) return false;
      return Object.keys(UE.instants).some((k) => {
        const ed = UE.instants[k];
        if (!ed || typeof ed.setContent !== 'function') return false;
        if (typeof ed.getContent === 'function') {
          const cur = stripTags(ed.getContent());
          if (cur.length >= need(text) && cur.indexOf(text.slice(0, 6)) >= 0) return true;  // 已经写好了
        }
        ed.setContent(text);
        return typeof ed.getContent === 'function' && stripTags(ed.getContent()).length >= need(text);
      });
    } catch (e) { return false; }
  }
  function setPlain(t, val) {
    try {
      t.node.value = val;
      t.node.dispatchEvent(new Event('input', { bubbles: true }));
      t.node.dispatchEvent(new Event('change', { bubbles: true }));
      t.node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } catch (e) { /* ignore */ }
    return textValueOf(t.node).length >= Math.min(6, val.length);
  }
  function fillTextAnswer(el, answerArr, win) {
    const texts = (answerArr || []).map((a) => cl(clean(String(a == null ? '' : a)).replace(/^第.空[:：]?/, ''))).filter(Boolean);
    if (!texts.length) return false;
    const need = (t) => Math.min(6, t.length);

    // ① UEditor 官方 API 最优先(能同步编辑器内部状态,提交时带得走)
    if (tryUE(win, texts[0], need)) return true;

    const { rich, plain } = collectTextTargets(el);

    // ② 富文本容器注入(iframe body / contenteditable)
    for (const t of rich) {
      writeRich(t, texts[0]);
      if (textValueOf(t.node).length >= need(texts[0])) return true;
    }

    // ③ 可见文本框:多空填空逐框填,单框填整段
    const vis = plain.filter((t) => !t.hidden);
    if (vis.length > 1 && texts.length > 1) {
      let filled = 0;
      vis.forEach((t, i) => { if (setPlain(t, texts[i] != null ? texts[i] : texts[0])) filled++; });
      if (filled) return true;
    }
    for (const t of vis) {
      if (setPlain(t, texts[0])) return true;
    }

    // ④ 隐藏 textarea 兜底:只写值不算成功,必须 UE API 能回读确认
    for (const t of plain.filter((x) => x.hidden)) {
      setPlain(t, texts[0]);
      try {
        const name = t.node.getAttribute && t.node.getAttribute('name');
        if (name && win && win.UE && typeof win.UE.getEditor === 'function') {
          const ed = win.UE.getEditor(name);
          if (ed && typeof ed.setContent === 'function') {
            ed.setContent(texts[0]);
            if (stripTags(ed.getContent && ed.getContent()).length >= need(texts[0])) return true;
          }
        }
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function clickButtonByText(win, texts) {
    const nodes = win.document.querySelectorAll('button, .btn, a, .el-button, .jb_btn, input[type=button], input[type=submit]');
    for (const n of nodes) {
      const t = (n.textContent || n.value || '').trim();
      for (const kw of texts) {
        if (t && (t === kw || t.includes(kw))) {
          try { n.click(); } catch (e) { /* ignore */ }
          return true;
        }
      }
    }
    return false;
  }

  /* ==================== 字体加密解密(Canvas 字形对比法) ==================== */
  // 候选字符集:常用汉字 + 数字字母 + 常见符号(课程题目用字基本都在内)
  const COMMON_CHARS =
    '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物实现加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞' +
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
    '，。、；：？！“”‘’（）《》〈〉【】[]{}·—…%＋－×÷＝√（）+-×÷=%/\\.,;:!?_*&#@' +
    '一二三四五六七八九十百千万亿年月日时分秒甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  const FONT_NAME = 'cxfontdec';
  let _fontCanvas = null;
  let _fontCtx = null;

  function getFontCtx() {
    if (!_fontCanvas) {
      _fontCanvas = document.createElement('canvas');
      _fontCanvas.width = 32;
      _fontCanvas.height = 32;
      _fontCtx = _fontCanvas.getContext('2d');
    }
    return _fontCtx;
  }

  // 用解密字体渲染一个字符,返回二值化的字形指纹
  function glyphBits(ch) {
    const ctx = getFontCtx();
    ctx.clearRect(0, 0, 32, 32);
    ctx.font = '28px ' + FONT_NAME;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 16, 17);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let s = '';
    for (let i = 3; i < d.length; i += 4) s += d[i] > 120 ? '1' : '0';
    return s;
  }

  function extractFontBase64(win) {
    const styles = win.document.querySelectorAll('style');
    for (const st of styles) {
      const t = st.textContent || '';
      if (t.includes('font-cxsecret') || t.includes('cxsecret')) {
        const m = t.match(/base64,([\w\W]+?)'/);
        if (m) return m[1];
        const m2 = t.match(/base64,([\w\W]+?)"/);
        if (m2) return m2[1];
      }
    }
    return null;
  }

  // 核心:学习通的加密字体内,把"真实字符"的字形映射到了错误码点。
  // 用同一字体渲染"候选常用字"和"乱码字符",字形指纹相同即为同一字符。
  async function decodeFont(win) {
    const b64 = extractFontBase64(win);
    if (!b64) {
      if (win.document.querySelector('.font-cxsecret')) log('未找到字体定义(可能为其他加密方式)', 'warn');
      return false;
    }
    try {
      const ff = new FontFace(FONT_NAME, 'url(data:font/ttf;base64,' + b64 + ')');
      document.fonts.add(ff);
      await ff.load();
    } catch (e) { log('加密字体加载失败: ' + (e.message || e), 'warn'); return false; }
    const els = Array.from(win.document.querySelectorAll('.font-cxsecret'));
    if (!els.length) return false;
    const targets = new Set();
    els.forEach((el) => { for (const ch of String(el.textContent || '')) targets.add(ch); });
    if (!targets.size) return false;
    const tHashes = new Map();
    for (const ch of targets) {
      try { tHashes.set(ch, glyphBits(ch)); } catch (e) { /* ignore */ }
    }
    if (!tHashes.size) return false;
    log(`🔓 字体解密: ${tHashes.size} 个乱码字符,正在对比常用字字形...`, 'info');
    const resolved = new Map();
    const start = Date.now();
    outer:
    for (let ci = 0; ci < COMMON_CHARS.length; ci++) {
      const ch = COMMON_CHARS[ci];
      if (resolved.size < tHashes.size) {
        const bits = glyphBits(ch);
        for (const [target, thash] of tHashes) {
          if (!resolved.has(target) && bits === thash) {
            resolved.set(target, ch);
            if (resolved.size >= tHashes.size) break outer;
          }
        }
      }
      if (Date.now() - start > 10000) { log('字体解密超时,部分字符可能未映射', 'warn'); break; }
    }
    if (!resolved.size) { log('字体解密未能匹配(可能含非常用字),跳过自动作答', 'warn'); return false; }
    els.forEach((el) => {
      let text = String(el.textContent || '');
      for (const [t, r] of resolved) text = text.split(t).join(r);
      el.textContent = text;
      el.classList.remove('font-cxsecret');
    });
    log(`🔓 字体解密完成,还原 ${resolved.size} 个字符`, 'ok');
    return true;
  }

  /* ==================== 视频弹题处理 ==================== */
  const QUIZ_SELECTORS = ['.TiMu', '.topic-item', '.ans-videoquiz', '.ans-topic', '#subtitle .TiMu', '.el-dialog .TiMu', '.popContent .TiMu', '.maskDiv .TiMu'];

  // 启发式:找"题干特征 + 2~8 个选项控件"的可见容器
  function heuristicFindQuiz(win) {
    let best = null;
    let bestLen = Infinity;
    let nodes;
    try { nodes = win.document.querySelectorAll('div, section, form, fieldset, ul'); } catch (e) { return null; }
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const t = String(el.textContent || '').trim();
      if (t.length < 8 || t.length > 900) continue;
      const nInputs = el.querySelectorAll('input[type=radio], input[type=checkbox]').length;
      const nLis = el.querySelectorAll('li').length;
      const optCount = nInputs || nLis;
      if (optCount < 2 || optCount > 8) continue;
      if (!/[?？]|（\s*）|\(\s*\)|__+/.test(t)) continue;
      if (t.length < bestLen) { bestLen = t.length; best = el; }
    }
    return best;
  }

  // 启发式提取:判断题(对/错双选项)与单选
  function extractHeuristicQuestion(el) {
    try {
      const optNodes = Array.from(el.querySelectorAll('li'));
      const opts = optNodes.map((li) => clean(li.textContent))
        .filter((t) => t && t.length < 80 && !/(提交|继续学习|回看|确定|下一题|上一题|提交中)/.test(t));
      let type = '0';
      // 判断题:两个选项,去掉"A、"这类前缀后是 对/错
      const norm = (t) => String(t).replace(/^[A-Ha-h][、.．:)\s]+/, '').trim();
      if (opts.length === 2 && /^(正确|对|√|错误|错|×)$/.test(norm(opts[0])) && /^(正确|对|√|错误|错|×)$/.test(norm(opts[1]))) type = '3';
      let text = String(el.textContent || '');
      for (const o of opts) text = text.split(o).join('');
      text = cl(clean(text)).replace(/[（(]\s*[)）]\s*$/, '').slice(0, 300);
      if (!text) return null;
      return { question: text, options: opts, type };
    } catch (e) { return null; }
  }

  // 启发式作答:判断题按语义点击,选择题按索引点击
  function setHeuristicAnswer(answerArr, q, el) {
    try {
      if (String(q.type) === '3') {
        const ans = String(answerArr[0] || '');
        let wantTrue = /正确|对|√|True|true|T|是/.test(ans);
        let wantFalse = /错误|错|×|False|false|F|否/.test(ans);
        if (!wantTrue && !wantFalse) return false;
        // 拟人:按配置概率故意答错(真人不会全对)
        if (CONFIG.deliberateErrorRate > 0 && Math.random() < CONFIG.deliberateErrorRate) {
          const t = wantTrue; wantTrue = wantFalse; wantFalse = t;
          log('🎭 拟人模式:本题故意答错(配置概率)', 'info');
        }
        const normOpt = (t) => String(t).replace(/^[A-Ha-h][、.．:)\s]+/, '').trim();
        const nodes = Array.from(el.querySelectorAll('li, label, .option, div, span, a'))
          .filter((n) => /^(正确|对|√|错误|错|×)$/.test(normOpt(clean(n.textContent))));
        for (const n of nodes) {
          const t = normOpt(clean(n.textContent));
          const isTrueOpt = /^(正确|对|√)$/.test(t);
          if ((wantTrue && isTrueOpt) || (wantFalse && !isTrueOpt)) {
            try { const inp = n.querySelector('input'); if (inp) inp.click(); } catch (e) { /* ignore */ }
            try { n.click(); } catch (e) { /* ignore */ }
          }
        }
        return nodes.length > 0;
      }
      let idx = matchAnswer(answerArr, q.options || []);
      if (!idx.length) return false;
      // 拟人:单选按配置概率故意点一个错误选项
      if (CONFIG.deliberateErrorRate > 0 && Math.random() < CONFIG.deliberateErrorRate && (q.options || []).length > 1) {
        const wrongIdx = [];
        for (let i = 0; i < q.options.length; i++) if (!idx.includes(i)) wrongIdx.push(i);
        if (wrongIdx.length) {
          idx = [wrongIdx[Math.floor(Math.random() * wrongIdx.length)]];
          log('🎭 拟人模式:本题故意答错(配置概率)', 'info');
        }
      }
      const lis = Array.from(el.querySelectorAll('li'));
      if (!lis.length) return false;
      lis.forEach((li, i) => {
        if (idx.includes(i)) {
          try { const inp = li.querySelector('input'); if (inp) inp.click(); } catch (e) { /* ignore */ }
          try { li.click(); } catch (e) { /* ignore */ }
        }
      });
      return true;
    } catch (e) { return false; }
  }

  // 弹题"已处理"标记有效期:60 秒后过期,支持"答错→回看→重弹"场景的重新作答
  function wasHandledRecently(el) {
    return !!el.__cxHandledAt && (Date.now() - el.__cxHandledAt < 60000);
  }

  async function tryPopupQuiz(wins, player) {
    for (const win of wins) {
      if (!win || !win.document) continue;
      let container = null;
      for (const sel of QUIZ_SELECTORS) {
        let els;
        try { els = win.document.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of els) {
          if (wasHandledRecently(el)) continue;
          if (isVisible(el)) { container = el; break; }
        }
        if (container) break;
      }
      if (!container) container = heuristicFindQuiz(win);
      if (!container || wasHandledRecently(container)) continue;
      container.__cxHandledAt = Date.now();
      let q = extractQuizQuestion(container);
      const fromHeuristic = !q || !q.question;
      if (fromHeuristic) q = extractHeuristicQuestion(container);
      if (!q || !q.question) {
        log('⚠ 发现疑似弹题但无法解析题目,已记录 DOM', 'warn');
        log('DOM: ' + String(container.outerHTML).slice(0, 1500), 'info');
        continue;
      }
      if (!container.__cxDomLogged) {
        container.__cxDomLogged = true;
        log('DOM侦察: ' + String(container.outerHTML).slice(0, 1500), 'info');
      }
      log(`❓ 检测到视频弹题${fromHeuristic ? '(启发式)' : ''}: ${q.question.slice(0, 40)}...`, 'warn');
      await sleep(0.2); // 极速:不等待
      const answers = await getAnswers(q);
      const ok = setHeuristicAnswer(answers, q, container);
      recordQuestion(q, answers);  // 收集弹题进题库
      log(ok ? '弹题已作答,继续播放' : '弹题未能作答,尝试直接继续', ok ? 'ok' : 'warn');
      await sleep(0.3); // 极速:答完立即继续
      // 精确优先:先点"继续学习"(视频弹题专用),再兜底其他常见按钮
      if (!clickButtonByText(win, ['继续学习'])) {
        clickButtonByText(win, ['确定', '提交', '下一题', '关闭', '继续', '我知道了']);
      }
      try { if (player) player.play(); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  /* ==================== 每日刷课时长统计(纪律) ==================== */
  function getTodayStats() {
    try {
      const s = (typeof GM_getValue !== 'undefined')
        ? GM_getValue('cxDaily', null)
        : JSON.parse(localStorage.getItem('cxDaily') || 'null');
      const today = new Date().toDateString();
      if (s && s.date === today) return s;
      return { date: today, minutes: 0 };
    } catch (e) { return { date: new Date().toDateString(), minutes: 0 }; }
  }
  function saveTodayStats(s) {
    try {
      if (typeof GM_setValue !== 'undefined') GM_setValue('cxDaily', s);
      else localStorage.setItem('cxDaily', JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }
  let dailyLimitReached = false;

  /* ==================== 任务点处理 ==================== */
  async function videoTask(iframe, outerWin) {
    if (CONFIG.dailyLimitMinutes > 0) {
      const st = getTodayStats();
      if (st.minutes >= CONFIG.dailyLimitMinutes) {
        dailyLimitReached = true;
        log('⏹ 今日刷课已达上限 ' + CONFIG.dailyLimitMinutes + ' 分钟，自动停止（明天恢复）', 'warn');
        return;
      }
      log('⏱ 今日已刷约 ' + st.minutes + ' 分钟 / 上限 ' + CONFIG.dailyLimitMinutes + ' 分钟');
    }

    let box = null;
    try { box = iframe.closest ? iframe.closest('.ans-attach-ct') : null; } catch (e) { /* ignore */ }
    if (!box) box = iframe.parentElement || null;
    if (jobMarkedDone(box)) {
      log('视频任务点已完成（aria-label / ans-job-finished），跳过');
      return;
    }

    setStatus('正在进入视频任务点…');
    await waitIframeLoaded(iframe);
    const win = iframe.contentWindow;
    await waitElementLoaded(win, '#video_html5_api,video', 90000);

    let player = null;
    try { player = win.videojs ? win.videojs('video_html5_api') : null; } catch (e) { /* ignore */ }
    let videoEl = null;
    try { videoEl = win.document.querySelector('video'); } catch (e) { /* ignore */ }
    if (!player && !videoEl) { log('无法获取播放器对象，跳过', 'err'); return; }

    const isPaused = () => {
      try { return player ? player.paused() : videoEl.paused; } catch (e) { return true; }
    };
    const curTime = () => {
      try { return player ? player.currentTime() : videoEl.currentTime; } catch (e) { return 0; }
    };
    const duration = () => {
      try { const d = player ? player.duration() : videoEl.duration; return isFinite(d) ? d : 0; } catch (e) { return 0; }
    };
    const doPlay = () => {
      try {
        if (player) player.play();
        else if (videoEl) { const p = videoEl.play(); if (p && p.catch) p.catch(() => {}); }
      } catch (e) { /* ignore */ }
    };
    const doPause = () => {
      try { if (player) player.pause(); else if (videoEl) videoEl.pause(); } catch (e) { /* ignore */ }
    };

    try {
      if (player) { player.muted(true); player.playbackRate(CONFIG.speed); }
      else { videoEl.muted = true; videoEl.playbackRate = CONFIG.speed; }
    } catch (e) { /* ignore */ }
    doPlay();
    log('▶ 开始播放视频（静音，' + CONFIG.speed + 'x）', 'ok');

    await new Promise((resolve) => {
      let finished = false;
      let timer = null;
      let guard = null;
      let quizBusy = false;
      let observer = null;

      const cleanup = () => {
        try { if (timer) clearInterval(timer); } catch (e) { /* ignore */ }
        try { if (guard) clearInterval(guard); } catch (e) { /* ignore */ }
        try { if (observer) observer.disconnect(); } catch (e) { /* ignore */ }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };
      const jobDoneNow = () => {
        if (jobMarkedDone(box)) return true;
        try {
          if (typeof win.isUnFinishJob === 'function' && !win.isUnFinishJob()) return true;
        } catch (e) { /* ignore */ }
        return false;
      };

      // 平台把任务点标绿时立刻结束等待（不必等 video 的 ended）
      try {
        observer = new MutationObserver(() => {
          if (jobDoneNow()) { log('学习通报告本任务点已完成', 'ok'); finish(); }
        });
        if (box) observer.observe(box, { attributes: true, attributeFilter: ['class'], subtree: true });
      } catch (e) { /* ignore */ }

      timer = setInterval(async () => {
        if (finished) return;
        if (PAUSED) { doPause(); return; }
        if (findVerifyPrompt()) {
          verifyHold = true;
          doPause();
          setStatus('检测到学习通验证（人脸/滑块/验证码），已暂停自动操作；完成后自动继续…');
          return;
        }
        verifyHold = false;

        const d = duration();
        const c = curTime();
        if (d > 0) {
          panelState.progress = Math.min(100, (c / d) * 100);
          setStatus('▶ 正在播放视频 ' + fmtTime(c) + ' / ' + fmtTime(d));
        }
        if (jobDoneNow()) { log('学习通报告本任务点已完成', 'ok'); finish(); return; }
        if (quizBusy) return;
        quizBusy = true;
        try {
          if (isPaused()) {
            await tryPopupQuiz([win, outerWin, window], player);
            if (isPaused()) {
              // 没开 AI/题库时，弹题可能答不出来：盲选一个选项再点提交，
              // 目的只是把挡路的弹题关掉，让视频继续（不判断对错）。
              try {
                const doc = win.document;
                const boxEl = doc.querySelector('.ans-videoquiz-opt,.tkItem_ul,.videoquiz,.TiMu,.questionLi');
                if (boxEl) {
                  const opt = boxEl.querySelector('input[type="radio"],input[type="checkbox"],li');
                  if (opt && !opt.checked) { try { opt.click(); } catch (e) { /* ignore */ } }
                  const submit = doc.querySelector('.ans-videoquiz-submit,.videoquiz-submit');
                  if (submit) { try { submit.click(); } catch (e) { /* ignore */ } }
                }
              } catch (e) { /* ignore */ }
            }
            if (isPaused()) doPlay();
          }
        } catch (e) { /* ignore */ } finally {
          quizBusy = false;
        }
      }, 2000);

      // 兜底：播放器没有 ended 事件时，接近结尾也算播完
      guard = setInterval(() => {
        if (finished) return;
        const d = duration();
        const c = curTime();
        if (d > 0 && c >= d - 0.6) finish();
      }, 3000);

      try {
        if (player && player.on) player.on('ended', () => { log('视频播放结束', 'ok'); finish(); });
        else if (videoEl) videoEl.addEventListener('ended', () => { log('视频播放结束', 'ok'); finish(); });
      } catch (e) { /* ignore */ }
    });

    doPause();
    panelState.progress = 100;
    setStatus('视频播放完，等待平台确认任务点…');
    const ok = await waitJobDoneFor(box, 20000);
    if (ok) log('✓ 视频任务点已完成', 'ok');
    else log('⚠ 视频已播完，但平台还没显示任务点完成；稍后继续核对', 'warn');

    try {
      const dur = duration();
      if (dur > 0) {
        const st = getTodayStats();
        st.minutes += Math.round(dur / 60);
        saveTodayStats(st);
        log('⏱ 今日累计刷课约 ' + st.minutes + ' 分钟');
      }
    } catch (e) { /* ignore */ }
  }

  async function audioTask(iframe) {
    let box = null;
    try { box = iframe.closest ? iframe.closest('.ans-attach-ct') : null; } catch (e) { /* ignore */ }
    if (!box) box = iframe.parentElement || null;
    if (jobMarkedDone(box)) { log('音频任务点已完成，跳过'); return; }
    setStatus('正在进入音频任务点…');
    await waitIframeLoaded(iframe);
    const win = iframe.contentWindow;
    await waitElementLoaded(win, '#audio_html5_api,audio', 90000);
    const audio = win.document.querySelector('#audio_html5_api') || win.document.querySelector('audio');
    if (!audio) { log('未找到音频播放器，跳过', 'warn'); return; }
    audio.muted = true;
    audio.volume = 0;
    try { const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    log('♪ 开始播放音频（静音）', 'ok');
    await new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        resolve();
      };
      timer = setInterval(() => {
        if (done) return;
        if (jobMarkedDone(box)) { finish(); return; }
        if (audio.ended) { finish(); return; }
        if (PAUSED) { try { audio.pause(); } catch (e) { /* ignore */ } return; }
        if (findVerifyPrompt()) { setStatus('检测到验证，已暂停自动操作…'); return; }
        const d = isFinite(audio.duration) ? audio.duration : 0;
        const c = audio.currentTime || 0;
        if (d > 0) {
          panelState.progress = Math.min(100, (c / d) * 100);
          setStatus('♪ 正在播放音频 ' + fmtTime(c) + ' / ' + fmtTime(d));
        }
        if (audio.paused) { try { const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
      }, 2000);
      audio.addEventListener('ended', finish);
    });
    await waitJobDoneFor(box, 15000);
    log('✓ 音频任务点完成', 'ok');
  }

  async function pdfTask(iframe) {
    let box = null;
    try { box = iframe.closest ? iframe.closest('.ans-attach-ct') : null; } catch (e) { /* ignore */ }
    if (!box) box = iframe.parentElement || null;
    if (jobMarkedDone(box)) { log('文档任务点已完成，跳过'); return; }
    setStatus('正在打开文档 / PPT 任务点…');
    await waitIframeLoaded(iframe);
    const win = iframe.contentWindow;
    let docWin = win;
    try {
      const pan = win.document.querySelector('#panView');
      if (pan && pan.contentWindow) docWin = pan.contentWindow;
    } catch (e) { /* ignore */ }
    for (let i = 0; i < 3; i++) {
      if (PAUSED) return;
      try {
        const doc = docWin.document;
        const el = doc.scrollingElement || doc.documentElement || doc.body;
        if (el) el.scrollTop = el.scrollHeight;
        docWin.scrollTo(0, el ? el.scrollHeight : 0);
      } catch (e) { /* ignore */ }
      await sleep(1);
    }
    // 平台自己的完成方法（参考 Memory2314/XuexitongJSFork）
    try {
      if (typeof docWin.finishJob === 'function') docWin.finishJob();
      else if (typeof docWin.greenligth === 'function') docWin.greenligth();
    } catch (e) { /* ignore */ }
    setStatus('📖 正在阅读资料，等待任务点完成…');
    await waitJobDoneFor(box, 20000);
    log('✓ 文档任务点处理完成', 'ok');
  }

  // 图片任务点：打开后“看完”图片即完成（停留 + 轻微滚动模拟查看）
  async function imageTask(iframe) {
    let box = null;
    try { box = iframe.closest ? iframe.closest('.ans-attach-ct') : null; } catch (e) { /* ignore */ }
    if (!box) box = iframe.parentElement || null;
    if (jobMarkedDone(box)) { log('图片任务点已完成，跳过'); return; }
    setStatus('🖼 正在查看图片任务…');
    await waitIframeLoaded(iframe);
    const win = iframe.contentWindow;
    for (let i = 0; i < 3; i++) {
      if (PAUSED) return;
      try { win.scrollTo(0, win.document.body.scrollHeight); } catch (e) { /* ignore */ }
      await sleep(0.5);
      try { win.scrollTo(0, 0); } catch (e) { /* ignore */ }
      await sleep(0.5);
    }
    await sleep(2);
    await waitJobDoneFor(box, 15000);
    log('✓ 图片任务处理完成', 'ok');
  }

  async function workTask(iframe) {
    await waitIframeLoaded(iframe);
    const outerWin = iframe.contentWindow;
    let innerIframe = null;
    try { innerIframe = outerWin.document.querySelector('iframe'); } catch (e) { /* ignore */ }
    if (!innerIframe) { log('测验内层 iframe 未找到,跳过', 'warn'); return; }
    await waitIframeLoaded(innerIframe);
    const win = innerIframe.contentWindow;
    await waitElementLoaded(win, '.TiMu, .questionLi', 30000);
    if (win.document.querySelector('.font-cxsecret')) {
      log('🔐 测验检测到字体加密,正在自动解密...', 'warn');
      await decodeFont(win);
      if (win.document.querySelector('.font-cxsecret')) {
        log('⚠ 字体解密未成功,跳过自动作答(不会乱提交)', 'warn');
        try { win.alert = () => {}; if (typeof win.noSubmit === 'function') win.noSubmit(); } catch (e) { /* ignore */ }
        return;
      }
    }
    // 双结构:老版章节测验(.TiMu)/ 新版内嵌作业(.questionLi,如 doHomeWorkNew)
    let els = Array.from(win.document.querySelectorAll('.TiMu'));
    let workStyle = false;
    if (!els.length) {
      els = Array.from(win.document.querySelectorAll('.questionLi'));
      workStyle = true;
    }
    if (!els.length) { log('未找到题目', 'warn'); return; }
    log(`📝 章节测验${workStyle ? '(作业结构)' : ''},共 ${els.length} 题`, 'ok');
    const tasks = [];
    for (const el of els) {
      const q = workStyle ? extractWorkQuestion(el) : extractQuizQuestion(el);
      if (q) tasks.push({ q, el });
    }
    let okCount = 0;
    for (let i = 0; i < tasks.length; i++) {
      const { q, el } = tasks[i];
      await randomSleep(CONFIG.answerIntervalMin, CONFIG.answerIntervalMax);
      const answers = await getAnswers(q);
      const ok = setQuizAnswer(answers, q, el, win);
      recordQuestion(q, answers);  // 收集测验题进题库
      if (ok) okCount++;
      log(`第 ${i + 1}/${tasks.length} 题(类型 ${q.type}) ${ok ? '✓ 已作答' : '✗ 无答案'}`, ok ? 'ok' : 'warn');
    }
    const accuracy = tasks.length ? okCount / tasks.length : 0;
    if (CONFIG.autoSubmit && accuracy >= CONFIG.minAccuracy) {
      await randomSleep(CONFIG.submitDelayMin, CONFIG.submitDelayMax);
      log(`正确率 ${Math.round(accuracy * 100)}%,正在提交...`, 'ok');
      let submitted = false;
      try {
        if (typeof win.btnBlueSubmit === 'function') { win.btnBlueSubmit(); submitted = true; }
        else if (typeof win.submitWork === 'function') { win.submitWork(); submitted = true; }
      } catch (e) { /* ignore */ }
      if (!submitted) submitted = clickButtonByText(win, ['交卷', '提交', '确认提交']);
      if (submitted) {
        await sleep(3);
        try { if (typeof win.submitCheckTimes === 'function') win.submitCheckTimes(); } catch (e) { /* ignore */ }
        log('已触发提交', 'ok');
      } else {
        log('未找到提交入口,请手动提交', 'warn');
      }
    } else {
      log(`正确率 ${Math.round(accuracy * 100)}% 低于阈值 ${Math.round(CONFIG.minAccuracy * 100)}%,暂存不提交`, 'warn');
      try { win.alert = () => {}; if (typeof win.noSubmit === 'function') win.noSubmit(); } catch (e) { /* ignore */ }
    }
  }

  async function homeworkTask() {
    initPanel();
    await waitElementLoaded(window, '.questionLi', 30000);
    if (window.document.querySelector('.font-cxsecret')) {
      log('🔐 作业检测到字体加密,正在自动解密...', 'warn');
      await decodeFont(window);
    }
    const els = Array.from(document.querySelectorAll('.questionLi'));
    if (!els.length) { log('未找到作业题目', 'warn'); return; }
    log(`📝 作业页,共 ${els.length} 题(填写后不会自动交卷,请检查后手动提交)`, 'ok');
    let okCount = 0;
    for (let i = 0; i < els.length; i++) {
      await randomSleep(CONFIG.answerIntervalMin, CONFIG.answerIntervalMax);
      const q = extractWorkQuestion(els[i]);
      if (!q) continue;
      const answers = await getAnswers(q);
      const ok = setQuizAnswer(answers, q, els[i], window);
      if (ok) okCount++;
      const size = (answers || []).join('').length;
      log(`第 ${i + 1}/${els.length} 题 ${ok ? `✓ 已作答(回读校验通过, ${size} 字)` : `✗ 写入失败或无可匹配答案(收到 ${size} 字)`}`, ok ? 'ok' : 'warn');
    }
    log(`作业填写完成(${okCount}/${els.length}),请人工检查后手动提交`);
  }

  /* ==================== 通用判据 / 任务点 / 栏目（参考 GitHub 成熟实现） ==================== */
  // 判据来源：
  //   · Xiongxiangyu2778/chaoxing-auto-study：.ans-job-icon 的 aria-label 是权威判据
  //   · Flyer2333/xuexitong-ai-assistant：ans-job-finished / 任务点完成判定
  //   · wohuihaohaoaini/course-runner-extension：任务点 iframe 的 data JSON（jobid/name）
  //   · zhu-hailin/chaoxing-ai-assistant：按“栏目（任务点标签）”逐个遍历

  function textOf(el) {
    try { return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim(); } catch (e) { return ''; }
  }

  function isElVisible(el) {
    if (!el) return false;
    try {
      if (!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length))) return false;
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      if (win) {
        const st = win.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      }
      return true;
    } catch (e) { return false; }
  }

  function parseFrameData(frame) {
    try {
      const raw = frame && frame.getAttribute && frame.getAttribute('data');
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }

  function jobIconDone(icon) {
    if (!icon) return true;
    try {
      const label = String(icon.getAttribute('aria-label') || '');
      if (label.indexOf('已完成') !== -1) return true;
      if (String(icon.className || '').indexOf('ans-job-finished') !== -1) return true;
    } catch (e) { /* ignore */ }
    return jobMarkedDone(jobContainer(icon));
  }

  function jobContainer(icon) {
    if (!icon) return null;
    try { if (icon.closest) return icon.closest('.ans-attach-ct') || icon.parentElement; } catch (e) { /* ignore */ }
    return icon.parentElement || null;
  }

  function jobIframeOf(icon) {
    const box = jobContainer(icon);
    if (!box) return null;
    try { return box.querySelector('iframe'); } catch (e) { return null; }
  }
  // 测验 / 作业类任务点（内部是 /ananas/modules/work/）。
  // 默认不处理：这类任务点不参与“等全部变绿”，否则脚本会以为本节一直没做完，
  // 每节都要空等好几轮才肯进下一节。
  function jobIsQuizIcon(icon) {
    const f = jobIframeOf(icon);
    if (!f) return false;
    const src = String(f.getAttribute('src') || f.src || '');
    return /ananas\/modules\/work\//.test(src) || /\/work\/index\.html/.test(src);
  }

  function jobMarkedDone(box) {
    if (!box) return false;
    try {
      if (String(box.className || '').indexOf('ans-job-finished') !== -1) return true;
      const icon = box.querySelector && box.querySelector('.ans-job-icon');
      if (icon) {
        const label = String(icon.getAttribute && icon.getAttribute('aria-label') || '');
        if (label.indexOf('已完成') !== -1) return true;
        if (String(icon.className || '').indexOf('ans-job-finished') !== -1) return true;
      }
      if (box.closest && box.closest('.ans-job-finished')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function pendingJobs(doc) {
    let list;
    try { list = Array.from(doc.querySelectorAll('.ans-job-icon')); } catch (e) { return 0; }
    let n = 0;
    for (const ic of list) {
      if (jobIconDone(ic)) continue;
      // 测验任务点按设置跳过：不算“未完成”，否则会卡住本节不让走
      if (!CONFIG.autoWork && jobIsQuizIcon(ic)) continue;
      n++;
    }
    return n;
  }

  // 章节内容如果不在 #iframe 里，就退回到任意 knowledge/cards iframe；再没有就用顶层页面。
  function cardsOwner() {
    let frame = null;
    try { frame = document.getElementById('iframe'); } catch (e) { /* ignore */ }
    if (!frame) {
      try { frame = document.querySelector('iframe[src*="knowledge/cards"]') || document.querySelector('iframe[src*="knowledge/card"]'); } catch (e) { /* ignore */ }
    }
    if (frame) {
      try {
        const win = frame.contentWindow;
        if (win && win.document) return { win: win, doc: win.document, frame: frame };
      } catch (e) { /* 跨域 */ }
    }
    return { win: window, doc: document, frame: null };
  }

  function eachDoc(fn, maxDepth = 3) {
    const seen = new Set();
    const queue = [{ doc: document, d: 0 }];
    while (queue.length) {
      const item = queue.shift();
      const doc = item.doc;
      if (!doc || seen.has(doc)) continue;
      seen.add(doc);
      try { fn(doc); } catch (e) { /* ignore */ }
      if (item.d >= maxDepth) continue;
      let fs;
      try { fs = Array.from(doc.querySelectorAll('iframe')); } catch (e) { continue; }
      for (const f of fs) {
        try { if (f.contentDocument) queue.push({ doc: f.contentDocument, d: item.d + 1 }); } catch (e) { /* ignore */ }
      }
    }
  }

  // ── 人脸 / 滑块 / 验证码检测：只暂停自动操作，不点任何东西 ──
  let verifyHold = false;
  let verifyProbeAt = 0;
  let verifyProbeVal = false;
  const VERIFY_SEL = '#captcha,.captcha,[class*="captcha"],.verify-slider,.slide-verify,.nc-container,.nc_wrapper,' +
    'iframe[src*="captcha"],iframe[src*="verify"],[class*="faceVerify"],[class*="face-verify"],' +
    '[class*="liveness"],iframe[src*="face"]';
  const VERIFY_TXT = /拖动滑块|滑动验证|人机验证|请完成(下方|以下)?验证|访问过于频繁|操作过于频繁|环境异常|请进行人脸|正对摄像头|请眨眼|眨眨眼|张张嘴|活体检测/;

  function findVerifyPrompt() {
    const now = Date.now();
    if (now - verifyProbeAt < 2000) return verifyProbeVal;
    verifyProbeAt = now;
    verifyProbeVal = false;
    eachDoc((doc) => {
      if (verifyProbeVal) return;
      let el = null;
      try { el = doc.querySelector(VERIFY_SEL); } catch (e) { /* ignore */ }
      if (el && isElVisible(el)) { verifyProbeVal = true; return; }
      try {
        const txt = doc.body ? doc.body.innerText : '';
        if (txt && VERIFY_TXT.test(txt)) verifyProbeVal = true;
      } catch (e) { /* ignore */ }
    });
    return verifyProbeVal;
  }

  async function waitWhileVerify() {
    if (!findVerifyPrompt()) {
      if (verifyHold) { verifyHold = false; log('验证已结束，继续自动操作', 'ok'); }
      return;
    }
    verifyHold = true;
    log('检测到学习通验证（人脸 / 滑块 / 验证码），已暂停自动操作，完成后自动继续', 'warn');
    setStatus('检测到验证，已暂停自动操作…');
    let i = 0;
    while (findVerifyPrompt() && !PAUSED) {
      await sleep(2);
      i++;
      if (i % 30 === 0) log('仍在等待验证完成…', 'warn');
    }
    verifyHold = false;
    if (!PAUSED) log('验证已结束，继续自动操作', 'ok');
  }

  // ── “任务点已完成”全屏提示层：先关掉，避免挡住“下一节”按钮 ──
  function closeJobFinishTip() {
    let tips;
    try { tips = Array.from(document.querySelectorAll('[class*="jobFinishTip"],.jobFinishTip,.jobfinishtip')); } catch (e) { return false; }
    for (const tip of tips) {
      if (!isElVisible(tip)) continue;
      let btns;
      try { btns = Array.from(tip.querySelectorAll('a,button,span,div,i')); } catch (e) { continue; }
      let target = null;
      for (const b of btns) {
        const t = textOf(b);
        if (!t) continue;
        if (/^(关闭|我知道了|知道了|确定|好的|×|✕|✖)$/.test(t) && isElVisible(b)) { target = b; break; }
      }
      if (!target) {
        for (const b of btns) {
          if (/close/i.test(String(b.className || '')) && isElVisible(b)) { target = b; break; }
        }
      }
      if (target) {
        try { target.click(); } catch (e) { /* ignore */ }
        log('关闭“任务点已完成”提示层');
        return true;
      }
    }
    return false;
  }

  function insideAttach(el) {
    try { return !!(el.closest && el.closest('.ans-attach-ct')); } catch (e) { return false; }
  }
  function insideTip(el) {
    try { return !!(el.closest && el.closest('[class*="jobFinishTip"],.jobFinishTip,.jobfinishtip')); } catch (e) { return false; }
  }

  // ── 下一节：优先平台自己的导航类名；排除播放器 / 任务点里 / 提示层里的“下一节” ──
  function clickNextSection() {
    closeJobFinishTip();
    const sels = ['#prevNextFocusNext', '.prev_next.next', '.jb_btn.nextChapter', '.nextChapter'];
    for (const sel of sels) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { /* ignore */ }
      if (!el || !isElVisible(el) || insideAttach(el) || insideTip(el)) continue;
      try { el.click(); } catch (e) { /* ignore */ }
      log('→ 点击“下一节”', 'ok');
      return true;
    }
    let nodes;
    try { nodes = Array.from(document.querySelectorAll('button,a,span,div')); } catch (e) { return false; }
    for (const n of nodes) {
      if (!isElVisible(n) || (n.closest && n.closest('.xt-seq-panel'))) continue;
      if (insideAttach(n) || insideTip(n)) continue;
      try { if (n.closest('#coursetree,.posCatalog,.chapterList,.chapter-list,.posCatalog_box')) continue; } catch (e) { /* ignore */ }
      const t = textOf(n).replace(/^[<←«‹\s]+/, '').replace(/[>→»›\s]+$/, '');
      if (t !== '下一节') continue;
      if (n.children && n.children.length > 2) continue;
      try { n.click(); } catch (e) { /* ignore */ }
      log('→ 点击“下一节”', 'ok');
      return true;
    }
    return false;
  }

  function sectionKey() {
    let key = '';
    try {
      const act = document.querySelector('#coursetree .posCatalog_active,.posCatalog_select.posCatalog_active,.posCatalog_active');
      if (act) key += textOf(act).slice(0, 40);
    } catch (e) { /* ignore */ }
    try {
      const frame = document.getElementById('iframe');
      const src = frame ? String(frame.getAttribute('src') || '') : '';
      const m = src.match(/knowledgeid=(\d+)/) || src.match(/chapterId=(\d+)/);
      if (m) key += '#' + m[1];
    } catch (e) { /* ignore */ }
    if (!key) {
      try {
        const h = document.querySelector('#prev_title,.prev_title,#chapterTitle,.chapter-title,.chapterTitle');
        if (h) key = textOf(h).slice(0, 60);
      } catch (e) { /* ignore */ }
    }
    return key || location.href;
  }

  async function waitJobsDone(doc, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (PAUSED) return false;
      if (pendingJobs(doc) === 0) return true;
      await sleep(1);
    }
    return pendingJobs(doc) === 0;
  }

  async function waitJobDoneFor(box, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (jobMarkedDone(box)) return true;
      try {
        const iframe = box && box.querySelector && box.querySelector('iframe');
        const win = iframe && iframe.contentWindow;
        if (win && typeof win.isUnFinishJob === 'function' && !win.isUnFinishJob()) return true;
      } catch (e) { /* ignore */ }
      await sleep(1);
    }
    return jobMarkedDone(box);
  }

  // ── 任务点标签（顶部 “1 教材 / 2 教学ppt / 3 教学视频 …”）──
  const TAB_TYPE_RULES = [
    { type: 'extraVideo', re: /(拓展|扩展|附加).*视频|视频.*(拓展|扩展)/ },
    { type: 'quiz', re: /知识点\s*(测验|检测|测试)|章节\s*(测验|测试)|单元\s*(测验|测试)|作业|考试|^测验|^测试/ },
    { type: 'ppt', re: /教学\s*ppt|教学课件|课件|幻灯片|ppt/i },
    { type: 'video', re: /教学视频|视频|微课|录像/ },
    { type: 'doc', re: /教材|讲义|电子书|文档|阅读/ },
  ];
  const TAB_KEEP = /^(教材|讲义|教学ppt|教学课件|课件|教学视频|视频|微课|知识点测验|知识点检测|知识点测试|章节测验|拓展视频|扩展视频|附加视频|作业|考试|测验)$/i;

  function normalizeTabLabel(raw) {
    let t = String(raw || '').replace(/\s+/g, '');
    t = t.replace(/^[✓✔√●○•·]+/, '');
    t = t.replace(/^[0-9０-９]+[.、,，:：]?/, '');
    t = t.replace(/^[✓✔√●○•·]+/, '');
    t = t.replace(/[（(][^）)]{0,8}[）)]$/, '');
    t = t.replace(/(任务点)?(已完成|未完成|待完成|未学习|未开始)$/, '');
    t = t.replace(/[✓✔√●○•·]+$/, '');
    return t;
  }

  function tabTypeOf(label) {
    if (!label || label.length > 14) return null;
    for (const rule of TAB_TYPE_RULES) {
      try { if (rule.re.test(label)) return rule.type; } catch (e) { /* ignore */ }
    }
    return null;
  }

  function collectTaskTabs() {
    const out = [];
    const seen = new Set();
    const docs = [document];
    try {
      const o = cardsOwner();
      if (o.doc && o.doc !== document) docs.push(o.doc);
    } catch (e) { /* ignore */ }
    for (const doc of docs) {
      let list;
      try {
        list = Array.from(doc.querySelectorAll('a,button,span,li,div,[class*="tab"],[class*="job"],[class*="point"]'));
      } catch (e) { continue; }
      for (const el of list) {
        if (seen.has(el)) continue;
        if (!isElVisible(el) || (el.closest && el.closest('.xt-seq-panel'))) continue;
        try {
          if (el.closest('#coursetree,.posCatalog,.chapterList,.chapter-list,.posCatalog_box')) continue;
          const box = el.getBoundingClientRect();
          if (box.left > (window.innerWidth || 1200) * 0.62) continue;
        } catch (e) { /* ignore */ }
        const raw = textOf(el);
        if (!raw || raw.length > 18) continue;
        const label = normalizeTabLabel(raw);
        if (!label || label.length > 12) continue;
        if (!TAB_KEEP.test(label)) continue;
        const type = tabTypeOf(label);
        if (!type) continue;
        let hasInner = false;
        try {
          for (const kid of el.querySelectorAll('*')) {
            const t = normalizeTabLabel(textOf(kid));
            if (t && TAB_KEEP.test(t)) { hasInner = true; break; }
          }
        } catch (e) { /* ignore */ }
        if (hasInner) continue;
        seen.add(el);
        out.push({ el, label, type, key: type + ':' + label });
      }
    }
    const picked = [];
    const used = new Set();
    for (const t of out) {
      if (used.has(t.key)) continue;
      used.add(t.key);
      picked.push(t);
    }
    return picked;
  }

  function isTabActive(el) {
    let cur = el;
    for (let i = 0; i < 2 && cur && cur.nodeType === 1; i++, cur = cur.parentElement) {
      const cls = String(cur.className || '');
      if (/(^|\s)(active|current|selected|checked|cur|is-active|is-current|tab-active)(\s|$)/i.test(cls)) return true;
      try {
        if (cur.getAttribute('aria-selected') === 'true') return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  let visitedTabKeys = new Set();
  let lastSectionKey = '';

  function pickUnvisitedTab() {
    const tabs = collectTaskTabs();
    if (!tabs.length) return null;
    for (const t of tabs) {
      if (isTabActive(t.el)) visitedTabKeys.add(t.key);
    }
    return tabs.find((t) => !visitedTabKeys.has(t.key) && t.type !== 'quiz') || null;
  }

  function contentSig() {
    const o = cardsOwner();
    let ic = 0, boxes = 0;
    try {
      ic = o.doc.querySelectorAll('.ans-job-icon').length;
      boxes = o.doc.querySelectorAll('.ans-attach-ct').length;
    } catch (e) { /* ignore */ }
    let src = '';
    try {
      const frame = document.getElementById('iframe');
      if (frame) src = String(frame.getAttribute('src') || '');
    } catch (e) { /* ignore */ }
    return src + '|' + ic + '|' + boxes;
  }

  async function clickTabAndWait(t) {
    const before = contentSig();
    visitedTabKeys.add(t.key);
    log('→ 切换到任务点「' + t.label + '」');
    setStatus('切换到任务点「' + t.label + '」…');
    try { t.el.click(); } catch (e) { /* ignore */ }
    for (let i = 0; i < 20; i++) {
      await sleep(1);
      if (PAUSED) return false;
      if (contentSig() !== before) break;
    }
    await sleep(1.5);
    try {
      const o = cardsOwner();
      if (o.frame && o.frame.contentDocument && o.frame.contentDocument.readyState !== 'complete') {
        await waitIframeLoaded(o.frame, 15000);
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  /* ==================== 章节主循环 ==================== */
  /* ==================== 章节主循环 ==================== */
  let running = false;
  let lastIframeUrl = '';

  // 通用:按可见文本点击元素(tab/按钮)
  function clickByText(win, texts) {
    const nodes = win.document.querySelectorAll('button, a, div, span, li');
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (!t || t.length > 20) continue;
      for (const kw of texts) {
        if (t === kw || (t.includes(kw) && !n.querySelector('input'))) {
          try { n.click(); } catch (e) { /* ignore */ }
          return true;
        }
      }
    }
    return false;
  }

  // 顶层弹题处理(2026 新版弹题直接渲染在顶层 document,选项是 radio)
  async function topLevelQuiz() {
    const els = Array.from(document.querySelectorAll('.TiMu'));
    if (els.length) {
      log(`📝 检测到顶层测验(共 ${els.length} 题)`, 'ok');
      let okCount = 0;
      for (let i = 0; i < els.length; i++) {
        await randomSleep(CONFIG.answerIntervalMin, CONFIG.answerIntervalMax);
        const q = extractQuizQuestion(els[i]);
        if (!q) continue;
        const answers = await getAnswers(q);
        const ok = setQuizAnswer(answers, q, els[i], window);
        if (ok) okCount++;
        log(`第 ${i + 1}/${els.length} 题 ${ok ? '✓ 已作答' : '✗ 无答案'}`, ok ? 'ok' : 'warn');
      }
      log(`顶层测验作答完成(${okCount}/${els.length}),请留意提交按钮`, 'ok');
      return;
    }
    const container = heuristicFindQuiz(window);
    if (container) {
      const q = extractHeuristicQuestion(container);
      if (q && q.question) {
        log(`❓ 检测到顶层弹题: ${q.question.slice(0, 40)}...`, 'warn');
        const answers = await getAnswers(q);
        const ok = setHeuristicAnswer(answers, q, container);
        log(ok ? '弹题已作答' : '弹题未能作答', ok ? 'ok' : 'warn');
        await sleep(0.3);
        clickButtonByText(window, ['继续学习', '确定', '提交', '下一题', '关闭', '继续', '我知道了']);
      }
    }
  }

  // 新版知识卡片循环(2025-2026 knowledge/cards 结构:卡片内嵌视频/图片/检测模块,顶层切节)
  async function newChapterLoop(cardsWin) {
    log('🧭 检测到新版知识卡片结构,启用新适配', 'ok');
    const limitHit = () => {
      try {
        const txt = String(document.body ? document.body.textContent : '') + ' ' + String(cardsWin.document.body ? cardsWin.document.body.textContent : '');
        return txt.includes('今日视频任务点完成数已达上限');
      } catch (e) { return false; }
    };
    if (limitHit()) {
      log('⏹ 平台提示:今日视频任务点已达上限,跳过视频任务(明天恢复),只处理学习检测', 'warn');
    }
    // 0) 顶层题目(新版弹题/判断题直接渲染在顶层 document)
    if (CONFIG.autoWork) await topLevelQuiz();
    // 1) 学习检测:点击 tab → 等 work iframe → 做题;若无 work iframe 则尝试顶层题目
    if (CONFIG.autoWork) {
      const tabClicked = clickByText(cardsWin, ['学习检测', '学习测验']);
      if (tabClicked) {
        await sleep(2);
        let workFrame = null;
        for (let i = 0; i < 20 && !workFrame; i++) {
          const fs = Array.from(cardsWin.document.querySelectorAll('iframe'));
          workFrame = fs.find((f) => /\/ananas\/modules\/work\//.test(String(f.src || ''))) || null;
          if (!workFrame) await sleep(1);
        }
        if (workFrame) {
          await workTask(workFrame);
          log('✓ 学习检测完成', 'ok');
        } else {
          log('学习检测 tab 已点,但未找到 work iframe,尝试顶层题目', 'warn');
          await topLevelQuiz();
        }
      }
    }
    // 2) 视频任务(平台未限流时)
    if (!limitHit()) {
      let videoFrame = null;
      for (let i = 0; i < 20 && !videoFrame; i++) {
        const fs = Array.from(cardsWin.document.querySelectorAll('iframe'));
        videoFrame = fs.find((f) => /\/ananas\/modules\/video\//.test(String(f.src || ''))) || null;
        if (!videoFrame) await sleep(1);
      }
      if (videoFrame && CONFIG.autoVideo) {
        await videoTask(videoFrame, cardsWin);
      }
    }
    // 3) 图片任务
    {
      const fs = Array.from(cardsWin.document.querySelectorAll('iframe'));
      const imgFrame = fs.find((f) => /\/ananas\/modules\/(img|image|picture)\//.test(String(f.src || '')));
      if (imgFrame && CONFIG.autoImage) await imageTask(imgFrame);
    }
    // 3.5) PDF/文档任务(纯 PDF 单模块卡片,如 3.8 节)
    {
      const fs = Array.from(cardsWin.document.querySelectorAll('iframe'));
      const pdfFrame = fs.find((f) => /\/ananas\/modules\/pdf\//.test(String(f.src || '')));
      if (pdfFrame && CONFIG.autoDocs) await pdfTask(pdfFrame);
    }
    // 4) 切下一节
    await sleep(0.3);
    if (CONFIG.autoJump && clickNextSection()) {
      log('→ 切换到下一节', 'ok');
    } else {
      log('未找到"下一节"按钮(可能已是最后一节)', 'warn');
    }
  }

  async function chapterLoop() {
    if (PAUSED) return;
    if (dailyLimitReached) { log('今日刷课已达上限，停止任务处理', 'warn'); return; }

    // 等章节 iframe 加载好再读任务点（新页面内容是异步渲染的）
    let waitFrame = null;
    try { waitFrame = document.getElementById('iframe'); } catch (e) { /* ignore */ }
    if (!waitFrame) {
      for (let i = 0; i < 30 && !waitFrame; i++) {
        await sleep(1);
        try { waitFrame = document.getElementById('iframe') || document.querySelector('iframe[src*="knowledge/cards"]'); } catch (e) { /* ignore */ }
      }
    }
    if (waitFrame) {
      try { await waitIframeLoaded(waitFrame, 30000); } catch (e) { /* ignore */ }
    }

    let owner = cardsOwner();
    if (!owner.doc) { log('找不到章节内容，跳过本轮', 'warn'); return; }

    const key = sectionKey();
    if (key !== lastSectionKey) {
      visitedTabKeys.clear();
      lastSectionKey = key;
      log('进入新小节：' + key.slice(0, 60));
    }
    try { if (typeof window.scroll2Job === 'function') window.scroll2Job(); } catch (e) { /* ignore */ }

    await waitWhileVerify();
    let attempts = 0;

    for (let round = 0; round < 8; round++) {
      if (PAUSED) return;
      await waitWhileVerify();

      owner = cardsOwner();
      const doc = owner.doc || document;
      let icons;
      try { icons = Array.from(doc.querySelectorAll('.ans-job-icon')); } catch (e) { icons = []; }

      // 没有任务点图标：先等异步渲染，别把“还没加载”当成“没有任务点”
      if (!icons.length) {
        if (round === 0) {
          for (let w = 0; w < 15; w++) {
            await sleep(1);
            if (PAUSED) return;
            try { icons = Array.from(cardsOwner().doc.querySelectorAll('.ans-job-icon')); } catch (e) { icons = []; }
            if (icons.length) break;
          }
        }
        if (!icons.length) {
          if (round === 0) { await newChapterLoop(owner.win || window); return; }
          break;
        }
      }

      const quizPending = CONFIG.autoWork
        ? []
        : icons.filter((ic) => !jobIconDone(ic) && jobIsQuizIcon(ic));
      if (quizPending.length) {
        log('本节有 ' + quizPending.length + ' 个测验任务点（按设置跳过，不答题、不交卷）');
      }
      const pending = icons.filter((ic) =>
        !jobIconDone(ic) && !(!CONFIG.autoWork && jobIsQuizIcon(ic)));
      if (pending.length) {
        log('本节还有 ' + pending.length + ' 个任务点待处理');
        for (const icon of pending) {
          if (PAUSED) return;
          await waitWhileVerify();
          if (jobIconDone(icon)) continue;

          const container = jobContainer(icon);
          if (jobMarkedDone(container)) continue;
          let iframe = null;
          try { iframe = container ? container.querySelector('iframe') : null; } catch (e) { /* ignore */ }
          if (!iframe) { log('任务点里没有 iframe，跳过', 'warn'); continue; }

          const src = String(iframe.getAttribute('src') || iframe.src || '');
          const data = parseFrameData(iframe);
          const name = data.name || data.title || (data.property && data.property.name) || '';
          log('开始任务点：' + (name || src.slice(-50)));

          try {
            if (/ananas\/modules\/video\//.test(src)) {
              if (CONFIG.autoVideo) await videoTask(iframe, owner.win || window);
              else log('视频任务点：按设置跳过');
            } else if (/ananas\/modules\/audio\//.test(src)) {
              if (CONFIG.autoAudio) await audioTask(iframe);
              else log('音频任务点：按设置跳过');
            } else if (/ananas\/modules\/work\//.test(src)) {
              if (CONFIG.autoWork) await workTask(iframe);
              else log('测验任务点：按设置跳过（不答题、不交卷）');
            } else if (/ananas\/modules\/pdf\//.test(src)) {
              if (CONFIG.autoDocs) await pdfTask(iframe);
              else log('文档任务点：按设置跳过');
            } else if (/ananas\/modules\/(img|image|picture)\//.test(src)) {
              if (CONFIG.autoImage) await imageTask(iframe);
              else log('图片任务点：按设置跳过');
            } else {
              log('未识别任务类型：' + src.slice(0, 120), 'warn');
            }
          } catch (e) {
            log('任务处理异常：' + (e && e.message ? e.message : e), 'err');
          }
          await randomSleep(1, 2);
        }

        // 等平台把这一页的任务点全部标记完成
        const ok = await waitJobsDone(doc, 25000);
        if (!ok) {
          attempts++;
          log('任务点还没全部确认完成（第 ' + attempts + ' 次核对）', 'warn');
          if (attempts >= 3) {
            log('多次核对仍未全部变绿，先进入下一节；回头可手动补这一节', 'warn');
            break;
          }
          await sleep(3);
          continue;
        }
        log('✓ 当前页面任务点全部完成', 'ok');
      }

      // 任务点都完成了：如果还有没访问过的任务点标签（栏目），切过去继续
      const nextTab = pickUnvisitedTab();
      if (nextTab) {
        const switched = await clickTabAndWait(nextTab);
        if (!switched) break;
        // 切换后重新读取这一栏目的任务点
        continue;
      }
      break;
    }

    if (PAUSED) return;

    if (!CONFIG.autoJump) {
      setStatus('本节任务点处理完毕（自动切节已关闭）');
      return;
    }
    const left = pendingJobs((cardsOwner().doc) || document);
    if (left > 0) log('注意：仍有 ' + left + ' 个任务点未确认完成，即将进入下一节', 'warn');
    setStatus('本节完成，准备进入下一节…');
    await randomSleep(2, 4);
    if (clickNextSection()) log('→ 已进入下一节', 'ok');
    else log('未找到“下一节”按钮（可能已是最后一节）', 'warn');
    visitedTabKeys.clear();
  }

  function startWatch() {
    initPanel();

    // 是否自动运行：默认开启；用户点过“停止”后，跨页面也保持停止。
    try {
      const saved = (typeof GM_getValue !== 'undefined') ? GM_getValue(RUN_KEY, true) : true;
      PAUSED = !saved;
    } catch (e) { PAUSED = false; }

    log('引擎已加载（逻辑：DaRin1403/xuexitong-autostudy，MIT）');
    if (!PAUSED) setStatus('运行中…等待任务点');
    else setStatus('已停止。点“启动”开始。');

    let lastIframeUrl = '';
    setInterval(async () => {
      if (PAUSED || running) return;
      // 章节 iframe 还没出现就先等
      try {
        if (!document.getElementById('iframe') && !document.querySelector('iframe[src*="knowledge/cards"]')) return;
      } catch (e) { /* ignore */ }
      const owner = cardsOwner();
      let pending = 0;
      try { pending = pendingJobs(owner.doc); } catch (e) { /* ignore */ }
      let url = '';
      try {
        url = (owner.frame && owner.frame.contentWindow)
          ? owner.frame.contentWindow.location.href
          : location.href;
      } catch (e) { url = location.href; }
      const urlChanged = url !== lastIframeUrl;
      const staleRun = Date.now() - lastRunAt > 8000;
      // 有未完成任务点、且上次处理已过去 8 秒 → 兜底再跑一轮（防止 iframe URL 不变时卡住）
      if (!urlChanged && !(pending > 0 && staleRun)) return;
      lastIframeUrl = url;
      lastRunAt = Date.now();
      running = true;
      setStatus('处理中…');
      try {
        await chapterLoop();
      } catch (e) {
        log('主循环异常：' + (e && e.message ? e.message : e), 'err');
      }
      running = false;
      if (PAUSED) setStatus('已停止。点“启动”开始。');
      else setStatus('待机中…');
    }, 3000);
  }

  /* ==================== 路由 ==================== */
  (function main() {
    try { startReporterHeartbeat(); } catch (e) { /* ignore */ }

    const path = location.pathname;
    const chapterPages = ['/mycourse/studentstudy', '/mooc-ans/mycourse/studentstudy', '/mooc2-ans/mycourse/studentstudy'];
    const hit = (list) => list.some((p) => path === p || path.indexOf(p) !== -1);

    if (hit(chapterPages)) {
      initPanel();
      if (!location.href.includes('mooc2=1')) {
        log('检测到旧版章节页，正在切换到新版（mooc2）…', 'warn');
        location.href += (location.href.includes('?') ? '&' : '?') + 'mooc2=1';
        return;
      }
      startWatch();
    } else {
      // 作业 / 测验 / 考试页一律不碰：只刷课程章节里的任务点。
      console.log('[顺序播放] 当前不是课程章节页，脚本待机（测验/作业/考试不处理）。');
    }
  })();
})();
