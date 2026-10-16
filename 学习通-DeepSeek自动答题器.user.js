// ==UserScript==
// @name         学习通 DeepSeek 自动答题器
// @namespace    https://api.deepseek.com/
// @version      2.1.0
// @description  学习通(超星)章节/作业/测验页面：填入自己的 DeepSeek API Key，点击启动后自动识别题目并调用 DeepSeek 作答（字体加密题自动截图走 deepseek-flash 视觉识别），自动提交、自动下一节。
// @author       you
// @match        *://*.chaoxing.com/*
// @match        *://*.xuexi365.cn/*
// @match        *://*.chaoxing.com.cn/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      cdn.staticfile.org
// @connect      cdn.bootcdn.net
// @connect      cdnjs.cloudflare.com
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// ==/UserScript==

/*
 * 使用说明：
 * 1. 安装 Tampermonkey（篡改猴）扩展 → 新建脚本 → 把本文件全部内容粘贴进去并保存（Ctrl+S）。
 * 2. 打开学习通课程章节/作业/测验页面，右上角面板中粘贴你的 DeepSeek API Key（sk-开头），点“保存”。
 *    Key 只保存在浏览器本地（localStorage），不会发送给任何第三方。
 * 3. 点击「▶ 启动」。第一次请求 API 时 Tampermonkey 可能弹出跨域授权（api.deepseek.com），选“始终允许”。
 * 4. 题目在学习通页面里是嵌套 iframe 加载的，脚本会自动递归扫描同源 iframe，无需手动处理。
 * 5. DeepSeek API Key 申请：https://platform.deepseek.com → API Keys。
 */

(function () {
  'use strict';

  // 仅在顶层窗口运行（题目在 iframe 里会通过 contentDocument 递归扫描）
  if (window.top !== window.self) return;

  /* ============================ 配置区 ============================ */
  const STORE_KEY = 'ds-answer-settings-v1';
  const CONFIG = {
    // DeepSeek API（Key 在面板中填写，保存在浏览器 localStorage）
    API_KEY: '',
    API_URL: 'https://api.deepseek.com/chat/completions',
    MODEL: 'deepseek-flash',        // 文本模型（面板可切换）
    MODEL_VISION: 'deepseek-flash', // 视觉模型：deepseek-flash 原生支持图片（字体加密题截图识别）
    VISION_BATCH: 5,                // 视觉请求每批最多几张题块图
    TEMPERATURE: 0.1,
    // html2canvas 截图库 CDN（按顺序尝试，国内优先）
    H2C_URLS: [
      'https://cdn.staticfile.org/html2canvas/1.4.1/html2canvas.min.js',
      'https://cdn.bootcdn.net/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'
    ],
    // 行为
    AUTO_SUBMIT: true,              // 答完是否自动点击“提交/交卷”并确认弹窗
    ENABLE_SUBJECTIVE: false,       // 是否自动作答简答题/论述题（textare a，默认关闭）
    STEP_DELAY: 1200,               // 每轮操作之间的等待(ms)
    PAGE_TIMEOUT: 15000,            // 点击下一节后等待新内容的超时(ms)
    MAX_SECTIONS: 500,              // 安全阀：最多处理多少节
    SCROLL_STEPS: 3,                // 页面加载时向下滚动的次数（触发懒加载）
    // 学习通题目容器选择器（按优先级）
    QUESTION_BLOCK_SEL: [
      '.TiMu', '.questionLi', '.mark_question', '.exam-question',
      '.qtLi', '.question-item', '[class*="Question"]'
    ].join(','),
    // 题干选择器
    TITLE_SEL: '.Zy_TItle .clearfix, .Cy_TItle, .TiMu-title, .theme-title, .question_name, .qt_title, .mark_name',
    // 选项行选择器
    OPTION_SEL: 'ul.nr_ul li, ul.option-list li, .Zy_ulTop li, .Zy_ulBottom li, .answerBg li, .option-item',
    // 下一节按钮（内容区任务点之间的“下一节”，绝不点目录树）
    NEXT_BTN_SEL: '#nextBtn, .nextBtn, .next_btn, .next-btn, .nextbtn, .nextChapter, .jb_btn_next, .jb-btn-next, .js-nextBtn, a.nextBtn, [class*="nextBtn"], [class*="next_btn"]',
    // 内容区按钮条容器（下一节按钮通常在这些容器里）
    NEXT_BAR_SEL: '.jb_btn, .jb-btn, .j-b-btn, .control, .controls, .btn-group, .btnGroup, .footBtn, .foot_btn, .pageBtn, .page_btn, .nav-btn, .navBtn, .bottom-btn, .bottomBtn, .btns, .nextBar, .ans-job, .taskPoint, .catalogue_card_footer',
    // 下一节按钮文本（只点任务点级别的“下一节”，严禁“下一章/下一单元”——那会跳过本章检测）
    NEXT_BTN_TEXT: ['下一节', '下一页', '下一讲', '下一课时', '继续学习', '下一个', 'Next'],
    // 课程目录树/章节导航容器：这些区域内的任何链接都不点
    CATALOG_SEL: [
      '#chapterList', '.chapterList', '.chapter-list', '#coursetree', '.coursetree', '.course-tree',
      '.posCatalog', '.posCatalog_select', '.posCatalog_scroll', '.posCatalog_content',
      '.ncells', '.ncells_content', '.catalog', '.catalog_box', '.catalogContent', '.catalog_content',
      '.dirList', '.dir-list', '.chapter_item', '.chapter-item', '.chapterItem', '.knowledgeItem',
      '.sidebar', '.side-bar', '.left-menu', '.leftmenu', '.right-menu', '.rightmenu', '.menu',
      '#magazine', '.magazine', '.chapterNum', '.chapter-text', '.chapterText', '.chapter_name',
      '.prev_next_menu', '.crumb', '.breadcrumb', '#courseChapter', '.chapterContent',
      '.section-list', '.sectionList', '.knowledge-list', '.tree', '[class*="catalog"]'
    ].join(','),
    // 找不到下一节按钮时的滚动重试次数（每次约 1.2s），超过则判定课程结束
    NO_NEXT_RETRIES: 5,
    // 提交按钮文本
    SUBMIT_TEXT: ['提交', '交卷', '保存并提交', '提交作业', '提交试卷', '我要交卷', '确认提交'],
    // 弹窗“确认”类按钮文本（按优先级排序，越靠前越优先）
    CONFIRM_TEXT: ['确认提交', '确定提交', '继续提交', '我要交卷', '确认交卷', '确认', '确定', '提交', '是的', '是 ', 'OK'],
    // 弹窗“取消/放弃”类按钮文本（绝不点击）
    CANCEL_TEXT: ['取消', '再检查', '继续检查', '继续答题', '再想想', '再检查一下', '否', '返回', '继续浏览'],
    // 上一节/禁用类文本（用于排除误点）
    EXCLUDE_TEXT: ['上一节', '上一页', '上一章', '返回', '重做', '再做一次']
  };
  /* =============================================================== */

  // 设置持久化（保存在学习通顶层页面的 localStorage，仅本地浏览器）
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (s.key) CONFIG.API_KEY = s.key;
      if (s.model) CONFIG.MODEL = s.model;
      if (typeof s.autoSubmit === 'boolean') CONFIG.AUTO_SUBMIT = s.autoSubmit;
      if (typeof s.subjective === 'boolean') CONFIG.ENABLE_SUBJECTIVE = s.subjective;
    } catch (e) {}
  }
  function saveSettings(patch) {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      Object.assign(s, patch);
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch (e) {}
  }
  loadSettings();

  let running = false;
  let sections = 0;

  /* ------------------------------ UI ------------------------------ */
  const ui = {};
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #glm-panel{position:fixed;top:80px;right:16px;width:330px;z-index:2147483647;
        font-family:"Microsoft YaHei",sans-serif;font-size:13px;color:#e8eefc;
        background:rgba(20,26,40,.94);border:1px solid #3a4a6b;border-radius:10px;
        box-shadow:0 8px 30px rgba(0,0,0,.4);overflow:hidden}
      #glm-panel .hd{display:flex;align-items:center;justify-content:space-between;
        padding:8px 12px;background:#243049;cursor:move;font-weight:600}
      #glm-panel .hd b{font-size:13px}
      #glm-panel .hd span{cursor:pointer;padding:0 4px;opacity:.7}
      #glm-panel .bd{padding:10px 12px}
      #glm-panel .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
      #glm-panel button{border:0;border-radius:6px;padding:6px 14px;cursor:pointer;
        font-size:13px;font-weight:600;color:#fff}
      #glm-panel .start{background:#2e9e5b;flex:1}
      #glm-panel .stop{background:#c0392b;flex:1;display:none}
      #glm-panel .save{background:#3f6fb5;flex:0 0 56px}
      #glm-panel input[type=password],#glm-panel input[type=text],#glm-panel select{
        background:#121827;border:1px solid #3a4a6b;border-radius:6px;color:#e8eefc;
        padding:6px 8px;font-size:12px;flex:1;min-width:0;outline:none}
      #glm-panel input[type=password]:focus,#glm-panel select:focus{border-color:#5b8def}
      #glm-panel label{display:flex;align-items:center;gap:4px;opacity:.9;cursor:pointer}
      #glm-panel .status{font-size:12px;opacity:.85;margin-bottom:6px}
      #glm-panel .log{height:230px;overflow-y:auto;background:#121827;border-radius:6px;
        padding:6px 8px;line-height:1.55;font-size:12px;word-break:break-all}
      #glm-panel .log .t{color:#6b7a99}
      #glm-panel .log .ok{color:#57d98b}
      #glm-panel .log .warn{color:#ffc857}
      #glm-panel .log .err{color:#ff7a7a}
      #glm-panel.collapsed .bd{display:none}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'glm-panel';
    panel.innerHTML = `
      <div class="hd"><b>DeepSeek 自动答题器</b><span id="glm-min">—</span></div>
      <div class="bd">
        <div class="status" id="glm-status">状态：待启动</div>
        <div class="row">
          <input type="password" id="ds-key" placeholder="DeepSeek API Key（sk-...）">
          <button class="save" id="ds-save">保存</button>
        </div>
        <div class="row">
          <select id="ds-model" title="选择模型">
            <option value="deepseek-flash">deepseek-flash（支持识图，推荐）</option>
            <option value="deepseek-v4-pro">deepseek-v4-pro（仅文本，更强）</option>
          </select>
        </div>
        <div class="row">
          <button class="start" id="glm-start">▶ 启动</button>
          <button class="stop" id="glm-stop">■ 停止</button>
        </div>
        <div class="row">
          <label><input type="checkbox" id="glm-submit" ${CONFIG.AUTO_SUBMIT ? 'checked' : ''}> 答完自动提交</label>
          <label><input type="checkbox" id="glm-subj" ${CONFIG.ENABLE_SUBJECTIVE ? 'checked' : ''}> 简答题</label>
        </div>
        <div class="row">
          <button id="glm-diag" style="background:#3f6fb5;flex:1">🔍 诊断本题（结果发助手）</button>
        </div>
        <div class="log" id="glm-log"></div>
      </div>`;
    document.body.appendChild(panel);

    ui.status = panel.querySelector('#glm-status');
    ui.log = panel.querySelector('#glm-log');
    ui.start = panel.querySelector('#glm-start');
    ui.stop = panel.querySelector('#glm-stop');
    ui.keyInput = panel.querySelector('#ds-key');
    ui.modelSel = panel.querySelector('#ds-model');

    // 初始化：回显已保存的 Key / 模型
    ui.modelSel.value = CONFIG.MODEL;
    refreshKeyHint();

    const saveKey = () => {
      const v = ui.keyInput.value.trim();
      if (!v) { log('请输入以 sk- 开头的 DeepSeek API Key', 'warn'); return; }
      CONFIG.API_KEY = v;
      saveSettings({ key: v });
      ui.keyInput.value = '';
      refreshKeyHint();
      log('DeepSeek API Key 已保存（仅存于本地浏览器）', 'ok');
    };
    panel.querySelector('#ds-save').onclick = saveKey;
    ui.keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
    ui.modelSel.onchange = () => {
      CONFIG.MODEL = ui.modelSel.value;
      saveSettings({ model: CONFIG.MODEL });
      log('文本模型已切换为：' + CONFIG.MODEL, 'ok');
    };
    ui.start.onclick = () => start();
    ui.stop.onclick = () => stop();
    panel.querySelector('#glm-submit').onchange = e => {
      CONFIG.AUTO_SUBMIT = e.target.checked;
      saveSettings({ autoSubmit: e.target.checked });
    };
    panel.querySelector('#glm-subj').onchange = e => {
      CONFIG.ENABLE_SUBJECTIVE = e.target.checked;
      saveSettings({ subjective: e.target.checked });
    };
    panel.querySelector('#glm-diag').onclick = () => diagnose();
    panel.querySelector('#glm-min').onclick = () => panel.classList.toggle('collapsed');
    makeDraggable(panel, panel.querySelector('.hd'));
  }

  function refreshKeyHint() {
    if (CONFIG.API_KEY) {
      const tail = CONFIG.API_KEY.slice(-4);
      ui.keyInput.placeholder = `已保存 sk-…${tail}（输入新 Key 可覆盖）`;
    } else {
      ui.keyInput.placeholder = 'DeepSeek API Key（sk-...）';
    }
  }

  function makeDraggable(el, handle) {
    let sx, sy, x, y, drag = false;
    handle.addEventListener('mousedown', e => {
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); x = r.left; y = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      el.style.left = Math.max(0, x + e.clientX - sx) + 'px';
      el.style.top = Math.max(0, y + e.clientY - sy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => drag = false);
  }

  function log(msg, type = '') {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.innerHTML = `<span class="t">${ts}</span> ${type ? `<span class="${type}">${msg}</span>` : msg}`;
    ui.log.appendChild(line);
    while (ui.log.childNodes.length > 200) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
    console.log('[DS答题]', msg.replace(/<[^>]+>/g, ''));
  }
  function setStatus(s) { ui.status.textContent = '状态：' + s; }

  /* ---------------------------- 工具函数 ---------------------------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = el.ownerDocument.defaultView?.getComputedStyle?.(el);
    if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList && (el.classList.contains('disabled') || el.classList.contains('disabledBtn'))) return false;
    return true;
  }

  // 递归收集所有同源 frame 的 document
  function getAllDocs(win = window.top, out = []) {
    try {
      out.push(win.document);
      const frames = win.frames;
      for (let i = 0; i < frames.length; i++) {
        try {
          const f = frames[i];
          if (f.document) getAllDocs(f, out);
        } catch (e) { /* 跨域 frame，跳过 */ }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function cleanText(s) {
    return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  // 模拟真实点击（兼容学习通 jQuery / Vue 绑定的事件）
  function nativeClick(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
      let ev;
      try {
        ev = t.startsWith('pointer')
          ? new PointerEvent(t, { ...opts, pointerId: 1 })
          : new MouseEvent(t, opts);
      } catch (e) { ev = new MouseEvent(t, opts); }
      el.dispatchEvent(ev);
    });
    try { el.click(); } catch (e) {}
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  // 全部 frame 中向下滚动，触发懒加载
  async function scrollAll(docs) {
    for (let i = 0; i < CONFIG.SCROLL_STEPS; i++) {
      docs.forEach(doc => {
        try {
          const se = doc.scrollingElement || doc.documentElement;
          if (se) se.scrollTop = Math.min(se.scrollHeight, se.scrollTop + se.clientHeight + 200);
          doc.querySelectorAll('*').forEach(el => {
            const s = getComputedStyle(el);
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
            }
          });
        } catch (e) {}
      });
      await sleep(350);
    }
  }

  /* ---------------------------- 题目采集 ---------------------------- */
  const TYPE_RE = /(单选题|单项选择题|多选题|多项选择题|判断题|是非题|填空题|简答题|问答题|论述题|名词解释|计算题|分析题)/;

  function collectQuestions(docs) {
    const questions = [];
    const seen = new Set();

    docs.forEach(doc => {
      // 1) 学习通标准题块
      let blocks = Array.from(doc.querySelectorAll(CONFIG.QUESTION_BLOCK_SEL)).filter(isVisible);

      // 2) 兜底：按 radio/checkbox 的 name 分组
      if (!blocks.length) {
        const inputs = Array.from(doc.querySelectorAll('input[type=radio],input[type=checkbox]'));
        const groups = new Map();
        inputs.forEach(inp => {
          const key = inp.form?.action || doc.URL + '|' + (inp.name || '');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(inp);
        });
        groups.forEach(group => {
          let box = group[0].closest('.TiMu,.questionLi,li,fieldset,form,div') || group[0].parentElement;
          if (box && !seen.has(box)) { blocks.push(box); seen.add(box); }
        });
      }

      blocks.forEach((box, i) => {
        if (seen.has(box) && box.matches?.(CONFIG.QUESTION_BLOCK_SEL)) return;
        seen.add(box);

        // 注意：学习通常把原生 radio/checkbox 用 CSS 隐藏（自定义样式），所以这里不能按可见性过滤
        const inputs = Array.from(box.querySelectorAll('input[type=radio],input[type=checkbox]'));
        const textInputs = Array.from(box.querySelectorAll('input[type=text],input:not([type]),textarea'))
          .filter(el => !el.disabled && !el.readOnly && el.type !== 'hidden' && el.offsetParent !== null);
        const textareas = textInputs.filter(el => el.tagName === 'TEXTAREA');
        const fillInputs = textInputs.filter(el => el.tagName !== 'TEXTAREA');

        // 题型
        const blockText = cleanText(box.textContent);
        let type = (blockText.match(TYPE_RE) || [])[0] || '';
        if (!type) {
          if (textareas.length && CONFIG.ENABLE_SUBJECTIVE) type = '简答题';
          else if (fillInputs.length) type = '填空题';
          else if (inputs.some(x => x.type === 'checkbox')) type = '多选题';
          else if (inputs.length) type = '单选题';
        }
        if (/简答|问答|论述|名词解释|计算|分析/.test(type) && !CONFIG.ENABLE_SUBJECTIVE) return;

        // 题干
        let titleEl = box.querySelector(CONFIG.TITLE_SEL);
        let title = cleanText(titleEl?.textContent);
        if (!title || title.length < 4) {
          const clone = box.cloneNode(true);
          clone.querySelectorAll('ul,input,button,style,script').forEach(n => n.remove());
          title = cleanText(clone.textContent);
        }
        title = title.replace(/^[0-9０-９]+\s*[、.．]?\s*/, '').slice(0, 600);
        if (!title) return;

        // 选项构建：优先以 radio/checkbox 为锚点反推选项行（最可靠）；
        // 没有原生 input 的纯 JS 组件才用 OPTION_SEL 选择器
        let options = [];
        if (inputs.length) {
          options = inputs.map((input, idx) => {
            const li = input.closest('li');
            const label = input.closest('label');
            const el = li || label || input.parentElement;
            // 字母：优先 input.value，其次字母标记 a.before/span.before/.font-label，最后按顺序
            const v = (input.value || '').trim().toUpperCase();
            const markText = cleanText(el.querySelector?.('a.before,span.before,a[class*="before"],.font-label,span[class*="letter"]')?.textContent);
            const mark = (markText && markText.charAt(0).toUpperCase().match(/[A-Z√×对错]/) || [])[0];
            const letter = (/^[A-Z]$/.test(v) ? v : mark) || String.fromCharCode(65 + idx);
            let text = cleanText(el.textContent);
            return {
              letter,
              text: text.slice(0, 300),
              el, li, label, input,
              checked: input.checked || /chosen|active|selected|(^|\s)cur(\s|$)|(^|\s)on(\s|$)/.test(el.className || '')
            };
          });
        } else {
          let optionEls = Array.from(box.querySelectorAll(CONFIG.OPTION_SEL)).filter(isVisible);
          // 去重：保留最内层（去掉包裹其他选项行的外层容器）
          optionEls = optionEls.filter((el, idx) =>
            optionEls.findIndex(o => o === el || (o.contains(el) && o !== el)) === idx);
          options = optionEls.slice(0, 26).map((el, idx) => {
            // 新版学习通：字母写在 <span class="num_option" data="A"> 上
            const num = el.querySelector('span.num_option,[data-letter],.num_option');
            const dataLetter = (num?.getAttribute('data') || num?.getAttribute('data-letter') || '').trim().toUpperCase();
            const letter = /^[A-Z]$/.test(dataLetter) ? dataLetter : String.fromCharCode(65 + idx);
            const checked = el.getAttribute('aria-checked') === 'true'
              || el.getAttribute('aria-pressed') === 'true'
              || /chosen|active|selected|(^|\s)cur(\s|$)|(^|\s)on(\s|$)/.test(el.className || '');
            return {
              letter,
              text: cleanText(el.textContent).slice(0, 300),
              el,
              li: el.tagName === 'LI' ? el : el.closest('li'),
              label: el.querySelector('label'),
              num,
              input: null,
              checked
            };
          }).filter(o => o.text);
        }

        // 字体加密检测：题块含 font-cxsecret 或 Unicode 私用区字符（截图走视觉模型）
        const encrypted = !!box.querySelector('.font-cxsecret,[class*="cxsecret"]')
          || /[\uE000-\uF8FF]/.test(box.textContent || '');

        // 已答判断
        let answered = false;
        if (inputs.length) answered = options.some(o => o.checked) || inputs.some(i => i.checked);
        else if (options.length) {
          // 新版学习通：aria-checked 或隐藏 answer input 的 value
          const hiddenAns = box.querySelector('input[type=hidden][name^="answer"]');
          answered = options.some(o => o.checked) || !!(hiddenAns && hiddenAns.value.trim());
        }
        else if (fillInputs.length) answered = fillInputs.every(i => i.value.trim());
        else if (textareas.length) answered = textareas.every(t => t.value.trim().length > 5);

        questions.push({
          doc, box, type, title, options, inputs, fillInputs, textareas, answered, encrypted,
          index: questions.length + 1
        });
      });
    });
    return questions;
  }

  /* ---------------------------- DeepSeek 请求 ---------------------------- */
  // 统一解析 API 错误（DeepSeek：401 认证失败 / 402 余额不足 / 429 限流）
  function formatApiError(status, text) {
    let msg = text.slice(0, 200);
    try {
      const d = JSON.parse(text);
      msg = d.error?.message || d.message || msg;
    } catch (e) {}
    if (status === 401) return 'API Key 无效或未授权（401），请检查 Key 是否正确';
    if (status === 402) return 'DeepSeek 账户余额不足（402），请充值后再试';
    if (status === 429) return '请求频率过高被限流（429），脚本会自动重试';
    return `HTTP ${status}：${msg}`;
  }

  function glmRequest(prompt) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.API_URL,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.API_KEY },
        data: JSON.stringify({
          model: CONFIG.MODEL,
          temperature: CONFIG.TEMPERATURE,
          messages: [
            {
              role: 'system',
              content: '你是一个严谨的答题助手。根据题目作答，必须只输出 JSON 数组，不要输出 markdown 代码块、解释或任何多余文字。'
            },
            { role: 'user', content: prompt }
          ]
        }),
        timeout: 60000,
        onload: r => {
          try {
            const data = JSON.parse(r.responseText);
            if (data.error || r.status >= 400) return reject(new Error(formatApiError(r.status, r.responseText)));
            resolve(data.choices?.[0]?.message?.content || '');
          } catch (e) { reject(new Error('响应解析失败: ' + r.responseText.slice(0, 200))); }
        },
        onerror: () => reject(new Error('网络请求失败（检查网络/篡改猴跨域授权）')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });
  }

  // GM 通用 GET（文本）
  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 30000,
        onload: r => r.status >= 200 && r.status < 400 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('下载失败: ' + url)),
        ontimeout: () => reject(new Error('下载超时: ' + url))
      });
    });
  }

  let h2cSource = null;
  // 加载 html2canvas 并注入到题目所在 frame 的 window（题目在 iframe 内，必须在该 frame 渲染）
  async function loadHtml2Canvas(win) {
    if (win.__h2c) return win.__h2c;
    if (!h2cSource) {
      let lastErr;
      for (const u of CONFIG.H2C_URLS) {
        try { h2cSource = await gmGetText(u); break; } catch (e) { lastErr = e; }
      }
      if (!h2cSource) throw lastErr || new Error('html2canvas 下载失败');
    }
    win.eval(h2cSource); // content script 上下文 eval，不受页面 CSP 限制
    win.__h2c = win.html2canvas;
    if (!win.__h2c) throw new Error('html2canvas 注入失败');
    return win.__h2c;
  }

  // 对题块截图，返回 JPEG dataURL（自定义字体在浏览器中渲染为正常文字，天然绕过字体反爬）
  async function shotQuestion(q) {
    const win = q.doc.defaultView;
    const h2c = await loadHtml2Canvas(win);
    try { q.box.scrollIntoView({ block: 'center' }); } catch (e) {}
    await sleep(300);
    const canvas = await h2c(q.box, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      window: win,
      width: q.box.scrollWidth,
      height: q.box.scrollHeight
    });
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  // 视觉模型请求（多图）
  function glmVisionRequest(images, batchQuestions) {
    const idxList = batchQuestions.map(q => q.index).join('、');
    const prompt = '下面按顺序是 ' + batchQuestions.length + ' 张学习通题目的截图，依次对应题号：' + idxList + '。\n' +
      '请逐题识别图片中的题干、题型和选项并作答，严格只输出 JSON 数组，不要输出 markdown 代码块或解释：\n' +
      '[{"index":题号,"answer":["A"]}]\n' +
      '规则：1. 单选题、判断题 answer 只含 1 个字母；多选题含多个字母，按字母顺序。\n' +
      '2. 判断题“正确/对/√”选对应正确项（通常为 A），“错误/错/×”选错误项（通常为 B）。\n' +
      '3. 题号必须与上面给定的题号一致。';
    const content = [{ type: 'text', text: prompt }];
    // detail=high 保留原图清晰度，保证题面小字可辨
    images.forEach(img => content.push({ type: 'image_url', image_url: { url: img, detail: 'high' } }));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.API_URL,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.API_KEY },
        data: JSON.stringify({
          model: CONFIG.MODEL_VISION,
          temperature: CONFIG.TEMPERATURE,
          messages: [{ role: 'user', content }]
        }),
        timeout: 120000,
        onload: r => {
          try {
            const data = JSON.parse(r.responseText);
            if (data.error || r.status >= 400) return reject(new Error(formatApiError(r.status, r.responseText)));
            resolve(data.choices?.[0]?.message?.content || '');
          } catch (e) { reject(new Error('视觉响应解析失败: ' + r.responseText.slice(0, 200))); }
        },
        onerror: () => reject(new Error('视觉请求失败（检查网络/篡改猴跨域授权）')),
        ontimeout: () => reject(new Error('视觉请求超时'))
      });
    });
  }

  function buildPrompt(questions) {
    let p = '请回答以下题目，严格只输出 JSON 数组，格式：\n' +
      '[{"index":题号,"answer":["A"]}]\n' +
      '规则：\n' +
      '1. 单选题、判断题：answer 只含1个选项字母；判断题“正确/对/√”选对应正确项字母，“错误/错/×”选错误项字母。\n' +
      '2. 多选题：answer 含多个字母，按字母顺序。\n' +
      '3. 填空题：answer 是与空数相同的字符串数组，每个元素为一个空的答案。\n' +
      '4. 简答题：answer 只含1个字符串，为完整参考答案（100字以内）。\n\n题目如下：\n';
    questions.forEach(q => {
      p += `\n${q.index}.【${q.type}】${q.title}\n`;
      if (q.options.length) q.options.forEach(o => { p += `${o.letter}. ${o.text}\n`; });
      if (/填空题/.test(q.type)) p += `（本题共 ${q.fillInputs.length} 个空）\n`;
    });
    return p;
  }

  function parseAnswers(content, questions) {
    const result = {};
    let arr = null;
    try { arr = JSON.parse(content); }
    catch (e) {
      const m = content.match(/\[[\s\S]*\]/);
      if (m) { try { arr = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (Array.isArray(arr)) {
      arr.forEach(item => {
        if (item && item.index != null) result[item.index] = [].concat(item.answer ?? item.ans ?? item.value ?? []);
      });
    }
    // 兜底：逐行解析 “1. A” 这种格式
    if (!Object.keys(result).length) {
      questions.forEach(q => {
        const re = new RegExp(`(?:^|\\n)\\s*${q.index}\\s*[\\.、．:]\\s*([A-ZＡ-Ｚ\\s、,，]+)`);
        const m = content.match(re);
        if (m) result[q.index] = m[1].replace(/[^\u0041-\u005a\uff21-\uff3a]/g, '').split('').map(c => {
          const code = c.charCodeAt(0);
          return code >= 0xff21 ? String.fromCharCode(code - 0xfee0) : c;
        });
      });
    }
    return result;
  }

  /* ---------------------------- 执行作答 ---------------------------- */
  async function answerQuestions(questions) {
    let answers = {};
    const useVision = questions.some(q => q.encrypted);

    try {
      if (useVision) {
        // 字体加密题：截图（浏览器按自定义字体正常渲染）→ 视觉模型
        log('检测到字体加密（font-cxsecret），改为截图交给视觉模型识别…', 'warn');
        const shots = new Map();
        for (const q of questions) {
          try {
            setStatus(`截图第 ${q.index} 题…`);
            shots.set(q.index, await shotQuestion(q));
          } catch (e) {
            log(`第 ${q.index} 题截图失败：${e.message}`, 'err');
          }
        }
        for (let i = 0; i < questions.length; i += CONFIG.VISION_BATCH) {
          if (!running) return false;
          const batch = questions.slice(i, i + CONFIG.VISION_BATCH).filter(q => shots.has(q.index));
          if (!batch.length) continue;
          const imgs = batch.map(q => shots.get(q.index));
          log(`视觉识别第 ${batch[0].index}–${batch[batch.length - 1].index} 题（${imgs.length} 张图）…`);
          const content = await glmVisionRequest(imgs, batch);
          log('视觉模型返回：' + content.slice(0, 120).replace(/\n/g, ' '));
          Object.assign(answers, parseAnswers(content, batch));
          await sleep(500);
        }
      } else {
        log(`正在请求 DeepSeek（${CONFIG.MODEL}）作答 ${questions.length} 道题…`);
        const content = await glmRequest(buildPrompt(questions));
        log('DeepSeek 已返回：' + content.slice(0, 120).replace(/\n/g, ' '));
        answers = parseAnswers(content, questions);
      }
    } catch (e) {
      log('模型请求失败：' + e.message, 'err');
      await sleep(3000);
      return false;
    }

    for (const q of questions) {
      if (!running) return false;
      const ans = answers[q.index];
      if (!ans || !ans.length) { log(`第 ${q.index} 题未取得答案，跳过`, 'warn'); continue; }

      try { q.box.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(200);

      if (/填空/.test(q.type)) {
        q.fillInputs.forEach((inp, i) => {
          const v = (ans[i] ?? ans[0] ?? '').toString().trim();
          if (v) { setNativeValue(inp, v); }
        });
        log(`第 ${q.index} 题（填空）已填入：${ans.join(' / ').slice(0, 60)}`, 'ok');
      } else if (/简答|问答|论述|名词解释|计算|分析/.test(q.type)) {
        const ta = q.textareas[0];
        if (ta) { setNativeValue(ta, ans[0].toString()); log(`第 ${q.index} 题（简答）已填写`, 'ok'); }
      } else {
        // 选择/判断题：按字母点击，字母对不上则按文本模糊匹配
        const picked = [];
        ans.forEach(a => {
          const letter = String(a).trim().charAt(0).toUpperCase();
          let opt = q.options.find(o => o.letter === letter);
          if (!opt) {
            const kw = String(a).replace(/^[A-Z][\.、．\s]*/, '').trim();
            if (kw) opt = q.options.find(o => o.text && (o.text.includes(kw) || kw.includes(o.text.slice(2))));
          }
          if (opt && !picked.includes(opt)) picked.push(opt);
        });
        if (picked.length) {
          for (const opt of picked) {
            const ok = await clickOption(opt);
            if (!ok) log(`第 ${q.index} 题选项 ${opt.letter} 可能未选中，请人工检查`, 'warn');
          }
          log(`第 ${q.index} 题（${q.type}）选择：${picked.map(o => o.letter).join('、')}`, 'ok');
        } else {
          log(`第 ${q.index} 题答案无法匹配选项：${ans.join(',')}`, 'warn');
        }
      }
      await sleep(450);
    }
    return true;
  }

  // 综合判定选项是否已选中：aria-checked（新版学习通）/ 原生 checked / 选中类名
  function optionSelected(opt) {
    const li = opt.li || (opt.el?.tagName === 'LI' ? opt.el : opt.el);
    if (li?.getAttribute?.('aria-checked') === 'true' || li?.getAttribute?.('aria-pressed') === 'true') return true;
    if (opt.input && opt.input.checked) return true;
    return /chosen|active|selected|(^|\s)cur(\s|$)|(^|\s)on(\s|$)/.test(li?.className || '');
  }

  // 学习通不同版本：新版 li 上有 onclick="addChoice(this)"（最可靠，直接调用页面函数）；
  // 老版事件绑在 li / a.before / label / 原生 input。逐级尝试，每步校验选中状态。
  async function clickOption(opt) {
    const sleep120 = () => new Promise(r => setTimeout(r, 120));
    const li = opt.li || (opt.el.tagName === 'LI' ? opt.el : opt.el);
    const tryClick = el => {
      if (!el || !isVisible(el)) return;
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      nativeClick(el);
    };

    if (optionSelected(opt)) return true;

    // 1) 新版学习通：直接调用所在 frame 页面里的 addChoice(li)
    try {
      const win = li.ownerDocument.defaultView;
      const pageWin = (typeof unsafeWindow !== 'undefined' && win === window.top && unsafeWindow.addChoice)
        ? unsafeWindow : win;
      const fn = pageWin.addChoice || win.wrappedJSObject?.addChoice;
      if (typeof fn === 'function') {
        try { li.scrollIntoView({ block: 'center' }); } catch (e) {}
        fn.call(win, li);
        await sleep120();
      }
    } catch (e) {}
    if (optionSelected(opt)) return true;

    // 2) 有原生 radio/checkbox：点 字母标记 → li → label → input.click()
    if (opt.input) {
      const before = li?.querySelector?.('a.before,span.before,a[class*="before"],.font-label')
        || opt.label?.querySelector?.('a.before,span.before,.font-label');
      for (const t of [before, li, opt.label].filter(Boolean)) {
        if (optionSelected(opt)) return true;
        tryClick(t);
        await sleep120();
        if (optionSelected(opt)) return true;
      }
      if (!optionSelected(opt)) { try { opt.input.click(); } catch (e) {}; await sleep120(); }
      if (!optionSelected(opt)) {
        try {
          opt.input.checked = true;
          opt.input.dispatchEvent(new Event('click', { bubbles: true }));
          opt.input.dispatchEvent(new Event('change', { bubbles: true }));
          const w = opt.input.ownerDocument.defaultView;
          if (w?.jQuery) { try { w.jQuery(opt.input).trigger('change'); } catch (e) {} }
        } catch (e) {}
        await sleep120();
      }
      return optionSelected(opt);
    }

    // 3) 纯 JS 组件：点 li（一次，重复点会 toggle 取消）
    const before = li?.querySelector?.('a.before,span.before,a[class*="before"],.font-label');
    tryClick(li);
    await sleep120();
    if (!optionSelected(opt) && before) { tryClick(before); await sleep120(); }

    // 4) 最终兜底：手动同步 aria-checked 与隐藏 answer input
    if (!optionSelected(opt)) {
      try {
        li.setAttribute('aria-checked', 'true');
        li.setAttribute('aria-pressed', 'true');
        const ul = li.closest('ul');
        // 单选：同组其他项取消
        if (ul && !/多选|多项/.test((li.closest('.TiMu')?.textContent || ''))) {
          ul.querySelectorAll('li').forEach(x => {
            if (x !== li && x.getAttribute('aria-checked') === 'true') {
              x.setAttribute('aria-checked', 'false');
              x.setAttribute('aria-pressed', 'false');
            }
          });
        }
        const name = opt.num?.getAttribute('name');
        if (name) {
          const doc = li.ownerDocument;
          const hid = doc.getElementById(name) || doc.querySelector(`input[type=hidden][name="${name}"]`);
          if (hid) setNativeValue(hid, opt.letter);
        }
      } catch (e) {}
      await sleep120();
    }
    return optionSelected(opt);
  }

  /* ---------------------------- 诊断功能 ---------------------------- */
  // 查询元素上通过 jQuery 绑定的事件（学习通老页面用 jQuery）
  function jqEvents(el) {
    try {
      const w = el.ownerDocument.defaultView;
      if (!w || !w.jQuery || !w.jQuery._data) return '无jQuery';
      const ev = w.jQuery._data(el, 'events');
      return ev ? Object.keys(ev).join(',') : '无事件';
    } catch (e) { return '查询失败'; }
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) { return false; }
  }

  async function diagnose() {
    if (running) { log('请先点「停止」再运行诊断', 'warn'); return; }
    log('=== 开始诊断（不要移动鼠标，约需 3 秒）===', 'warn');
    setStatus('诊断中…');
    const docs = getAllDocs();
    const R = []; // 报告
    const push = s => { R.push(s); };

    push('===== 学习通答题器诊断报告 =====');
    push('时间: ' + new Date().toLocaleString());
    push('UA: ' + navigator.userAgent.slice(0, 80));

    // 1) frame 信息
    push('\n--- frames (' + docs.length + ') ---');
    docs.forEach((d, i) => {
      let qCount = 0, radioCount = 0, frameVis = '-';
      try {
        qCount = d.querySelectorAll(CONFIG.QUESTION_BLOCK_SEL).length;
        radioCount = d.querySelectorAll('input[type=radio],input[type=checkbox]').length;
        if (d === window.top.document) frameVis = 'top';
        else if (d.defaultView?.frameElement) frameVis = isVisible(d.defaultView.frameElement) ? '可见' : '【隐藏】';
      } catch (e) {}
      push(`[${i}] ${frameVis} 题块=${qCount} 选项框=${radioCount} ${d.location.href}`);
    });

    // 2) 找到第一道未答题
    const questions = collectQuestions(docs);
    push('\n识别到题目数: ' + questions.length);
    const q = questions.find(x => !x.answered) || questions[0];
    if (!q) {
      log('诊断失败：当前页面没有识别到题目', 'err');
      setStatus('诊断完成：未找到题目');
      return;
    }
    push('目标题 index=' + q.index + ' 类型=' + q.type + ' 已答=' + q.answered);
    push('题干: ' + q.title.slice(0, 120));

    // 3) 选项结构
    push('\n--- 选项结构 ---');
    q.options.forEach(o => {
      const inp = o.input
        ? `input=${o.input.type} name="${o.input.name}" value="${o.input.value}" disabled=${o.input.disabled} checked=${o.input.checked} offsetParent=${o.input.offsetParent ? '有' : '无'}`
        : 'input=无';
      const aria = o.el.getAttribute?.('aria-checked');
      const numData = o.num?.getAttribute('data') || '无';
      const qid = o.li?.getAttribute('qid') || '无';
      const qtype = o.li?.getAttribute('qtype') ?? '无';
      push(`${o.letter}. aria-checked=${aria} data=${numData} qid=${qid} qtype=${qtype} el=<${o.el.tagName} class="${o.el.className}"> li=${o.li ? `<${o.li.tagName}>` : '无'} label=${o.label ? '有' : '无'} ${inp} 文本="${o.text.slice(0, 40)}"`);
    });

    // 4) 事件绑定
    push('\n--- 事件绑定（选项A）---');
    const o0 = q.options[0];
    const before0 = o0.li?.querySelector('a.before,span.before,a[class*="before"],.font-label')
      || o0.label?.querySelector?.('a.before,span.before,.font-label');
    push(`li jQuery事件: ${jqEvents(o0.li || o0.el)}  onclick属性: ${o0.li?.getAttribute('onclick') || '无'}`);
    if (before0) push(`before=<${before0.tagName} class="${before0.className}"> jQuery事件: ${jqEvents(before0)} onclick属性: ${before0.getAttribute('onclick') || '无'}`);
    if (o0.label) push(`label jQuery事件: ${jqEvents(o0.label)} onclick属性: ${o0.label.getAttribute('onclick') || '无'}`);
    if (o0.input) push(`input jQuery事件: ${jqEvents(o0.input)} onclick属性: ${o0.input.getAttribute('onclick') || '无'}`);

    // 5) 点击实验：逐个点位点击，每步记录状态（点位间会相互 toggle，状态变化即说明该点位有效）
    push('\n--- 点击实验（选项A，观察每步是否翻转）---');
    const li0 = o0.li || o0.el;
    const stateOf = (tag) => {
      const inp = o0.input ? `input.checked=${o0.input.checked}` : '无input';
      const aria = li0.getAttribute('aria-checked');
      const numName = o0.num?.getAttribute('name') || '';
      const hid = numName ? q.doc.querySelector(`input[type=hidden][name="${numName}"]`) : null;
      const hv = hid ? hid.value : '无隐藏框';
      const liCls = (o0.li || o0.el).className || '';
      const s = `${tag}: ${inp} | aria-checked=${aria} | hidden="${hv}" | li.class="${liCls}"`;
      push(s);
      log(s.length > 120 ? s.slice(0, 120) + '…' : s);
    };
    stateOf('初始');
    // 实验0：直接调用学习通官方作答函数 addChoice
    try {
      const win = q.doc.defaultView;
      const fn = win.addChoice || win.wrappedJSObject?.addChoice;
      if (typeof fn === 'function') {
        fn.call(win, li0);
        await sleep(350);
        stateOf('addChoice(li)');
      } else {
        push('addChoice(li): 页面无此函数，跳过');
      }
    } catch (e) { push(`addChoice(li) 异常: ${e.message}`); }
    const expTargets = [
      ['点before', before0],
      ['点li', o0.li],
      ['点label', o0.label],
      ['点el', (o0.el !== o0.li && o0.el !== o0.label) ? o0.el : null],
      ['input.click()', o0.input]
    ];
    for (const [name, el] of expTargets) {
      if (!el) { push(`${name}: 元素不存在，跳过`); continue; }
      try {
        el.scrollIntoView({ block: 'center' });
        if (name === 'input.click()') el.click();
        else nativeClick(el);
      } catch (e) { push(`${name}: 点击异常 ${e.message}`); continue; }
      await sleep(350);
      stateOf(name);
    }

    // 实验结束：还原为未选（避免留下错误答案）
    const pickedNow = li0.getAttribute('aria-checked') === 'true'
      || (o0.input && o0.input.checked)
      || /chosen|active|selected|(^|\s)cur(\s|$)|(^|\s)on(\s|$)/.test(li0.className || '');
    if (pickedNow) {
      const win = q.doc.defaultView;
      const fn = win.addChoice || win.wrappedJSObject?.addChoice;
      if (typeof fn === 'function') { try { fn.call(win, li0); } catch (e) {} }
      else if (o0.input && o0.input.checked) { try { o0.input.click(); } catch (e) {} }
      else { try { nativeClick(li0); } catch (e) {} }
    }

    // 6) 题块 HTML（压缩空白）
    push('\n--- 题块 outerHTML（前 6000 字符）---');
    push(q.box.outerHTML.replace(/\s+/g, ' ').slice(0, 6000));

    const report = R.join('\n');
    const copied = copyText(report);
    log(`诊断完成：${questions.length} 题，报告 ${report.length} 字符，已${copied ? '复制到剪贴板' : '复制失败，请按 F12 控制台查看'}`, 'ok');
    console.log('[DS诊断]\n' + report);
    setStatus('诊断完成');
    try {
      window.alert('诊断报告已' + (copied ? '复制到剪贴板' : '输出到控制台(F12)') + '，\n请直接粘贴（Ctrl+V）发给助手。');
    } catch (e) {}
  }

  /* ------------------------- 提交 / 弹窗 / 下一节 ------------------------- */
  function findClickable(docs, texts, extraSel) {
    const candidates = [];
    docs.forEach(doc => {
      let els = Array.from(doc.querySelectorAll(
        'button,a,[role=button],input[type=button],input[type=submit],li,div,span,p,.btn'
      ));
      if (extraSel) els = els.concat(Array.from(doc.querySelectorAll(extraSel)));
      els.forEach(el => {
        if (!isVisible(el)) return;
        const t = cleanText(el.textContent || el.value || '');
        if (!t || t.length > 12) return;
        if (CONFIG.EXCLUDE_TEXT.some(x => t.includes(x))) return;
        if (texts.some(x => t === x || t.includes(x))) candidates.push({ el, doc, t });
      });
    });
    // 优先叶子元素（避免点到外层大容器）
    candidates.sort((a, b) => (a.el.textContent.length - b.el.textContent.length));
    return candidates[0] || null;
  }

  // 判断元素是否被禁用/置灰
  function isDisabled(el) {
    if (!el) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return true;
    const cls = el.className || "";
    if (typeof cls === "string" && /(^|[\s_-])(disabled|disable|gray|grey|no-?next|no-?click|hide|hidden)([\s_-]|$)/i.test(cls)) return true;
    const p = el.parentElement;
    if (p && /(^|[\s_-])(disabled|disable|gray|grey|no-?next)([\s_-]|$)/i.test(p.className || "")) return true;
    return false;
  }

  // 元素是否位于课程目录树/章节导航内（目录内的链接一律不点）
  function isInCatalog(el) {
    try {
      return !!(el.closest && el.closest(CONFIG.CATALOG_SEL));
    } catch (e) { return false; }
  }

  const POPUP_SEL = '.layui-layer,.dialog,.modal,[class*="popup"],[class*="dialog"],[class*="Popup"],[role="dialog"],.el-message-box,.ant-modal,.weui-desktop-dialog,.mui-popup';

  // 扫描所有 frame 的确认弹窗并点击确认。
  // wait=true 时（刚点完提交）会多轮等待弹窗出现；wait=false 时无弹窗立即返回。
  async function handlePopups(docs, opts = {}) {
    const wait = !!opts.wait;
    const rounds = wait ? 10 : 1;
    const RESULT_CLOSE = ['关闭', '我知道了', '知道了', '完成', '查看答案', '确定'];

    for (let round = 0; round < rounds; round++) {
      const allDocs = getAllDocs();
      let acted = false;

      for (const doc of allDocs) {
        let popups;
        try { popups = Array.from(doc.querySelectorAll(POPUP_SEL)).filter(isVisible); } catch (e) { continue; }
        // 兜底：layui 遮罩层有时不在常规容器内，直接找可见的 layui-layer-btn
        if (!popups.length) {
          const layerBtn = doc.querySelector('.layui-layer-btn,.layui-layer-content');
          if (layerBtn && isVisible(layerBtn.closest('.layui-layer') || layerBtn)) {
            popups = [layerBtn.closest('.layui-layer') || layerBtn];
          }
        }

        for (const pop of popups) {
          const btns = Array.from(pop.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit],.btn,span'))
            .filter(isVisible);
          let best = null;
          for (const b of btns) {
            const t = cleanText(b.textContent || b.value || '');
            if (!t || t.length > 10) continue;
            if (CONFIG.CANCEL_TEXT.some(c => t.includes(c))) continue;
            const score = CONFIG.CONFIRM_TEXT.findIndex(w => t === w.trim() || t.includes(w.trim()));
            if (score >= 0 && (!best || score < best.score)) best = { b, t, score };
          }

          // 没有确认按钮时，判断是否为成绩/结果弹窗，自动关闭
          if (!best) {
            const pt = cleanText(pop.textContent);
            if (/成绩|得分|查看答案|答题解析|答案解析|已提交|提交成功|已完成|正确率/.test(pt)) {
              const cb = btns.find(b => {
                const t = cleanText(b.textContent || b.value || '');
                return t.length <= 6 && RESULT_CLOSE.some(c => t === c || t.includes(c))
                  && !CONFIG.CANCEL_TEXT.some(c => t.includes(c));
              });
              if (cb) best = { b: cb, t: cleanText(cb.textContent) };
            }
          }

          if (best) {
            log(`检测到确认弹窗，点击「${best.t}」`, 'warn');
            try { best.b.scrollIntoView({ block: 'center' }); } catch (e) {}
            await sleep(400);
            nativeClick(best.b);
            acted = true;
            await sleep(1600);
            break;
          }
        }
        if (acted) break;
      }

      if (!acted) {
        if (!wait) return false;
        await sleep(700); // 等弹窗动画/加载
      }
    }
    return true;
  }

  async function autoSubmit(docs) {
    if (!CONFIG.AUTO_SUBMIT) return;
    // 先看是否已有确认弹窗（提交按钮可能已经点过）
    if (await handlePopups(docs, { wait: false })) {
      log('提交流程已完成', 'ok');
      return;
    }
    // 找提交按钮
    const btn = findClickable(docs, CONFIG.SUBMIT_TEXT,
      '#submitData,.submitBtn,.tj_btn,.Btn_blue_3,[class*="submit"]');
    if (!btn) return;
    log(`找到「${btn.t}」按钮，准备提交…`, 'warn');
    try { btn.el.scrollIntoView({ block: 'center' }); } catch (e) {}
    await sleep(500);
    nativeClick(btn.el);
    // 多轮等待并处理“是否确认提交”弹窗（可能连续两级确认）
    await handlePopups(getAllDocs(), { wait: true });
    await sleep(1500);
    // 再补一轮，防止第二级确认/成绩弹窗延迟出现
    await handlePopups(getAllDocs(), { wait: true });
    log('提交流程已完成', 'ok');
  }

  function findNext(docs) {
    const CLICKABLE = 'a,button,[role=button],input[type=button],input[type=submit],div,span,li,.btn';
    const matchesNextText = (t) => CONFIG.NEXT_BTN_TEXT.some(x => t === x || (t.length <= 8 && t.includes(x)));
    const exactNextText = (t) => CONFIG.NEXT_BTN_TEXT.some(x => t === x);
    const cands = [];

    // 优先级 1：明确 ID/类名的下一节按钮（最可靠）
    for (const doc of docs) {
      let els;
      try { els = Array.from(doc.querySelectorAll(CONFIG.NEXT_BTN_SEL)); } catch (e) { continue; }
      for (const el of els) {
        if (!isVisible(el) || isDisabled(el) || isInCatalog(el)) continue;
        const t = cleanText(el.textContent || el.value || '');
        if (CONFIG.EXCLUDE_TEXT.some(x => t.includes(x))) continue;
        if (t && !matchesNextText(t)) continue;
        cands.push({ el, doc, t: t || '下一节', rank: 1 });
      }
    }
    // 优先级 2：内容区按钮条容器内按文本找
    for (const doc of docs) {
      let bars;
      try { bars = Array.from(doc.querySelectorAll(CONFIG.NEXT_BAR_SEL)); } catch (e) { continue; }
      for (const bar of bars) {
        if (isInCatalog(bar)) continue;
        const els = Array.from(bar.querySelectorAll(CLICKABLE));
        for (const el of els) {
          if (!isVisible(el) || isDisabled(el)) continue;
          const t = cleanText(el.textContent || el.value || '');
          if (!t || t.length > 10) continue;
          if (matchesNextText(t) && !CONFIG.EXCLUDE_TEXT.some(x => t.includes(x))) {
            cands.push({ el, doc, t, rank: 2 });
          }
        }
      }
    }
    // 优先级 3：全文精确文本匹配，排除目录树，只认可点击元素
    if (!cands.length) {
      for (const doc of docs) {
        let els;
        try { els = Array.from(doc.querySelectorAll(CLICKABLE)); } catch (e) { continue; }
        for (const el of els) {
          if (!isVisible(el) || isDisabled(el) || isInCatalog(el)) continue;
          const t = cleanText(el.textContent || el.value || '');
          if (!t || t.length > 8) continue;
          if (!exactNextText(t)) continue;
          if (CONFIG.EXCLUDE_TEXT.some(x => t.includes(x))) continue;
          const cls = typeof el.className === 'string' ? el.className : '';
          const clickable = /^(A|BUTTON|INPUT)$/.test(el.tagName)
            || el.getAttribute('role') === 'button' || el.hasAttribute('onclick')
            || /btn|button/i.test(cls);
          if (!clickable) continue;
          cands.push({ el, doc, t, rank: 3 });
        }
      }
    }
    if (!cands.length) return null;
    // 排序：rank 优先 → 任务点 iframe 优先 → 文本最短的叶子元素
    const docScore = (d) => {
      try {
        const u = d.location.href || '';
        if (/knowledge\/cards|doHomeWorkNew|\/work\/|\/video\/|object\/log/.test(u)) return 0;
        if (/about:blank/.test(u)) return 2;
        return 1;
      } catch (e) { return 1; }
    };
    cands.sort((a, b) => (a.rank - b.rank)
      || (docScore(a.doc) - docScore(b.doc))
      || ((a.el.textContent || '').length - (b.el.textContent || '').length));
    return cands[0];
  }

  function fingerprint(docs) {
    let fp = [];
    docs.forEach(doc => {
      try {
        fp.push(doc.location.href);
        fp.push(doc.title || '');
        const blocks = doc.querySelectorAll(CONFIG.QUESTION_BLOCK_SEL);
        fp.push('q=' + blocks.length);
        if (blocks[0]) fp.push(cleanText(blocks[0].textContent).slice(0, 60));
      } catch (e) {}
    });
    return fp.join('|');
  }

  async function waitForChange(oldFp, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(600);
      if (fingerprint(getAllDocs()) !== oldFp) { await sleep(1500); return true; }
    }
    return false;
  }

  /* ------------------------------ 主循环 ------------------------------ */
  // 检测当前是否为视频任务点页（视频页无题目，直接点下一节）
  function isVideoPageDetect(docs) {
    return docs.some(d => {
      try {
        const u = d.location.href || '';
        if (/\/video\/|video\/index|object\/log|ananas\/modules\/video|videojs/.test(u)) return true;
        return !!d.querySelector('video, .vjs-tech, .vjs-player, #videoPlayer, .video-player, [class*="videoPlayer"]');
      } catch (e) { return false; }
    });
  }

  async function mainLoop() {
    let noNextRetries = 0;  // 找不到“下一节”按钮的连续轮数
    let noChangeStreak = 0; // 点击下一节后页面无变化的连续次数
    while (running) {
      await sleep(CONFIG.STEP_DELAY);
      if (!running) break;
      setStatus(`扫描页面（第 ${sections + 1} 节）…`);
      const docs = getAllDocs();
      await scrollAll(docs);
      await handlePopups(docs, { wait: false });

      const questions = collectQuestions(docs);
      const unanswered = questions.filter(q => !q.answered);

      if (unanswered.length) {
        noNextRetries = 0;
        noChangeStreak = 0;
        log(`发现 ${questions.length} 道题，其中 ${unanswered.length} 道未作答`);
        const ok = await answerQuestions(unanswered);
        if (!ok && !running) break;
        await sleep(1000);
        await autoSubmit(getAllDocs());
        await sleep(1500);
        continue;
      }

      if (questions.length) {
        noNextRetries = 0;
        noChangeStreak = 0;
        log(`本节 ${questions.length} 道题均已作答，检查提交…`);
        await autoSubmit(docs);
        await sleep(1500);
      }

      // 本页无题目：视频/文档/过渡页，只找内容区“下一节”（绝不点目录树，防止跳过章节检测）
      const isVideo = isVideoPageDetect(docs);
      const next = findNext(docs);
      if (next) {
        noNextRetries = 0;
        sections++;
        if (sections > CONFIG.MAX_SECTIONS) { log('达到最大节数限制，停止', 'warn'); break; }
        log(isVideo
          ? `本页为视频任务点，点击「${next.t}」继续（已推进 ${sections} 步）`
          : `本页无题目，点击「${next.t}」继续（已推进 ${sections} 步）`, 'ok');
        try { next.el.scrollIntoView({ block: 'center' }); } catch (e) {}
        await sleep(400);
        const fp = fingerprint(getAllDocs());
        nativeClick(next.el);
        const changed = await waitForChange(fp, CONFIG.PAGE_TIMEOUT);
        if (!changed) {
          noChangeStreak++;
          if (noChangeStreak >= 3) {
            log('连续 3 次点击下一节页面未变化，判定本课程已结束，停在当前页', 'ok');
            break;
          }
          log('页面似乎未变化，关闭弹窗后重试…', 'warn');
          await handlePopups(getAllDocs(), { wait: true });
          await scrollAll(getAllDocs());
        } else {
          noChangeStreak = 0;
        }
      } else {
        noNextRetries++;
        noChangeStreak = 0;
        if (noNextRetries >= CONFIG.NO_NEXT_RETRIES) {
          log('本页无题目，也找不到下一节按钮，判定本课程已结束，停在当前页', 'ok');
          break;
        }
        log(`未识别到题目，也未找到下一节按钮（${noNextRetries}/${CONFIG.NO_NEXT_RETRIES}），滚动后重试…`, 'warn');
        await scrollAll(docs);
        await sleep(500);
      }
    }
    finish();
  }

  function start() {
    if (running) return;
    // 启动前校验 API Key
    const key = ui.keyInput.value.trim();
    if (key) {
      CONFIG.API_KEY = key;
      saveSettings({ key });
      ui.keyInput.value = '';
      refreshKeyHint();
    }
    if (!CONFIG.API_KEY) {
      log('请先填写 DeepSeek API Key（面板输入框，sk- 开头），点保存后再启动', 'err');
      try { ui.keyInput.focus(); } catch (e) {}
      return;
    }
    running = true;
    sections = 0;
    ui.start.style.display = 'none';
    ui.stop.style.display = 'block';
    log(`任务启动，模型：${CONFIG.MODEL}（加密题截图识别固定使用 deepseek-flash）`, 'ok');
    mainLoop();
  }
  function stop() {
    if (!running) return;
    running = false;
    log('已手动停止', 'warn');
    setStatus('已停止');
    ui.start.style.display = 'block';
    ui.stop.style.display = 'none';
  }
  function finish() {
    running = false;
    setStatus(`任务结束，共处理 ${sections} 节`);
    ui.start.style.display = 'block';
    ui.stop.style.display = 'none';
    log('=== 任务结束 ===', 'ok');
  }

  // 启动面板（等 body）
  if (document.body) buildUI();
  else window.addEventListener('DOMContentLoaded', buildUI);
})();
