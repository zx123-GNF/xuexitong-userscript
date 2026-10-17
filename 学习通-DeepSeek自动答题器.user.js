// ==UserScript==
// @name         学习通 DeepSeek 自动答题器
// @namespace    https://api.deepseek.com/
// @version      3.6.0
// @description  学习通(超星)自动答题。v3.6.0 找到并修复贯穿多个版本的真正根因：模拟点击时「合成 click + el.click()」等于连点两次，单选（radio）幂等看不出来，多选（checkbox）则选上又取消 —— 这就是"多选怎么都选不上、单选却正常"。同时：从 li 的 onclick 属性发现页面作答函数（addChoice/addMultipleChoice）直接调用、识别新样式选项字母 span.num_option_dx[data]、用隐藏答案框 input[name=answer<qid>] 作为选中依据。题库与 AI 架构不变。
// @author       you
// @match        *://*.chaoxing.com/*
// @match        *://*.xuexi365.cn/*
// @match        *://*.chaoxing.com.cn/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.deepseek.com
// @connect      cx.icodef.com
// @connect      api.tikuhai.com
// @connect      tk.enncy.cn
// @connect      api.muketool.com
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
    // ==================== 题库（v3.3.0）====================
    // 检索顺序：本地题库 → 自定义题库 → 免费公开题库 → DeepSeek 兜底
    BANK_ENABLED: true,             // 总开关：先用题库，查不到再用 AI
    BANK_FREE_ENABLED: true,        // 免费公开题库（网课小助手 cx.icodef.com，免 token）
    BANK_FREE_URLS: [
      'https://cx.icodef.com/wyn-nb?v=4',
      'http://cx.icodef.com/wyn-nb?v=4'
    ],
    // 该免费接口有「1 并发」限制，必须串行 + 留间隔。实测：0ms 连发第 3 条就开始流控，
    // 1.5~2.5s 间隔连续 4 条无流控，所以取 2s（比原来的 4s 快一倍）。
    BANK_MIN_INTERVAL: 2000,
    BANK_TIMEOUT: 12000,
    BANK_RATE_BACKOFF: 8000,        // 被流控后的冷却时间(ms)
    BANK_MAX_PER_ROUND: 24,         // 每轮最多查多少题，防止一节课题太多卡太久
    // 备用免费源（参考满分助手 getAnswer4，免 token；部分网络可用，失败 3 次自动停用）
    BANK_FREE2_ENABLED: true,
    BANK_FREE2_URL: 'https://api.muketool.com/cx/v2/query',
    LOCAL_BANK: true,               // 本地题库（自动收录 + 命中，跨学习通子域共享）
    LOCAL_BANK_MAX: 5000,
    BANK_CUSTOM_URL: '',            // 自定义题库地址（兼容 POST /api/search 协议）
    BANK_CUSTOM_KEY: '',            // 自定义题库密钥
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
    // 同小节内的任务点标签文本：视频看完后要先把这些标签点开（章节测验），而不是跳下一个小节
    TASK_TAB_TEXT: ['章节测验', '章节测试', '章节检测', '章节作业', '课后测验', '单元测验', '章节练习', '小测验', '测验', '测试', '作业', '考试', '讨论'],
    // 任务点标签可能的容器
    TASK_TAB_SEL: '.ans-job-list,.job-list,.joblist,.taskPoint,.task-point,.point-list,.pointList,.chapterJob,.chapter-job,#ans-job-list,.jobTab,.job-tab,.tab-item,.nav-item,.ans-job,[class*="jobTab"],[class*="jobList"],[class*="job-list"],[class*="taskPoint"],[class*="task-point"]',
    // 手动拾取的「章节测验」标签选择器（优先级最高）
    TASK_TAB_PICKED: '',
    // 课程目录树/章节导航容器：这些区域内的任何链接都不点
    CATALOG_SEL: [
      '#chapterList', '.chapterList', '.chapter-list', '#coursetree', '.coursetree', '.course-tree',
      '.posCatalog', '.posCatalog_select', '.posCatalog_scroll', '.posCatalog_content',
      '.ncells', '.ncells_content', '.catalog', '.catalog_box', '.catalogContent', '.catalog_content',
      '.dirList', '.dir-list', '.chapter_item', '.chapter-item', '.chapterItem', '.knowledgeItem',
      '.sidebar', '.side-bar', '.left-menu', '.leftmenu', '.right-menu', '.rightmenu', '.menu',
      '#magazine', '.magazine', '.chapterNum', '.chapter-text', '.chapterText', '.chapter_name',
      '.prev_next_menu', '.crumb', '.breadcrumb', '#courseChapter', '.chapterContent',
      '.section-list', '.sectionList', '.knowledge-list', '.tree', '[class*="catalog"]',
      // ↓↓↓ v3.0.0 补：学习通真实的目录/章节树容器（旧列表漏了大半，这是误点目录的根因之一）
      '.posCatalog_tit', '.posCatalog_box', '.posCatalog_list', '.posCatalog_item',
      '.catalog_body', '.catalogBody', '.chapter_body', '.chapterBox',
      '.zjlist', '.zj_list', '.s-point-item', '.knowledge-item', '.knowledgeItem',
      '.treebox', '#treebox', '.ztree', 'ul.ztree',
      '.chapterlist', '.chapter-tree', '.chapterTree', '.dirbox', '.sideCatalog',
      '[id*="catalog"]', '[id*="Catalog"]', '[class*="chapterList"]', '[class*="chapter_list"]',
      '[class*="coursetree"]', '[class*="courseTree"]'
    ].join(','),
    // 精确的“章节树”容器：只放确定是左侧目录的东西。
    // 任务点标签（「2 章节测验」）用这一套判断，避免 .chapterContent/.menu 这类宽泛容器
    // 把顶部的任务点栏一起排掉 —— 那会让“先切章节测验”直接失效。
    CATALOG_STRICT_SEL: [
      '#chapterList', '.chapterList', '.chapter-list', '#coursetree', '.coursetree', '.course-tree',
      '.posCatalog', '.posCatalog_select', '.posCatalog_scroll', '.posCatalog_content',
      '.posCatalog_tit', '.posCatalog_box', '.posCatalog_list', '.posCatalog_item',
      '.ztree', 'ul.ztree', '#treebox', '.treebox', '.ncells', '.ncells_content',
      '.chapter_item', '.chapter-item', '.chapterItem', '.chapterNum', '.chapter_name', '.chapter-text',
      '.dirList', '.dir-list', '.knowledgeItem', '.section-list', '.sectionList', '.knowledge-list',
      '[class*="catalog"]', '[id*="catalog"]', '[class*="chapterList"]', '[class*="coursetree"]'
    ].join(','),
    // 任务点 iframe 特征：命中说明顶层文档只是外壳，目录树和顶部导航都在顶层
    MODULE_IFRAME_RE: /ananas\/modules|\/work\/|doHomeWorkNew|knowledge\/cards|object\/log|video\/index|\/video\/|\/pdf\/|\/audio\/|exam-ans|examtopic/i,
    // 顶层文档中，横向落在左侧这个比例宽度内的元素视为侧栏/目录，一律不点
    CATALOG_LEFT_RATIO: 0.35,
    // 手动拾取校准的“下一节”选择器（面板 🎯 拾取写入，优先级最高）
    NEXT_BTN_PICKED: '',
    // 点击下一节后，任务点内容多久没变化就算“点错了/没跳转”(ms)
    TASK_SWITCH_TIMEOUT: 6000,
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
      if (typeof s.nextPick === 'string') CONFIG.NEXT_BTN_PICKED = s.nextPick;
      if (typeof s.tabPick === 'string') CONFIG.TASK_TAB_PICKED = s.tabPick;
      if (typeof s.bank === 'boolean') CONFIG.BANK_ENABLED = s.bank;
      if (typeof s.bankFree === 'boolean') CONFIG.BANK_FREE_ENABLED = s.bankFree;
      if (typeof s.localBank === 'boolean') CONFIG.LOCAL_BANK = s.localBank;
      if (typeof s.bankUrl === 'string') CONFIG.BANK_CUSTOM_URL = s.bankUrl;
      if (typeof s.bankKey === 'string') CONFIG.BANK_CUSTOM_KEY = s.bankKey;
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
      #glm-panel .bd{padding:10px 12px;max-height:calc(100vh - 130px);overflow-y:auto}
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
          <button id="glm-diag" style="background:#3f6fb5;flex:1">🔍 诊断本题</button>
          <button id="glm-scan" style="background:#2f7f6f;flex:1">🧭 扫描自检</button>
        </div>
        <div class="row">
          <button id="glm-dump" style="background:#b5651d;flex:1">🔬 导出题目 HTML（多选出问题就点它）</button>
        </div>
        <div class="row">
          <button id="glm-pick" style="background:#8a5cc4;flex:1">🎯 拾取「下一节」</button>
          <button id="glm-picktab" style="background:#8a5cc4;flex:1">🎯 拾取「章节测验」</button>
        </div>
        <div class="row">
          <button id="glm-pickclear" style="background:#555f70;flex:1">清除所有手动拾取</button>
        </div>
        <div class="row"><div id="glm-pickinfo" style="font-size:11px;opacity:.75;line-height:1.45">自动识别中</div></div>
        <div class="row" style="flex-wrap:wrap;gap:4px 10px">
          <label><input type="checkbox" id="glm-bank" ${CONFIG.BANK_ENABLED ? 'checked' : ''}> 题库优先</label>
          <label><input type="checkbox" id="glm-bankfree" ${CONFIG.BANK_FREE_ENABLED ? 'checked' : ''}> 免费题库</label>
          <label><input type="checkbox" id="glm-banklocal" ${CONFIG.LOCAL_BANK ? 'checked' : ''}> 本地库</label>
        </div>
        <div class="row">
          <input type="text" id="glm-bankurl" placeholder="自定义题库地址（可留空）" value="${CONFIG.BANK_CUSTOM_URL || ''}">
          <button class="save" id="glm-banksave">保存</button>
        </div>
        <div class="row"><div id="glm-bankstat" style="font-size:11px;opacity:.75;line-height:1.45">本地题库 0 题</div></div>
        <div class="row">
          <button id="glm-banktest" style="background:#2f7f6f;flex:1">🔌 测试题库</button>
          <button id="glm-bankexport" style="background:#3f6fb5;flex:0 0 46px;padding:6px 6px">导出</button>
          <button id="glm-bankimport" style="background:#3f6fb5;flex:0 0 46px;padding:6px 6px">导入</button>
          <button id="glm-bankclear" style="background:#8a3b3b;flex:0 0 46px;padding:6px 6px">清空</button>
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
    panel.querySelector('#glm-scan').onclick = () => scanReport();
    panel.querySelector('#glm-dump').onclick = () => dumpQuestionDOM();
    panel.querySelector('#glm-pick').onclick = () => togglePicker('next');
    panel.querySelector('#glm-picktab').onclick = () => togglePicker('tab');
    panel.querySelector('#glm-pickclear').onclick = () => {
      CONFIG.NEXT_BTN_PICKED = '';
      CONFIG.TASK_TAB_PICKED = '';
      saveSettings({ nextPick: '', tabPick: '' });
      refreshPickInfo();
      log('已清除所有手动拾取，改回自动识别', 'warn');
    };
    ui.pickInfo = panel.querySelector('#glm-pickinfo');
    ui.pickBtn = panel.querySelector('#glm-pick');
    ui.pickTabBtn = panel.querySelector('#glm-picktab');
    refreshPickInfo();

    // ---- 题库 ----
    ui.bankStat = panel.querySelector('#glm-bankstat');
    panel.querySelector('#glm-bank').onchange = e => { CONFIG.BANK_ENABLED = e.target.checked; saveSettings({ bank: e.target.checked }); };
    panel.querySelector('#glm-bankfree').onchange = e => { CONFIG.BANK_FREE_ENABLED = e.target.checked; saveSettings({ bankFree: e.target.checked }); };
    panel.querySelector('#glm-banklocal').onchange = e => { CONFIG.LOCAL_BANK = e.target.checked; saveSettings({ localBank: e.target.checked }); };
    panel.querySelector('#glm-banksave').onclick = () => {
      const v = panel.querySelector('#glm-bankurl').value.trim();
      CONFIG.BANK_CUSTOM_URL = v;
      saveSettings({ bankUrl: v });
      refreshBankStat();
      log(v ? '自定义题库地址已保存' : '自定义题库地址已清空', 'ok');
    };
    panel.querySelector('#glm-banktest').onclick = () => testBank();
    panel.querySelector('#glm-bankexport').onclick = () => {
      const json = JSON.stringify(loadLocalBank());
      if (copyText(json)) log(`本地题库已导出到剪贴板（${localBankSize()} 题）`, 'ok');
      else log('导出失败，请按 F12 在控制台查看 [DS答题] 日志', 'err');
    };
    panel.querySelector('#glm-bankimport').onclick = () => {
      const txt = prompt('粘贴之前导出的题库 JSON：');
      if (!txt) return;
      try {
        const o = JSON.parse(txt);
        if (!o || typeof o !== 'object') throw new Error('格式不对');
        const bank = loadLocalBank();
        let n = 0;
        Object.keys(o).forEach(k => { if (o[k] && o[k].a) { bank[k] = o[k]; n++; } });
        saveLocalBank(bank);
        refreshBankStat();
        log(`已导入 ${n} 题，本地题库共 ${localBankSize()} 题`, 'ok');
      } catch (e) { log('导入失败：' + e.message, 'err'); }
    };
    panel.querySelector('#glm-bankclear').onclick = () => {
      if (!confirm('确定清空本地题库？此操作不可撤销。')) return;
      saveLocalBank({});
      refreshBankStat();
      log('本地题库已清空', 'warn');
    };
    refreshBankStat();
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

  function refreshPickInfo() {
    if (!ui.pickInfo) return;
    ui.pickInfo.textContent =
      '下一节：' + (CONFIG.NEXT_BTN_PICKED ? '已手动绑定' : '自动识别') +
      ' ｜ 章节测验：' + (CONFIG.TASK_TAB_PICKED ? '已手动绑定' : '自动识别');
  }

  function refreshBankStat() {
    if (!ui.bankStat) return;
    try {
      ui.bankStat.textContent = '本地题库 ' + localBankSize() + ' 题'
        + (CONFIG.BANK_CUSTOM_URL ? '｜自定义接口已配置' : '')
        + (CONFIG.BANK_FREE_ENABLED ? '｜免费题库开' : '｜免费题库关');
    } catch (e) {}
  }

  // 🔌 题库连通性测试：把请求/响应/失败原因全部打到日志，便于定位"全都查不到"
  async function testBank() {
    if (!CONFIG.BANK_FREE_ENABLED && !CONFIG.BANK_CUSTOM_URL) {
      log('免费题库和自定义题库都没开，先勾选或填地址', 'warn');
      return;
    }
    const probe = '马克思主义哲学的直接理论来源是';
    log('测试题库连通性…（免费题库有 1 并发限制）', 'warn');
    const t0 = Date.now();
    if (CONFIG.BANK_CUSTOM_URL) {
      const r = await queryCustomBank({ title: probe, type: '单选题', options: [] });
      log(r ? '自定义题库可用：' + r.answer.slice(0, 50) : '自定义题库没返回可用答案', r ? 'ok' : 'err');
    }
    if (CONFIG.BANK_FREE_ENABLED) {
      log('  免费题库地址：' + CONFIG.BANK_FREE_URLS.join(' , '));
      log('  发送题干：' + probe);
      const r = await queryFreeBank(probe, { ignoreRunning: true });
      const ms = Date.now() - t0;
      if (r && r.answer) {
        log(`免费题库可用（${r.src}）：${r.answer.slice(0, 60)}（${ms}ms）`, 'ok');
      } else {
        const reason = (r && r.reason) || '未知';
        log(`免费题库查询失败：${reason}（${ms}ms）`, 'err');
        if (/网络|超时|HTTP|非 JSON|未发起/.test(reason)) {
          log('  这是「请求层面」的失败，不是没收录。请检查：浏览器能打开 https://cx.icodef.com 吗？Tampermonkey 是否拦截了跨域？', 'warn');
        }
      }
    }
    if (CONFIG.BANK_FREE2_ENABLED) {
      log('  备用免费源：' + CONFIG.BANK_FREE2_URL);
      const r2 = await queryFreeBank2({ title: probe, type: '单选题' });
      log(r2 && r2.answer
        ? `备用源可用（${r2.src}）：${r2.answer.slice(0, 60)}`
        : `备用源不可用：${(r2 && r2.reason) || '未知'}（部分网络不可达，属正常）`, (r2 && r2.answer) ? 'ok' : 'warn');
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

  // 模拟点击。
  // ⚠️ 关键：这里【只派发一次 click】。
  // 旧版是「合成 click + el.click()」两次，对单选项（radio）幂等看不出来，
  // 但对多选 checkbox 等于点两次 → 选上又取消 → 永远选不上。
  // 这就是"单选题正常、多选题怎么都选不上"的真正根因（v3.6.0 修复）。
  function nativeClick(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(t => {
      let ev;
      try {
        ev = t.indexOf('pointer') === 0
          ? new PointerEvent(t, Object.assign({}, opts, { pointerId: 1 }))
          : new MouseEvent(t, opts);
      } catch (e) { try { ev = new MouseEvent(t, opts); } catch (e2) { return; } }
      try { el.dispatchEvent(ev); } catch (e) {}
    });
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
  }

  // 取页面上的全局函数（学习通的作答函数在页面上下文里）
  function getPageFn(name, win) {
    try {
      if (!name) return null;
      const w = win || window;
      if (typeof w[name] === 'function') return w[name];
      if (w.wrappedJSObject && typeof w.wrappedJSObject[name] === 'function') return w.wrappedJSObject[name];
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow[name] === 'function') return unsafeWindow[name];
    } catch (e) {}
    return null;
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
  const TYPE_RE = /(单项选择题|不定项选择题|多项选择题|单选题|单项选择|多选题|判断题|是非题|填空题|简答题|问答题|论述题|名词解释|计算题|分析题)/;
  // 多选判定：学习通经常只写「（多选）」「多项」，所以不能只认“多选题”三个字
  const MULTI_RE = /多选|多项|不定项/;

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
        // 多选判定：文本带“多选/多项/不定项”（常写成「（多选）」）或有原生 checkbox
        const multiHint = MULTI_RE.test(blockText) || inputs.some(x => x.type === 'checkbox')
          || !!box.querySelector('li[role="checkbox"],input[type=checkbox]');
        if (!type) {
          if (textareas.length && CONFIG.ENABLE_SUBJECTIVE) type = '简答题';
          else if (fillInputs.length) type = '填空题';
          else if (multiHint) type = '多选题';
          else if (inputs.length) type = '单选题';
        }
        const isMulti = multiHint || MULTI_RE.test(type);
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
            const num = el.querySelector('span.num_option, span.num_option_dx, [data-letter], .num_option, span[data], i[data]');
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
        // 用统一的选中判定再校正一次（有些版本选中态只体现在子节点的 class 上）
        options.forEach(o => { if (!o.checked && optionSelected(o)) o.checked = true; });

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
          doc, box, type, title, options, inputs, fillInputs, textareas, answered, encrypted, isMulti,
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
      '2. 多选题：answer 必须包含【全部】正确选项字母（通常至少 2 个），按字母顺序，例如 ["A","C"]；绝不能只给一个字母。\n' +
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

  // 把模型返回的答案规范成字母数组。
  // 兼容：["A","C"]（数组）、"AC" / "A,C" / "A、C" / "A B"（多选答案被挤成一个字符串）、全角字母。
  // 注意不能无脑扫全部 [A-Z]，否则 "A. DNA复制" 会被拆成 A/D/N/A。
  function extractLetters(ans) {
    const items = (Array.isArray(ans) ? ans : [ans])
      .map(x => String(x == null ? '' : x).trim())
      .filter(Boolean)
      .map(s => s.replace(/[\uFF21-\uFF3A]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
    if (!items.length) return [];
    // 情形一：整个答案就是“字母 + 分隔符”，直接拆开
    if (items.length === 1 && /^[A-Za-z\s、．,，:：\/\(\)（）]*$/.test(items[0])) {
      const uniq = Array.from(new Set(items[0].toUpperCase().match(/[A-Z]/g) || []));
      if (uniq.length) return uniq;
    }
    // 情形二：数组里每项是一个字母
    const firsts = items.map(s => (s.toUpperCase().match(/[A-Z]/) || [''])[0]).filter(Boolean);
    return Array.from(new Set(firsts));
  }

  /* ==================== 题库检索（v3.3.0） ====================
   * 检索顺序：本地题库 → 自定义题库 → 免费公开题库 → AI 兜底。
   *
   * 免费公开题库用的是社区脚本「超星学习通满分助手」同款接口：
   *   POST https://cx.icodef.com/wyn-nb?v=4    {"question":"题干"}
   *   → {"code":1,"data":"答案1#答案2"}        code:-1 未收录   code:-2 触发流控
   * 实测：免 token、命中率约 5/6，但【只允许 1 并发】，必须严格串行并留间隔，
   * 否则立刻返回 -2 流控。所以这里做了串行队列 + 最小间隔 + 流控冷却。
   *
   * 说明：这是第三方公开接口，不是官方题库；可能失效、可能不准确，
   * 面板上可以一键关掉，关掉后就走原来的 AI 答题流程。
   */
  const BANK_STORE = 'ds-bank-v1';
  let bankLastCall = 0;         // 上一次免费题库请求时间
  let bankCooldownUntil = 0;    // 流控冷却截止时间

  // GM 存储优先（跨 mooc1/mooc2 等学习通子域共享），没有授权就退回 localStorage
  function storeGet(k, dflt) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(k);
        return (v === undefined || v === null || v === '') ? dflt : v;
      }
      const v = localStorage.getItem(k);
      return v === null ? dflt : v;
    } catch (e) { return dflt; }
  }
  function storeSet(k, v) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(k, v); return true; }
      localStorage.setItem(k, v); return true;
    } catch (e) {
      try { log('题库写入失败（存储空间可能已满）', 'err'); } catch (e2) {}
      return false;
    }
  }

  // 通用 HTTP 请求（GM_xmlhttpRequest → Promise；没授权时退回 fetch）
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      const method = opts.method || 'GET';
      const headers = opts.headers || {};
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method, url: opts.url, headers, data: opts.data,
            timeout: opts.timeout || 15000,
            onload: res => resolve(res),
            ontimeout: () => reject(new Error('请求超时')),
            onerror: () => reject(new Error('网络错误'))
          });
          return;
        } catch (e) {}
      }
      fetch(opts.url, { method, headers, body: opts.data })
        .then(r => r.text().then(t => resolve({ status: r.status, responseText: t })))
        .catch(reject);
    });
  }

  // 题干归一化：全角转半角、去掉题号/题型标记，然后只保留中文/字母/数字
  function normQuestion(s) {
    return String(s || '')
      .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[（(【\[]\s*(单项选择题|多项选择题|不定项选择题|单选题|多选题|判断题|填空题?|简答题?)\s*[）)】\]]/g, '')
      .replace(/^\s*\d+\s*[、.．]\s*/, '')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
      .toLowerCase();
  }
  function bankKey(q) { return normQuestion(q.title).slice(0, 200); }

  // 题库答案文本 → 数组："A#B#C" / "正确" / "黑格尔的辩证法#费尔巴哈的唯物论"
  function bankAnswerToArray(raw) {
    return String(raw == null ? '' : raw)
      .split(/[#｜|]+/)
      .map(s => s.replace(/<[^>]*>/g, '').trim())
      .filter(Boolean);
  }

  // 去掉选项行前面的字母标记（"A黑格尔的辩证法" → "黑格尔的辩证法"）
  function stripOptionLetter(t) {
    const s = cleanText(String(t || ''));
    const r = s.replace(/^[A-Za-z][\s.、．:：)）]*/, '').trim();
    return r || s;
  }

  // ---------- 本地题库 ----------
  function loadLocalBank() {
    try {
      const raw = storeGet(BANK_STORE, '{}');
      const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function saveLocalBank(bank) { return storeSet(BANK_STORE, JSON.stringify(bank)); }
  function localBankSize() { return Object.keys(loadLocalBank()).length; }

  // 收录一道题：存「选项文本」而不是字母，这样即使选项顺序变了也能对上
  function rememberQuestion(q, answer) {
    try {
      const ans = String(answer || '').trim();
      if (!ans || ans.length > 400) return;
      const key = bankKey(q);
      if (!key || key.length < 6) return;
      const bank = loadLocalBank();
      if (bank[key] && bank[key].a === ans) return;
      bank[key] = { q: (q.title || '').slice(0, 120), a: ans, t: q.type || '', ts: Date.now() };
      const keys = Object.keys(bank);
      if (keys.length > CONFIG.LOCAL_BANK_MAX) {
        keys.sort((a, b) => (bank[a].ts || 0) - (bank[b].ts || 0));
        keys.slice(0, keys.length - CONFIG.LOCAL_BANK_MAX).forEach(k => delete bank[k]);
      }
      saveLocalBank(bank);
    } catch (e) {}
  }

  // 题型 → chaoxing-toolkit 协议的数字编号（0单选 1多选 2填空 3判断 4简答 5名词解释 6论述 7计算）
  function typeToInt(t) {
    const s = String(t || '');
    if (/多选|多项|不定项/.test(s)) return 1;
    if (/填空/.test(s)) return 2;
    if (/判断|是非/.test(s)) return 3;
    if (/名词解释/.test(s)) return 5;
    if (/论述/.test(s)) return 6;
    if (/计算/.test(s)) return 7;
    if (/简答|问答|分析/.test(s)) return 4;
    return 0;
  }

  // ---------- 自定义题库（兼容 chaoxing-toolkit：POST /api/search） ----------
  async function queryCustomBank(q) {
    if (!CONFIG.BANK_CUSTOM_URL) return null;
    try {
      const r = await gmRequest({
        method: 'POST', url: CONFIG.BANK_CUSTOM_URL, timeout: CONFIG.BANK_TIMEOUT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ question: q.title, type: typeToInt(q.type), key: CONFIG.BANK_CUSTOM_KEY })
      });
      const j = JSON.parse(r.responseText);
      const ans = (j && j.data && (j.data.answer || j.data.ans)) || (j && (j.answer || j.ans)) || '';
      return ans ? { answer: String(ans), src: '自定义题库' } : null;
    } catch (e) { return null; }
  }

  // 发给题库的题干：去掉题号、题型标记，清理空白，限制长度
  function bankQueryText(q) {
    let t = cleanText(q.title || '');
    t = t.replace(/^[0-9０-９]+\s*[、.．]?\s*/, '');
    t = t.replace(/[（(【\[]\s*(单项选择题|多项选择题|不定项选择题|单选题|多选题|判断题|填空题?|简答题?)\s*[）)】\]]/g, '');
    return t.trim().slice(0, 120);
  }

  // 题库返回的「广告/占位」内容不是答案，要当未收录处理。
  // 参考实现（满分助手）也在过滤这几个词：李恒雅/一之/公众号/叛逆。
  const BANK_AD_RE = /叛逆|公众号|李恒雅|一之|未搜索到答案|忙不过来|触发流控|付费题库|购买后|卡密/;
  function isBankGarbage(s) { return BANK_AD_RE.test(String(s || '')); }

  // ---------- 免费公开题库：一之题库（cx.icodef.com，1 并发限制，必须串行 + 限速） ----------
  // 返回 { answer, src } 命中 / { reason } 未命中，reason 用来区分「没这道题」和「请求失败」
  // opts.ignoreRunning：手动「🔌 测试题库」时还没点启动，running 是 false，
  // 不能因为没启动就直接返回「任务已停止」——那样根本没发出请求（v3.4.0 就是栽在这）。
  async function queryFreeBank(question, opts) {
    const ignoreRunning = !!(opts && opts.ignoreRunning);
    if (!CONFIG.BANK_FREE_ENABLED) return { reason: '题库已关闭' };
    const now = Date.now();
    if (now < bankCooldownUntil) return { reason: '流控冷却中' };
    const wait = bankLastCall + CONFIG.BANK_MIN_INTERVAL - now;
    if (wait > 0) await sleep(wait);

    let lastReason = '未发起请求';
    for (const url of CONFIG.BANK_FREE_URLS) {
      if (!ignoreRunning && !running) return { reason: '任务已停止' };
      bankLastCall = Date.now();
      try {
        // 参考实现会带随机 X-Forwarded-For / X-Real-IP（实测并不能绕过流控，
        // 但保持和已知可用实现一致的请求形态，兼容性更好）。
        const ip = [1, 2, 3, 4].map(() => Math.floor(Math.random() * 254) + 1).join('.');
        const r = await gmRequest({
          method: 'POST', url, timeout: CONFIG.BANK_TIMEOUT,
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': ip,
            'X-Real-IP': ip
          },
          data: JSON.stringify({ question })
        });
        const raw = String((r && r.responseText) || '');
        if (r && r.status && r.status !== 200) { lastReason = 'HTTP ' + r.status; continue; }
        let j;
        try { j = JSON.parse(raw); }
        catch (e) { lastReason = '响应非 JSON：' + raw.slice(0, 60).replace(/\s+/g, ' '); continue; }
        if (j.code === 1 && j.data) {
          const txt = String(j.data);
          if (isBankGarbage(txt)) return { reason: '未收录(广告占位)' };
          return { answer: txt, src: '一之题库' };
        }
        if (j.code === -2) {
          bankCooldownUntil = Date.now() + CONFIG.BANK_RATE_BACKOFF;
          return { reason: '流控(code:-2)' };
        }
        if (j.code === -1) return { reason: '未收录(code:-1)' };
        lastReason = '未知响应：' + raw.slice(0, 60);
      } catch (e) {
        lastReason = (e && e.message) || '网络错误';
      }
    }
    return { reason: lastReason };
  }

  // ---------- 备用免费源：muketool（参考 getAnswer4） ----------
  let bank2FailStreak = 0;
  async function queryFreeBank2(q) {
    if (!CONFIG.BANK_FREE2_ENABLED) return { reason: '备用源已关闭' };
    if (bank2FailStreak >= 3) return { reason: '备用源连续失败已停用' };
    try {
      const r = await gmRequest({
        method: 'POST', url: CONFIG.BANK_FREE2_URL, timeout: CONFIG.BANK_TIMEOUT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ question: bankQueryText(q), type: typeToInt(q.type) })
      });
      const raw = String((r && r.responseText) || '');
      if (r && r.status && r.status !== 200) { bank2FailStreak++; return { reason: 'HTTP ' + r.status }; }
      let j;
      try { j = JSON.parse(raw); }
      catch (e) { bank2FailStreak++; return { reason: '响应非 JSON：' + raw.slice(0, 40).replace(/\s+/g, ' ') }; }
      bank2FailStreak = 0;
      if (j.code === 1 && j.data) {
        const txt = String(j.data);
        if (isBankGarbage(txt)) return { reason: '未收录(广告占位)' };
        return { answer: txt, src: 'free4' };
      }
      return { reason: '未收录' };
    } catch (e) {
      bank2FailStreak++;
      return { reason: (e && e.message) || '网络错误' };
    }
  }

  // ---------- 统一检索入口 ----------
  async function bankLookup(questions) {
    const found = new Map();     // q.index → { answer, src }
    if (!CONFIG.BANK_ENABLED) return found;

    // ① 本地题库（零延迟）
    const bank = CONFIG.LOCAL_BANK ? loadLocalBank() : {};
    const miss = [];
    for (const q of questions) {
      const hit = bank[bankKey(q)];
      if (hit && hit.a) found.set(q.index, { answer: hit.a, src: '本地题库' });
      else miss.push(q);
    }
    if (!miss.length) return found;

    // ② 自定义题库
    const still = [];
    for (const q of miss) {
      if (!running) return found;
      const r = CONFIG.BANK_CUSTOM_URL ? await queryCustomBank(q) : null;
      if (r) found.set(q.index, r); else still.push(q);
    }
    if (!still.length) return found;

    // ③ 免费公开题库（严格串行 + 限速）
    let n = 0;
    let errStreak = 0;
    const cap = Math.min(still.length, CONFIG.BANK_MAX_PER_ROUND);
    for (const q of still) {
      if (!running) break;
      if (n >= cap) {
        log(`本轮免费题库查询已达上限 ${cap} 题，其余直接交给 AI`, 'warn');
        break;
      }
      if (Date.now() < bankCooldownUntil) { log('题库流控冷却中，其余题目直接交给 AI', 'warn'); break; }
      n++;
      setStatus(`题库检索 ${n}/${cap}…`);
      if (n === 1) log('  题库查询文本示例：' + bankQueryText(q).slice(0, 60));
      const r = await queryFreeBank(bankQueryText(q));
      if (r && r.answer) {
        errStreak = 0;
        found.set(q.index, { answer: r.answer, src: r.src });
        log(`第 ${q.index} 题 题库命中（${r.src}）：${r.answer.slice(0, 45)}`, 'ok');
        continue;
      }
      const reason = (r && r.reason) || '未知原因';
      if (/网络|超时|HTTP|非 JSON|未知响应|未发起/.test(reason)) {
        errStreak++;
        log(`第 ${q.index} 题 题库请求失败：${reason}`, 'err');
        if (errStreak >= 2) {
          log('题库连续 2 次请求失败（网络不通 / 接口挂了 / 跨域被拦），本轮直接改用 AI。可点「🔌 测试题库」看详情', 'err');
          break;
        }
      } else if (/流控/.test(reason)) {
        log(`第 ${q.index} 题 题库流控，冷却 ${Math.round(CONFIG.BANK_RATE_BACKOFF / 1000)}s…`, 'warn');
      } else {
        // 主源是通的、只是没这道题（或返回广告占位）→ 再试一下备用免费源
        let r2 = null;
        if (CONFIG.BANK_FREE2_ENABLED) {
          r2 = await queryFreeBank2(q);
          if (r2 && r2.answer) {
            found.set(q.index, { answer: r2.answer, src: r2.src });
            log(`第 ${q.index} 题 备用题库命中（${r2.src}）：${r2.answer.slice(0, 45)}`, 'ok');
            continue;
          }
        }
        log(`第 ${q.index} 题 题库未收录（${reason}${r2 ? '；备用源：' + (r2.reason || '无') : ''}），交给 AI`);
      }
    }
    return found;
  }

  /* ---------------- 多选题答案跟踪（反复补选，直到真的选上） ---------------- */
  // 关键点：多选题只要有一个目标选项没真正选上，主循环就会重试点击，
  // 而不是因为 answered=true 就当它做完了 —— 这正是“多选只选上一个就跑了”的原因。
  const multiPlan = new Map();   // 题目 key → { letters: 期望选中的字母, tries: 已补选次数 }
  function qKeyOf(q) { return ((q.title || '').replace(/\s+/g, '')).slice(0, 60) + '#' + q.options.length; }
  function selectedLetters(q) {
    return q.options.filter(o => o.checked || optionSelected(o)).map(o => o.letter);
  }
  function pendingMulti(q) {
    const plan = multiPlan.get(qKeyOf(q));
    if (!plan || plan.letters.length < 2 || plan.tries >= 5) return null;
    const sel = selectedLetters(q);
    const missing = plan.letters.filter(L => sel.indexOf(L) < 0);
    return missing.length ? { plan, missing } : null;
  }

  /* ---------------------------- 执行作答 ---------------------------- */
  // 把「答案数组」映射成选项对象。题库答案和 AI 答案共用这一套：
  //   字母（A / A#B）→ 按字母
  //   选项文本（黑格尔的辩证法）→ 归一化包含匹配
  //   判断题（正确/错误/对/错）→ 语义兜底
  function mapAnswersToOptions(q, ans) {
    const picked = [];
    const pushOpt = opt => { if (opt && !picked.includes(opt)) picked.push(opt); };

    // ① 字母
    extractLetters(ans).forEach(letter => pushOpt(q.options.find(o => o.letter === letter)));

    // ② 选项文本
    if (!picked.length) {
      ans.forEach(a => {
        const kw = normQuestion(stripOptionLetter(a).replace(/^[A-Za-z][.、．\s]*/, ''));
        if (!kw) return;
        q.options.forEach(o => {
          const no = normQuestion(stripOptionLetter(o.text));
          if (!no) return;
          if (no === kw || no.includes(kw) || kw.includes(no)) pushOpt(o);
        });
      });
      // 单选题只可能有一个答案：多个命中时留最长的，避免“人”这种短选项误匹配
      if (!q.isMulti && picked.length > 1) {
        picked.sort((a, b) => normQuestion(stripOptionLetter(b.text)).length - normQuestion(stripOptionLetter(a.text)).length);
        picked.splice(1);
      }
    }

    // ③ 判断题语义
    if (!picked.length) {
      const raw = ans.map(String).join(' ');
      const wantTrue = /正确|对|是|√|true|\bT\b/i.test(raw);
      const wantFalse = /错误|错|否|×|false|\bF\b/i.test(raw);
      const re = wantTrue ? /正确|对|是|√|true|yes/i : (wantFalse ? /错误|错|否|×|false|no/i : null);
      if (re) pushOpt(q.options.find(o => re.test(cleanText(String(o.text || '')))));
    }
    return picked;
  }

  async function answerQuestions(questions) {
    const answers = {};
    const sources = {};

    // ========== 第一段：题库（本地 → 自定义 → 免费公开） ==========
    try {
      const hit = await bankLookup(questions);
      if (hit.size) {
        const srcs = Array.from(new Set(Array.from(hit.values()).map(v => v.src))).join('、');
        hit.forEach((v, idx) => {
          answers[idx] = bankAnswerToArray(v.answer);
          sources[idx] = v.src;
          const q = questions.find(x => x.index === idx);
          // 外部题库命中即时回写本地库，下次免查询
          if (q && CONFIG.LOCAL_BANK && v.src !== '本地题库') rememberQuestion(q, v.answer);
        });
        log(`题库命中 ${hit.size}/${questions.length} 题（${srcs}）`, 'ok');
      } else if (CONFIG.BANK_ENABLED) {
        log('题库全部未命中，交给 AI');
      }
    } catch (e) {
      log('题库检索异常：' + e.message, 'warn');
    }
    if (!running) return false;

    // ========== 第二段：AI 兜底（只查题库没命中的题） ==========
    const needAI = questions.filter(q => !answers[q.index] || !answers[q.index].length);
    let aiFailed = false;
    if (needAI.length) {
      log(`AI 兜底作答 ${needAI.length} 题…`);
      const useVision = needAI.some(q => q.encrypted);
      try {
        if (useVision) {
          // 字体加密题：截图（浏览器按自定义字体正常渲染）→ 视觉模型
          log('检测到字体加密（font-cxsecret），改为截图交给视觉模型识别…', 'warn');
          const shots = new Map();
          for (const q of needAI) {
            if (!running) return false;
            try {
              setStatus(`截图第 ${q.index} 题…`);
              shots.set(q.index, await shotQuestion(q));
            } catch (e) {
              log(`第 ${q.index} 题截图失败：${e.message}`, 'err');
            }
          }
          for (let i = 0; i < needAI.length; i += CONFIG.VISION_BATCH) {
            if (!running) return false;
            const batch = needAI.slice(i, i + CONFIG.VISION_BATCH).filter(q => shots.has(q.index));
            if (!batch.length) continue;
            const imgs = batch.map(q => shots.get(q.index));
            log(`视觉识别第 ${batch[0].index}–${batch[batch.length - 1].index} 题（${imgs.length} 张图）…`);
            const content = await glmVisionRequest(imgs, batch);
            Object.assign(answers, parseAnswers(content, batch));
            await sleep(500);
          }
        } else {
          log(`正在请求 DeepSeek（${CONFIG.MODEL}）作答 ${needAI.length} 道题…`);
          const content = await glmRequest(buildPrompt(needAI));
          log('DeepSeek 已返回：' + content.slice(0, 120).replace(/\n/g, ' '));
          Object.assign(answers, parseAnswers(content, needAI));
        }
        needAI.forEach(q => { if (answers[q.index] && answers[q.index].length) sources[q.index] = 'AI'; });
      } catch (e) {
        aiFailed = true;
        log('模型请求失败：' + e.message, 'err');
      }
    }

    // ========== 第三段：应用答案 ==========
    for (const q of questions) {
      if (!running) return false;
      const ans = answers[q.index];
      const src = sources[q.index] ? '[' + sources[q.index] + '] ' : '';
      if (!ans || !ans.length) { log(`第 ${q.index} 题未取得答案，跳过`, 'warn'); continue; }

      try { q.box.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(200);

      if (/填空/.test(q.type)) {
        q.fillInputs.forEach((inp, i) => {
          const v = (ans[i] ?? ans[0] ?? '').toString().trim();
          if (v) { setNativeValue(inp, v); }
        });
        log(`${src}第 ${q.index} 题（填空）已填入：${ans.join(' / ').slice(0, 60)}`, 'ok');
        if (CONFIG.LOCAL_BANK) rememberQuestion(q, ans.join('|'));
      } else if (/简答|问答|论述|名词解释|计算|分析/.test(q.type)) {
        const ta = q.textareas[0];
        if (ta) { setNativeValue(ta, ans[0].toString()); log(`第 ${q.index} 题（简答）已填写`, 'ok'); }
        // 主观题不回写题库：AI 的简答答案不可靠，避免污染题库
      } else {
        // 选择/判断题：字母/文本/判断语义 → 逐个点击 → 校验 → 没选上的补点一次
        const picked = mapAnswersToOptions(q, ans);
        if (picked.length) {
          const isMulti = q.isMulti || picked.length > 1;
          const targetLetters = picked.map(o => o.letter);
          let cur = q;

          // 每次点击前确认节点还在，失效就重新采集（应对 JS 重渲染）
          const resolveOpt = L => {
            let o = (cur.options || []).find(x => x.letter === L) || null;
            if (!o || !o.el || o.el.isConnected === false) {
              cur = refreshQuestion(cur);
              o = (cur.options || []).find(x => x.letter === L) || o;
            }
            return o;
          };

          const clickRes = [];
          for (const L of targetLetters) {
            const opt = resolveOpt(L);
            if (!opt) { log(`第 ${q.index} 题找不到选项 ${L}`, 'warn'); continue; }
            clickRes.push({ L, ok: await clickOption(opt, isMulti) });
          }

          // 复检（用刷新后的题目对象）
          const findOpt = L => (cur.options || []).find(x => x.letter === L);
          cur = refreshQuestion(cur);
          let missing = targetLetters.filter(L => { const o = findOpt(L); return o && !optionSelected(o); });
          // 只补点「点了完全没反应」的选项；已经有状态变化的一律不再点，避免连点把多选抵消
          const retryL = clickRes.filter(r => !r.ok).map(r => r.L).filter(L => missing.indexOf(L) > -1);
          if (retryL.length) {
            await sleep(350);
            for (const L of retryL) {
              const opt = findOpt(L);
              if (opt) await clickOption(opt, isMulti, { force: true });
            }
            cur = refreshQuestion(cur);
            missing = targetLetters.filter(L => { const o = findOpt(L); return o && !optionSelected(o); });
          }
          log(`${src}第 ${q.index} 题（${q.type || (isMulti ? '多选题' : '单选题')}）已选：${targetLetters.join('、')}`
            + (missing.length ? `｜警告：${missing.join('、')} 仍未选中` : ''),
            missing.length ? 'warn' : 'ok');
          // 还是没选上：自动把这道题的真实结构导出并复制到剪贴板，省得用户再去找按钮
          if (missing.length) {
            try {
              const rep = questionReport(q);
              console.log('[DS答题-选不上的题]\n' + rep);
              log('已自动导出该题结构' + (copyText(rep) ? '并复制到剪贴板，直接粘贴给助手即可' : '（复制失败，请按 F12 看 [DS答题-选不上的题]）'), 'err');
            } catch (e) {}
          }
          // 记下多选的期望答案：只要没选全，主循环会继续补选
          if (isMulti) multiPlan.set(qKeyOf(q), { letters: targetLetters, tries: 0 });
          if (isMulti && picked.length < 2) {
            log(`第 ${q.index} 题判定为多选题，但只拿到 1 个答案（${ans.join(',')}），可能漏选，请人工确认`, 'err');
          }
          // 回写本地题库：存「选项文本」，选项顺序变了也能对上
          if (CONFIG.LOCAL_BANK) rememberQuestion(q, picked.map(o => stripOptionLetter(o.text)).join('#'));
        } else {
          log(`第 ${q.index} 题答案无法匹配选项：${ans.join(',')}`, 'warn');
        }
      }
      await sleep(450);
    }

    if (aiFailed && !Object.keys(answers).length) { await sleep(3000); return false; }
    return true;
  }

  // 学习通把已选答案写在 <input type="hidden" name="answer<qid>"> 里（如 "A" / "A,C"）。
  // 这是最权威的"到底选上了没有"的依据，非空时优先信它。
  function hiddenAnswerLetters(box) {
    try {
      if (!box || !box.querySelectorAll) return null;
      const all = Array.from(box.querySelectorAll('input[type=hidden][name^="answer"]'));
      // 排除 answertype<qid> 这种干扰项，优先取 answer<qid>
      const hid = all.find(x => /^answer\d+$/i.test(x.name || '')) || all[0];
      if (!hid) return null;
      const v = String(hid.value || '').toUpperCase();
      const set = new Set(v.match(/[A-Z]/g) || []);
      return set.size ? set : null;
    } catch (e) { return null; }
  }

  // 综合判定选项是否已选中：原生 checked / aria-* / 选中类名（自身 + 子节点都看）
  // 判定要"宽"：宁可认为已选中也不要漏判，否则会出现"点了但脚本以为没点上"而反复点，
  // 对多选来说反复点 = 来回 toggle = 最后什么也没选上。
  function optionSelected(opt) {
    const li = opt.li || opt.el;
    if (!li) return false;
    if (opt.input && opt.input.checked) return true;
    // 权威信号：本题隐藏答案框里已经包含这个字母
    try {
      const box = li.closest && li.closest(CONFIG.QUESTION_BLOCK_SEL);
      const set = box ? hiddenAnswerLetters(box) : null;
      if (set && set.has(opt.letter)) return true;
    } catch (e) {}
    const nodes = [li, opt.label, opt.num];
    try {
      if (li.querySelectorAll) {
        nodes.push.apply(nodes, li.querySelectorAll('a.before,i.before,span.before,.num_option,[class*="before"],[class*="letter"]'));
      }
    } catch (e) {}
    for (const n of nodes) {
      if (!n || !n.getAttribute) continue;
      if (n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-pressed') === 'true'
        || n.getAttribute('aria-selected') === 'true') return true;
      const c = typeof n.className === 'string' ? n.className : '';
      if (/(^|[\s_-])(chosen|active|selected|checked|on)([\s_-]|$)/i.test(c)) return true;
      if (/(^|\s)cur(\s|$)/i.test(c)) return true;
    }
    return false;
  }

  // 学习通各版本点击方式差别很大。这里的三条原则是这一轮多选修复的核心：
  //   ① 每点一次都要验证状态真的变了，没变就换下一种方式；
  //   ② 多选（checkbox）最怕"一次点击被触发两遍" —— li 上的 onclick 和 label 的默认激活
  //      会同时生效，toggle 两次 = 抵消，表现就是"怎么点都选不上"。所以先走
  //      addChoice / 原生 input 这种【只触发一次】的路径，点字母标记时才用不冒泡的 click；
  //   ③ 多选绝不能清除同组其它已选项，否则会把刚选上的答案抹掉。
  // 防连点：同一个选项刚点过就不要再点 —— 多选的 checkbox 连点两次 = 刚刚选上的又被取消，
  // 表现就是"怎么点都选不上"。这是 v3.3.0 之后重点怀疑的元凶之一。
  const recentClicks = new WeakMap();
  const CLICK_GUARD_MS = 600;

  // 重新采集一道题：学习通新版是 JS 渲染，点一个选项后整段可能重新渲染，
  // 之前缓存的 li 节点会失效，后续点击等于点在空气上（多选只剩第一个的元凶）。
  function refreshQuestion(q) {
    try {
      const all = collectQuestions(getAllDocs());
      const key = qKeyOf(q);
      return all.find(x => qKeyOf(x) === key) || q;
    } catch (e) { return q; }
  }

  async function clickOption(opt, isMulti, opts) {
    const li = opt.li || (opt.el && opt.el.tagName === 'LI' ? opt.el : opt.el);
    if (!li) return false;
    const blockText = ((li.closest && li.closest('.TiMu')) || {}).textContent || '';
    const multi = isMulti === true || MULTI_RE.test(blockText);
    if (optionSelected(opt)) return true;

    // 连点保护
    const lastClick = recentClicks.get(li);
    if (!(opts && opts.force) && lastClick && Date.now() - lastClick < CLICK_GUARD_MS) {
      log(`      选项 ${opt.letter} 刚点过 ${Date.now() - lastClick}ms，跳过以防连点抵消`, 'warn');
      return optionSelected(opt);
    }

    const win = li.ownerDocument.defaultView;
    const tick = () => sleep(140);
    const before = (li.querySelector && li.querySelector('a.before,span.before,i.before,a[class*="before"],.font-label,span[class*="letter"]')) || null;

    // 整题「选中态签名」：判断这一次点击到底有没有产生效果。
    // 只依赖单个选项的识别器并不可靠（学习通各版本标记方式不同）；一旦漏判，
    // 上层就会反复点同一个选项 → 多选被来回 toggle → 最后一个都选不上。
    const sigOf = () => {
      try {
        const box = li.closest && li.closest(CONFIG.QUESTION_BLOCK_SEL);
        if (!box || !box.querySelectorAll) return null;
        const out = [];
        Array.from(box.querySelectorAll('li')).forEach((x, i) => {
          const c = typeof x.className === 'string' ? x.className : '';
          const aria = x.getAttribute && x.getAttribute('aria-checked');
          const inp = x.querySelector && x.querySelector('input[type=checkbox],input[type=radio]');
          if ((inp && inp.checked) || aria === 'true'
            || /(^|[\s_-])(chosen|active|selected|checked|on)([\s_-]|$)/i.test(c)
            || /(^|\s)cur(\s|$)/i.test(c)) out.push(i);
        });
        return out.join(',');
      } catch (e) { return null; }
    };

    // 单次尝试：只要「整题选中态发生了变化」就算这一步生效，不再纠结单个选项认不认得出
    const attempt = async (how, fn) => {
      if (optionSelected(opt)) return true;
      recentClicks.set(li, Date.now());
      const s0 = sigOf();
      try { fn(); } catch (e) {}
      await tick();
      if (optionSelected(opt)) { log(`      选项 ${opt.letter} 选中成功（${how}）`); return true; }
      const s1 = sigOf();
      if (s0 !== null && s1 !== null && s0 !== s1) {
        log(`      选项 ${opt.letter} 点击后整题选中态已变化（${s0 || '空'} → ${s1 || '空'}，${how}），判定为已选中`, 'warn');
        return true;
      }
      return false;
    };

    // ① 直接调用页面自己的作答函数（最接近真人点击，且只触发一次）。
    //    学习通不同版本函数名不同：addChoice / addMultipleChoice / addSingleChoice …
    //    所以从 li 的 onclick 属性里把函数名抠出来调，不再写死。
    const handlerName = (() => {
      try {
        const a = li.getAttribute && li.getAttribute('onclick');
        const m = a && String(a).match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
        return m ? m[1] : '';
      } catch (e) { return ''; }
    })();
    if (handlerName) {
      const fn = getPageFn(handlerName, win);
      if (typeof fn === 'function') {
        if (await attempt('调用页面 ' + handlerName + '()', () => {
          try { li.scrollIntoView({ block: 'center' }); } catch (e) {}
          fn.call(win, li);
        })) return true;
      }
    }
    // 注意：这里【不再】盲目调用全局 addChoice/addMultipleChoice。
    // 同一页面里单选和多选的作答函数名不同，乱调会调错函数；
    // 没有 onclick 属性的版本交给下面的 nativeClick(li) 触发页面自己绑定的处理器即可。

    // ② 原生 input：单击一次，不会被 label + li 双重触发抵消
    if (opt.input) {
      if (await attempt('点原生 input', () => { try { opt.input.click(); } catch (e) {} })) return true;
      if (await attempt('input.checked=true + change', () => {
        opt.input.checked = true;
        opt.input.dispatchEvent(new Event('input', { bubbles: true }));
        opt.input.dispatchEvent(new Event('change', { bubbles: true }));
        if (win.jQuery) { try { win.jQuery(opt.input).trigger('change'); } catch (e) {} }
      })) return true;
    }

    // ③ 点 li 本体：事件目标就是 li，label 的默认激活不参与，只触发 li 自己的 onclick
    if (await attempt('点 li 本体', () => { try { li.scrollIntoView({ block: 'center' }); } catch (e) {} nativeClick(li); })) return true;

    // ④ label（它会激活内部 input）
    if (opt.label && await attempt('点 label', () => nativeClick(opt.label))) return true;

    // ⑤ 字母标记：先用【不冒泡】的 click，避免同时触发 li 的 onclick 造成多选抵消
    if (before) {
      if (await attempt('点字母标记(不冒泡)', () => {
        before.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true, view: win }));
      })) return true;
      if (await attempt('点字母标记(冒泡)', () => nativeClick(before))) return true;
    }

    // ⑥ 点选项文字：有些组件把事件绑在内层 span/div 上，点 li 本体不会触发（事件不向下派发）
    const textEl = (() => {
      try {
        const cands = Array.from(li.querySelectorAll('div,span,a,p'));
        return cands.find(x => cleanText(x.textContent || '').length > 1 && !x.querySelector('input,button')) || null;
      } catch (e) { return null; }
    })();
    if (textEl && textEl !== li && await attempt('点选项文字', () => nativeClick(textEl))) return true;

    // ⑦ 纯 JS 组件的最后兜底：手动同步 aria / class / 隐藏答案框
    try {
      li.setAttribute('aria-checked', 'true');
      li.setAttribute('aria-pressed', 'true');
      if (li.classList) li.classList.add('chosen');
      if (before && before.classList) before.classList.add('chosen');
      const ul = li.closest && li.closest('ul');
      if (ul && !multi) {                       // 单选才清同组；多选绝对不能清
        ul.querySelectorAll('li').forEach(x => {
          if (x === li) return;
          x.setAttribute('aria-checked', 'false');
          x.setAttribute('aria-pressed', 'false');
          if (x.classList) x.classList.remove('chosen');
        });
      }
      // 隐藏答案框：只做"并集"累加，绝不覆盖 —— 单选覆盖没事，多选覆盖就只剩最后一个字母。
      // 注意【必须限定在本题块内】找，否则会把答案写进文档里第一道题的隐藏框（真实踩过）。
      const name = opt.num && opt.num.getAttribute && opt.num.getAttribute('name');
      const doc = li.ownerDocument;
      const box = (li.closest && li.closest(CONFIG.QUESTION_BLOCK_SEL)) || null;
      const scope = box || doc;
      const hids = [];
      if (name) {
        let e = null;
        try { e = doc.getElementById(name); } catch (err) {}
        if (e && (scope === doc || scope.contains(e))) hids.push(e);
        else if (scope.querySelector) {
          const e2 = scope.querySelector('input[name="' + name + '"]');
          if (e2) hids.push(e2);
        }
      }
      const byName = scope.querySelector && scope.querySelector('input[type=hidden][name^="answer"]');
      if (byName) hids.push(byName);
      hids.forEach(hid => {
        const cur = String(hid.value || '');
        if (!multi) { setNativeValue(hid, opt.letter); return; }
        const set = new Set(cur.toUpperCase().match(/[A-Z]/g) || []);
        set.add(opt.letter);
        setNativeValue(hid, Array.from(set).sort().join(''));
      });
    } catch (e) {}
    await tick();
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
        if (isOwnUI(el)) return;
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

  // 元素是否属于脚本自己的面板。面板上写着「章节测验」「下一节」等字样，
  // 不排掉会被当成任务点标签点掉（实测踩过这个坑）。
  function isOwnUI(el) {
    try { return !!(el && el.closest && el.closest('#glm-panel')); } catch (e) { return false; }
  }

  // 精确目录判定（任务点标签专用）：只认确定的章节树容器
  function isInCatalogStrict(el) {
    try { return !!(el && el.closest && el.closest(CONFIG.CATALOG_STRICT_SEL)); } catch (e) { return false; }
  }

  /* =============== v3.0.0 新增：下一节解析基础设施 =============== */
  const CLICKABLE_SEL = 'a,button,[role=button],input[type=button],input[type=submit],div,span,li,.btn';
  let badNextEls = new WeakSet();      // 点过但页面没反应的“下一节”，本任务点内不再尝试
  function resetBadNext() { badNextEls = new WeakSet(); }

  // 元素/文档的可读描述（只为日志服务，方便你肉眼核对脚本要点哪一个）
  function elDesc(el) {
    if (!el) return '?';
    const cls = (typeof el.className === 'string' ? el.className : '')
      .trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return `<${(el.tagName || '?').toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}>`;
  }
  function docDesc(doc) {
    try {
      const isTop = doc === window.top.document;
      const u = (doc.location && doc.location.href) || '';
      return (isTop ? '【顶层】' : '【iframe】') + u.replace(/^https?:\/\/[^/]+/, '').slice(0, 64);
    } catch (e) { return '【?】'; }
  }

  // 顶层文档 / 任务点 iframe 分类
  function splitDocs(docs) {
    const topDoc = window.top.document;
    const tops = [], frames = [];
    docs.forEach(d => (d === topDoc ? tops : frames).push(d));
    const modules = frames.filter(d => {
      try {
        const u = (d.location && d.location.href) || '';
        if (CONFIG.MODULE_IFRAME_RE.test(u)) return true;
        return !!d.querySelector('video,.vjs-tech,.vjs-player,.TiMu,.questionLi,.mark_question,.Zy_TItle');
      } catch (e) { return false; }
    });
    return { tops, frames, modules };
  }

  // 顶层页面左侧区域（学习通的课程目录树就长在这里）
  function isInLeftRail(el, doc) {
    if (doc !== window.top.document) return false;
    try {
      const r = el.getBoundingClientRect();
      const w = doc.documentElement.clientWidth || window.innerWidth || 0;
      if (!w || !r.width) return false;
      return (r.left + r.width) <= w * CONFIG.CATALOG_LEFT_RATIO;
    } catch (e) { return false; }
  }

  // “下一节”文本匹配度：0 最精确
  function nextTextRank(t) {
    if (!t) return 99;
    if (/^下一[节集讲]$/.test(t)) return 0;
    if (/^下一(课时|页|个)$/.test(t)) return 1;
    if (CONFIG.NEXT_BTN_TEXT.some(x => t === x)) return 1;
    if (t.length <= 8 && CONFIG.NEXT_BTN_TEXT.some(x => t.includes(x))) return 2;
    return 99;
  }

  // 返回“排除原因”；null 表示这个元素可以当候选
  function rejectReason(el, doc, opts) {
    opts = opts || {};
    if (!el || el.nodeType !== 1) return '不是元素';
    if (isOwnUI(el)) return '是脚本自己的面板';
    if (!isVisible(el)) return '不可见';
    if (isDisabled(el)) return '已禁用';
    if (el === document.body || el === document.documentElement) return '根节点';
    if (isInCatalog(el)) return '在目录/侧栏容器内';
    if (isInLeftRail(el, doc)) return '在顶层页面左侧栏区域';
    if (badNextEls.has(el)) return '上次点击无效，已拉黑';
    const t = cleanText(el.textContent || el.value || '');
    if (!t) return opts.allowEmpty ? null : '无文本';
    if (t.length > 10) return '文本过长';
    if (CONFIG.EXCLUDE_TEXT.some(x => t.includes(x))) return '命中排除词：' + t;
    if (nextTextRank(t) === 99) return '文本不是下一节：' + t;
    return null;
  }

  // 任务点内容指纹：只关心“任务点有没有换”，比整页指纹更贴合本场景
  function taskSignature(docs) {
    const out = [];
    docs.forEach(doc => {
      try {
        const isTop = doc === window.top.document;
        const q = doc.querySelectorAll(CONFIG.QUESTION_BLOCK_SEL).length;
        const v = doc.querySelectorAll('video,.vjs-tech,.vjs-player').length;
        const href = isTop ? '' : ((doc.location && doc.location.href) || '');
        const head = doc.querySelector(CONFIG.QUESTION_BLOCK_SEL);
        out.push([isTop ? 'T' : 'F', q, v, href.slice(0, 100),
          head ? cleanText(head.textContent).slice(0, 40) : ''].join('|'));
      } catch (e) { out.push('?'); }
    });
    return out.join(' || ');
  }

  // 点击前把目标框出来（支持 iframe 内），让你肉眼确认它要点哪个
  let hlBox = null;
  function clearHighlight() {
    try { if (hlBox && hlBox.parentNode) hlBox.parentNode.removeChild(hlBox); } catch (e) {}
    hlBox = null;
  }
  function highlight(el) {
    clearHighlight();
    try {
      const r = el.getBoundingClientRect();
      const d = el.ownerDocument;
      const box = d.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;'
        + 'left:' + Math.max(0, r.left - 4) + 'px;top:' + Math.max(0, r.top - 4) + 'px;'
        + 'width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;'
        + 'border:3px solid #ff2d55;border-radius:5px;box-shadow:0 0 12px rgba(255,45,85,.85)';
      d.body.appendChild(box);
      hlBox = box;
    } catch (e) {}
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

  /* ------------- 下一节候选解析（v3.0.0 修复核心） -------------
   * 旧版把顶层窗口和所有 iframe 混成一个候选池，只排序后返回单个元素；
   * 学习通左侧目录树里的“下一节”因此可能压过视频下方那个真按钮，
   * 而且点错之后没有任何校验 —— 这就是“在目录里面找”的 bug。
   * 现在：目录/左侧栏硬排除 → 视频页只认含播放器的文档 → 顶层候选重罚兜底
   *      → 返回排序后的候选列表，由主循环逐个点击并校验任务点是否真的切换。
   */
  function collectNextCandidates(docs, opts) {
    opts = opts || {};
    const isVideo = !!opts.video;
    const { modules } = splitDocs(docs);
    let scope = docs;
    let scopeWhy = '全文档搜索';

    if (isVideo) {
      const vd = docs.filter(d => {
        try { return !!d.querySelector('video,.vjs-tech,.vjs-player'); } catch (e) { return false; }
      });
      if (vd.length) {
        scope = vd;
        scopeWhy = '视频页：只搜含播放器的文档（视频下面那个“下一节”就在这）';
      } else if (modules.length) {
        scope = modules;
        scopeWhy = '视频页（没抓到播放器元素）：退回任务点 iframe';
      }
    }

    const cands = [];
    const railFallback = [];   // 只在“一个候选都没有”时才放回来的左侧栏兜底
    const seen = new Set();

    const add = (el, doc, why) => {
      if (!el || seen.has(el)) return null;
      seen.add(el);
      const t = cleanText(el.textContent || el.value || '') || '下一节';
      const isTop = doc === window.top.document;
      // 顶层文档的候选一律重罚：目录树/顶部章节导航都在顶层，只作最后的兜底
      let prio = 30 + nextTextRank(t) * 5 + (isTop ? 40 : 0);
      if (isVideo) {
        try {
          const v = doc.querySelector('video,.vjs-tech,.vjs-player');
          if (v) {
            const vr = v.getBoundingClientRect(), er = el.getBoundingClientRect();
            if (er.top >= vr.bottom - 8) prio -= 20;        // 正好在播放器下方
          }
          if (el.closest(CONFIG.NEXT_BAR_SEL)) prio -= 5;   // 在底部按钮条容器里
        } catch (e) {}
      }
      // 叶子节点更像真按钮；包着一堆子元素的大容器（比如整个按钮条）降权
      try { if (!el.children || el.children.length === 0) prio -= 6; } catch (e) {}
      const c = { el, doc, t, why, prio };
      cands.push(c);
      return c;
    };

    // 0) 手动拾取的选择器：优先级最高
    if (CONFIG.NEXT_BTN_PICKED) {
      docs.forEach(doc => {
        let el = null;
        try { el = doc.querySelector(CONFIG.NEXT_BTN_PICKED); } catch (e) {}
        if (el && !rejectReason(el, doc, { allowEmpty: true })) {
          const c = add(el, doc, '手动拾取');
          if (c) c.prio = -100;
        }
      });
    }

    // 1) ID/类名明确的下一节按钮（最可靠）
    scope.forEach(doc => {
      let els = [];
      try { els = Array.from(doc.querySelectorAll(CONFIG.NEXT_BTN_SEL)); } catch (e) {}
      els.forEach(el => {
        const r = rejectReason(el, doc, { allowEmpty: true });
        if (r) {
          if (r.indexOf('左侧栏') >= 0) railFallback.push([el, doc, '命中 NEXT_BTN_SEL']);
          return;
        }
        add(el, doc, '命中 NEXT_BTN_SEL');
      });
    });

    // 2) 底部按钮条容器内按文本找
    scope.forEach(doc => {
      let bars = [];
      try { bars = Array.from(doc.querySelectorAll(CONFIG.NEXT_BAR_SEL)); } catch (e) {}
      bars.forEach(bar => {
        if (isInCatalog(bar) || isInLeftRail(bar, doc)) return;
        let els = [];
        try { els = Array.from(bar.querySelectorAll(CLICKABLE_SEL)); } catch (e) {}
        els.forEach(el => {
          if (rejectReason(el, doc)) return;
          add(el, doc, '按钮条容器内');
        });
      });
    });

    // 3) 全文文本匹配（兜底），只认可点击元素
    scope.forEach(doc => {
      let els = [];
      try { els = Array.from(doc.querySelectorAll(CLICKABLE_SEL)); } catch (e) {}
      els.forEach(el => {
        if (rejectReason(el, doc)) return;
        const t = cleanText(el.textContent || el.value || '');
        const cls = typeof el.className === 'string' ? el.className : '';
        const clickable = /^(A|BUTTON|INPUT)$/.test(el.tagName)
          || el.getAttribute('role') === 'button' || el.hasAttribute('onclick')
          || /btn|button|next/i.test(cls);
        if (!clickable) return;
        add(el, doc, '全文文本匹配');
      });
    });

    // 全部落空时才启用左侧栏兜底（避免“明明有按钮却被判成本课程结束”）
    if (!cands.length && railFallback.length) {
      railFallback.forEach(item => {
        const c = add(item[0], item[1], item[2] + '（左侧栏兜底：无其它候选）');
        if (c) c.prio += 60;
      });
    }

    // 排序：prio 升序 → 文本越短越像个按钮
    cands.sort((a, b) => (a.prio - b.prio) || (a.t.length - b.t.length));
    return { cands: cands.slice(0, 8), scopeWhy, modules: modules.length };
  }

  function findNext(docs, opts) {
    const { cands } = collectNextCandidates(docs, opts);
    return cands[0] || null;
  }

  /* --------- 同小节内的任务点标签（视频 → 章节测验） ---------
   * 学习通一个「小节」里通常有多个任务点，例如「1 视频」「2 章节测验」。
   * 视频看完后如果直接点底部「下一节」，会跳到下一个小节，把本章测验整段跳过。
   * 所以：当前页没有题目时，先把还没做的任务点标签点开；确实没有标签才点「下一节」。
   * 这里只负责“找”，失败拉黑/换下一个由 clickNextWithRetry 统一处理。
   */
  let visitedTabs = new Set();     // 本小节内已经点过的任务点标签，防止任务点之间来回横跳
  function resetVisitedTabs() { visitedTabs = new Set(); }

  // 当前正在展示的任务点标签（带 active/cur 高亮，或 aria-selected）
  function isActiveTab(el) {
    let cur = el;
    for (let i = 0; i < 2 && cur && cur.nodeType === 1; i++) {
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (/active|current|(^|\s)cur(\s|$)|selected|checked/i.test(cls)) return true;
      if (cur.getAttribute && (cur.getAttribute('aria-selected') === 'true' || cur.getAttribute('aria-current') === 'true')) return true;
      cur = cur.parentElement;
    }
    // 'on' 太容易误判，只看元素自己
    return /(^|\s)on(\s|$)/.test(typeof el.className === 'string' ? el.className : '');
  }

  function collectTaskTabs(docs) {
    const out = [];
    const seen = new Set();
    const topDoc = window.top.document;

    const accept = (el, doc) => {
      if (!el || el.nodeType !== 1 || seen.has(el)) return;
      if (isOwnUI(el)) return;
      if (!isVisible(el) || isDisabled(el)) return;
      if (isInCatalogStrict(el) || isInLeftRail(el, doc)) return;
      if (isActiveTab(el)) return;                     // 正在看的任务点，不再点
      if (badNextEls.has(el)) return;
      const t = cleanText(el.textContent || el.value || '');
      if (!t || t.length > 14) return;
      if (!CONFIG.TASK_TAB_TEXT.some(k => t.includes(k))) return;
      if (CONFIG.NEXT_BTN_TEXT.some(k => t.includes(k))) return;   // 别把“下一节”当标签
      if (CONFIG.EXCLUDE_TEXT.some(k => t.includes(k))) return;
      if (el.children && el.children.length > 2) return;           // 包一堆子元素的是大容器
      seen.add(el);
      const ki = CONFIG.TASK_TAB_TEXT.findIndex(k => t.includes(k));
      let prio = 20 + Math.max(0, ki) + (doc === topDoc ? 0 : 25);
      if (/^\d/.test(t)) prio -= 6;                                // “2 章节测验”这种带序号的更像任务点
      if (/^(A|BUTTON)$/.test(el.tagName) || el.getAttribute('role') === 'button') prio -= 4;
      if (!el.children || el.children.length === 0) prio -= 6;      // 叶子才是真标签，整条标签栏是容器
      out.push({ el, doc, t, why: '任务点标签', prio, key: t.replace(/\s+/g, '') });
    };

    // 0) 手动拾取（放宽文本要求，但“当前打开的任务点”仍然跳过，否则会死循环）
    if (CONFIG.TASK_TAB_PICKED) {
      docs.forEach(doc => {
        let el = null;
        try { el = doc.querySelector(CONFIG.TASK_TAB_PICKED); } catch (e) {}
        if (el && !isOwnUI(el) && isVisible(el) && !isDisabled(el) && !isActiveTab(el) && !seen.has(el)) {
          seen.add(el);
          out.push({
            el, doc, t: cleanText(el.textContent) || '任务点', why: '手动拾取的章节测验标签',
            prio: -100, key: 'picked:' + CONFIG.TASK_TAB_PICKED
          });
        }
      });
    }

    // 1) 常规扫描
    docs.forEach(doc => {
      let els = [];
      try { els = Array.from(doc.querySelectorAll(CLICKABLE_SEL + ',' + CONFIG.TASK_TAB_SEL)); } catch (e) {}
      els.forEach(el => {
        const t = cleanText(el.textContent || el.value || '');
        if (!t || t.length > 14) return;
        if (!CONFIG.TASK_TAB_TEXT.some(k => t.includes(k))) return;
        const cls = typeof el.className === 'string' ? el.className : '';
        const pcls = (el.parentElement && typeof el.parentElement.className === 'string') ? el.parentElement.className : '';
        const clickable = el.hasAttribute('onclick') || el.getAttribute('role') === 'button'
          || /^(A|BUTTON)$/.test(el.tagName)
          || /tab|item|point|job|btn|nav|node|chip/i.test(cls)
          || /tab|point|job|btn|nav/i.test(pcls);
        if (!clickable) return;
        accept(el, doc);
      });
    });

    out.sort((a, b) => (a.prio - b.prio) || (a.t.length - b.t.length));
    return out.slice(0, 6);
  }

  // 等“任务点是否真的切换了”（比整页指纹更贴合本场景）
  async function waitForTaskSwitch(oldSig, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(500);
      if (taskSignature(getAllDocs()) !== oldSig) { await sleep(1200); return true; }
    }
    return false;
  }

  // 逐个尝试候选：点完没跳转就把这个元素拉黑、换下一个，
  // 而不是像旧版那样反复点同一个元素（这是“卡住/提前收工”的根因）。
  async function clickNextWithRetry(cands, isVideo) {
    for (const c of cands) {
      if (!running) return false;
      const before = taskSignature(getAllDocs());
      highlight(c.el);
      log(`→ 点击「${c.t}」${elDesc(c.el)} @ ${docDesc(c.doc)}｜${c.why}`);
      try { c.el.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(400);
      nativeClick(c.el);
      const changed = await waitForTaskSwitch(before, CONFIG.TASK_SWITCH_TIMEOUT);
      if (changed) {
        clearHighlight();
        log(isVideo ? '视频页已推进 → 该视频对应的答题区' : '已推进到下一个任务点', 'ok');
        resetBadNext();
        await sleep(600);
        return true;
      }
      badNextEls.add(c.el);
      log(`点击「${c.t}」后任务点内容没变化，拉黑该元素并换下一个候选`, 'warn');
      await handlePopups(getAllDocs(), { wait: false });
      await sleep(400);
    }
    clearHighlight();
    // 所有候选都失败时，再兜底处理一次可能挡路的弹窗（例如“任务点未完成”提示）
    await handlePopups(getAllDocs(), { wait: true });
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

  // 多选题补选：只补点、不再请求模型。返回 true 表示本轮处理过，主循环应重新扫描。
  async function retryPendingMulti(questions) {
    const pend = [];
    for (const q of questions) {
      const p = pendingMulti(q);
      if (p) pend.push({ q, plan: p.plan, missing: p.missing });
    }
    if (!pend.length) return false;

    for (const item of pend) {
      if (!running) return false;
      const q = item.q, plan = item.plan, missing = item.missing;
      log(`第 ${q.index} 题（多选）还差 ${missing.join('、')} 没选上，第 ${plan.tries + 1} 次补选…`, 'warn');
      try { q.box.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(200);
      const targets = q.options.filter(o => plan.letters.indexOf(o.letter) > -1 && missing.indexOf(o.letter) > -1);
      for (const opt of targets) await clickOption(opt, true, { force: true });
      plan.tries++;
      const still = plan.letters.filter(L => selectedLetters(q).indexOf(L) < 0);
      if (still.length) log(`第 ${q.index} 题补选后仍差 ${still.join('、')}（已试 ${plan.tries} 次）`, 'warn');
      else log(`第 ${q.index} 题多选题已选全：${plan.letters.join('、')}`, 'ok');
    }
    await sleep(600);
    return true;
  }

  async function mainLoop() {
    let noNextRetries = 0;   // 连续“找不到可用下一节”的轮数
    let guard = 0;           // 安全阀，防止死循环
    while (running) {
      await sleep(CONFIG.STEP_DELAY);
      if (!running) break;
      if (++guard > 3000) { log('安全阀触发：循环次数异常，已停止', 'warn'); break; }
      setStatus(`扫描页面（已推进 ${sections} 步）…`);
      const docs = getAllDocs();
      await scrollAll(docs);
      await handlePopups(docs, { wait: false });

      const questions = collectQuestions(docs);

      // 多选题补选：模型给的答案里还有没真正选上的选项，直接补点，不再花一次 API 请求
      if (await retryPendingMulti(questions)) continue;

      const unanswered = questions.filter(q => !q.answered);

      if (unanswered.length) {
        noNextRetries = 0;
        log(`发现 ${questions.length} 道题，其中 ${unanswered.length} 道未作答`);
        const ok = await answerQuestions(unanswered);
        if (!ok && !running) break;
        await sleep(1000);
        await autoSubmit(getAllDocs());
        resetBadNext();
        await sleep(1500);
        continue;
      }

      if (questions.length) {
        noNextRetries = 0;
        log(`本节 ${questions.length} 道题均已作答，检查提交…`);
        await autoSubmit(docs);
        resetBadNext();
        await sleep(1500);
      }

      // 本页没有未答题目：视频任务点 / 文档 / 过渡页
      const isVideo = isVideoPageDetect(docs);

      // ① 同一小节里还有没做的任务点（典型：视频看完 →「2 章节测验」）。
      //    必须优先切任务点：底部那个“下一节”会直接跳到下一个小节，把本章测验整段跳过。
      if (!questions.length) {
        const tabs = collectTaskTabs(docs).filter(t => !visitedTabs.has(t.key));
        if (tabs.length) {
          noNextRetries = 0;
          log(`本小节还有未完成的任务点：${tabs.map(t => '「' + t.t + '」').join('、')}，先切过去（不跳小节）`, 'ok');
          tabs.slice(0, 3).forEach((c, i) => log(`  任务点${i + 1}：${elDesc(c.el)}「${c.t}」@ ${docDesc(c.doc)}`));
          const switched = await clickNextWithRetry(tabs, false);
          if (switched) {
            tabs.forEach(t => visitedTabs.add(t.key));
            continue;
          }
          log('任务点标签点了都没反应，改为找“下一节”', 'warn');
        }
      }

      // ② 本小节的任务点都做完了 → 点“下一节”进入下一个小节
      const { cands, scopeWhy } = collectNextCandidates(docs, { video: isVideo });
      if (cands.length) {
        noNextRetries = 0;
        if (isVideo) {
          log(`本页为视频任务点，本小节已无其它未完成任务点，点“下一节”进入下一个小节｜${scopeWhy}`, 'ok');
        } else {
          log(`本页无题目，准备点“下一节”推进｜${scopeWhy}`);
        }
        cands.slice(0, 3).forEach((c, i) => log(`  候选${i + 1}：${elDesc(c.el)}「${c.t}」@ ${docDesc(c.doc)}｜${c.why}`));
        const advanced = await clickNextWithRetry(cands, isVideo);
        if (advanced) {
          sections++;
          resetVisitedTabs();          // 换小节了，任务点标签重新计数
          if (sections > CONFIG.MAX_SECTIONS) { log('达到最大节数限制，停止', 'warn'); break; }
        } else {
          noNextRetries++;
          if (noNextRetries >= CONFIG.NO_NEXT_RETRIES) {
            log('本页所有“下一节”候选点击后任务点都没变化，判定本课程已结束，停在当前页', 'ok');
            break;
          }
          log(`候选按钮全部无效（${noNextRetries}/${CONFIG.NO_NEXT_RETRIES}），滚动后重试…`, 'warn');
          await scrollAll(getAllDocs());
          await sleep(800);
        }
      } else {
        noNextRetries++;
        if (noNextRetries >= CONFIG.NO_NEXT_RETRIES) {
          log('本页无题目，也找不到下一节按钮，判定本课程已结束，停在当前页', 'ok');
          break;
        }
        log(`未识别到题目，也未找到下一节按钮（${noNextRetries}/${CONFIG.NO_NEXT_RETRIES}）｜${scopeWhy}，滚动后重试…`, 'warn');
        await scrollAll(docs);
        await sleep(500);
      }
    }
    finish();
  }

  /* ------------------------ 自检 / 手动校准 ------------------------ */

  // 生成一个尽量稳定的 CSS 路径（拾取时用）
  function cssPath(el) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
      let sel = cur.tagName.toLowerCase();
      const cls = (typeof cur.className === 'string' ? cur.className : '')
        .trim().split(/\s+/).filter(c => c && /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
      const p = cur.parentElement;
      if (p) {
        const sibs = Array.from(p.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  // 🧭 扫描自检：把脚本的判定依据全部打出来，在真实页面 2 秒验收
  function scanReport() {
    const docs = getAllDocs();
    const { modules } = splitDocs(docs);
    const isVideo = isVideoPageDetect(docs);
    const L = [];
    L.push(`文档数 ${docs.length}（顶层 1，iframe ${docs.length - 1}，任务点 iframe ${modules.length}）`);
    docs.forEach(d => {
      let q = 0, v = 0;
      try {
        q = d.querySelectorAll(CONFIG.QUESTION_BLOCK_SEL).length;
        v = d.querySelectorAll('video,.vjs-tech,.vjs-player').length;
      } catch (e) {}
      L.push(`  · ${docDesc(d)}｜题目块 ${q}｜播放器 ${v}`);
    });
    L.push(`是否判定为视频页：${isVideo ? '是' : '否'}`);
    L.push(`手动拾取：下一节=${CONFIG.NEXT_BTN_PICKED || '自动'}｜章节测验=${CONFIG.TASK_TAB_PICKED || '自动'}`);
    const tabs = collectTaskTabs(docs);
    L.push(`未完成任务点标签：${tabs.length ? tabs.map(t => '「' + t.t + '」').join('、') : '（无）'}`);
    const { cands, scopeWhy } = collectNextCandidates(docs, { video: isVideo });
    L.push(`搜索范围：${scopeWhy}`);
    if (!cands.length) {
      L.push('下一节候选：无 → 脚本会判定“本课程已结束”');
    } else {
      L.push(`下一节候选（按优先级）：共 ${cands.length} 个，脚本先点第 1 个`);
      cands.forEach((c, i) => L.push(`  #${i + 1} prio=${c.prio}「${c.t}」${elDesc(c.el)} @ ${docDesc(c.doc)}｜${c.why}`));
      if (cands.length > 1) L.push('  （第 1 个点了任务点没变化会自动换下一个，无需手动干预）');
    }
    const report = L.join('\n');
    console.log('[DS答题-扫描自检]\n' + report);
    report.split('\n').forEach(l => log('  ' + l));
    log(copyText(report) ? '报告已复制到剪贴板，可直接粘贴给我' : '复制失败，请按 F12 在控制台查看', 'ok');
  }

  // 单道题的结构报告：真实 DOM + 每个选项的判定依据。
  // 多数「多选选不上」的问题靠这段就能定位，所以选错时会自动导出并复制到剪贴板。
  function questionReport(q) {
    const P = [];
    P.push(`===== 第 ${q.index} 题｜type="${q.type}"｜isMulti=${!!q.isMulti}｜选项数=${q.options.length} =====`);
    P.push('题干：' + (q.title || '').slice(0, 150));
    const hid = (q.box && q.box.querySelector) ? q.box.querySelector('input[type=hidden][name^="answer"]') : null;
    P.push('本题隐藏答案框：' + (hid ? `name=${hid.name} value="${hid.value}"` : '无'));
    q.options.forEach(o => {
      const li = o.li || o.el;
      const sel = o.checked || optionSelected(o);
      const aria = (li && li.getAttribute) ? li.getAttribute('aria-checked') : null;
      const ariaP = (li && li.getAttribute) ? li.getAttribute('aria-pressed') : null;
      const cls = (li && typeof li.className === 'string') ? li.className : '';
      const dot = (li && li.querySelector) ? li.querySelector('a.before,i.before,span.before,.num_option') : null;
      P.push(`  ${o.letter}｜判定=${sel}｜input=${o.input ? o.input.type + '(checked=' + o.input.checked + ')' : '无'}`
        + `｜li.class="${cls}"｜aria-checked=${aria}｜aria-pressed=${ariaP}`
        + (dot ? `｜标记 <${dot.tagName} class="${dot.className}">` : ''));
    });
    let html = '';
    try { html = q.box.outerHTML || ''; } catch (e) {}
    P.push('--- 题块 HTML（截断 4000 字）---');
    P.push(html.slice(0, 4000));
    return P.join('\n');
  }

  // 🔬 导出题目 HTML：多选还是搞不定时，把真实结构复制出来发给助手
  function dumpQuestionDOM() {
    const docs = getAllDocs();
    const qs = collectQuestions(docs);
    const P = [];
    P.push(`时间 ${new Date().toLocaleString()}｜文档数 ${docs.length}｜题目数 ${qs.length}`);
    if (!qs.length) P.push('（当前页面没有扫到题目）');
    qs.slice(0, 3).forEach(q => P.push('\n' + questionReport(q)));
    const report = P.join('\n');
    console.log('[DS答题-题目HTML]\n' + report);
    log(`已导出 ${Math.min(qs.length, 3)} 道题的 HTML（${report.length} 字）`);
    log(copyText(report) ? '已复制到剪贴板，直接粘贴给助手即可' : '复制失败，请按 F12 在控制台找 [DS答题-题目HTML]', 'ok');
  }

  // 🎯 手动拾取（支持 iframe 内）：mode = 'next' 绑「下一节」，mode = 'tab' 绑「章节测验」标签
  let picking = false;
  let pickMode = 'next';
  let pickDocs = [];
  const pickMove = e => {
    const el = e.target;
    if (!el || !el.closest || el.closest('#glm-panel')) return;
    highlight(el);
  };
  const pickClick = e => {
    const el = e.target;
    if (!el || !el.closest || el.closest('#glm-panel')) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    const path = cssPath(el);
    if (!path) { log('没能生成选择器，换个更靠里的元素再点一次', 'warn'); return; }
    if (pickMode === 'tab') {
      CONFIG.TASK_TAB_PICKED = path;
      saveSettings({ tabPick: path });
      log(`已绑定「章节测验」标签：${path}（优先级最高，改版后重新拾取即可）`, 'ok');
    } else {
      CONFIG.NEXT_BTN_PICKED = path;
      saveSettings({ nextPick: path });
      log(`已绑定「下一节」按钮：${path}（优先级最高，改版后重新拾取即可）`, 'ok');
    }
    stopPicker();
    refreshPickInfo();
  };
  function stopPicker() {
    picking = false;
    pickDocs.forEach(d => {
      try {
        d.removeEventListener('mousemove', pickMove, true);
        d.removeEventListener('click', pickClick, true);
      } catch (e) {}
    });
    pickDocs = [];
    clearHighlight();
    if (ui.pickBtn) ui.pickBtn.textContent = '🎯 拾取「下一节」';
    if (ui.pickTabBtn) ui.pickTabBtn.textContent = '🎯 拾取「章节测验」';
  }
  function togglePicker(mode) {
    if (picking) { stopPicker(); log('已退出拾取模式', 'warn'); return; }
    picking = true;
    pickMode = mode === 'tab' ? 'tab' : 'next';
    pickDocs = getAllDocs();
    pickDocs.forEach(d => {
      try {
        d.addEventListener('mousemove', pickMove, true);
        d.addEventListener('click', pickClick, true);
      } catch (e) {}
    });
    if (ui.pickBtn) ui.pickBtn.textContent = pickMode === 'tab' ? '🎯 拾取「下一节」' : '✖ 退出拾取';
    if (ui.pickTabBtn) ui.pickTabBtn.textContent = pickMode === 'tab' ? '✖ 退出拾取' : '🎯 拾取「章节测验」';
    log(pickMode === 'tab'
      ? '拾取模式：把鼠标移到那一排任务点里的「章节测验」上，点一下即可绑定（不会真的跳转）'
      : '拾取模式：把鼠标移到视频下面那个「下一节」按钮上，点一下即可绑定（不会真的跳转）', 'warn');
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
    resetVisitedTabs();
    multiPlan.clear();
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

  // 调试/自检钩子（无头回归测试和你在控制台手动验证都用它）
  try {
    const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    w.__XXT_DEBUG__ = {
      CONFIG, getAllDocs, splitDocs, collectNextCandidates, findNext, isVideoPageDetect,
      taskSignature, scanReport, cssPath, elDesc, docDesc, isInCatalog, isInLeftRail, resetBadNext,
      clickNextWithRetry, setRunning: v => { running = !!v; },
      collectTaskTabs, extractLetters, resetVisitedTabs, visitedTabs: () => visitedTabs,
      collectQuestions, clickOption, optionSelected, MULTI_RE,
      selectedLetters, pendingMulti, retryPendingMulti, multiPlan, qKeyOf,
      normQuestion, bankKey, bankAnswerToArray, mapAnswersToOptions, stripOptionLetter,
      loadLocalBank, saveLocalBank, localBankSize, rememberQuestion, bankLookup, typeToInt,
      bankQueryText, queryFreeBank, queryFreeBank2, isBankGarbage, BANK_AD_RE, refreshQuestion, recentClicks, questionReport,
      getPageFn, hiddenAnswerLetters, nativeClick
    };
  } catch (e) {}

  // 启动面板（等 body）
  if (document.body) buildUI();
  else window.addEventListener('DOMContentLoaded', buildUI);
})();
