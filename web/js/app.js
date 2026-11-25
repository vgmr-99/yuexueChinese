/**
 * app.js — 越汉通 HSK 学习App（v2）
 *
 * v2 相对 v1 的变化：
 *   1. 词库 152 → HSK1-3 共 2245 词，按等级筛选
 *   2. 新增 SRS 间隔重复（srs.js，SM-2 算法）——解决「学了忘」
 *   3. 三语界面（i18n.js）：中文 / 越南语 / 英语
 *   4. 发音优先用**预生成音频**（Edge TTS，最准），无音频时回退系统 TTS
 *   5. 保留 v1 的汉越音与笔顺能力
 */
(function () {
  'use strict';

  var DATA = window.APP_DATA || { levels: {}, courses: [], charIndex: {} };
  var LEVELS = DATA.levels || {};
  var COURSES = DATA.courses || [];
  var CHAR_INDEX = DATA.charIndex || {};   // 字 -> {stroke_count, radical}

  /** 取单字的笔顺信息 */
  function charInfo(ch) {
    return CHAR_INDEX[ch] || null;
  }
  function T(k) { return window.I18N.t(k); }

  /**
   * 单色 SVG 图标（对应 index.html 里的 <symbol> 精灵）。
   * 替代散落在模板字符串里的 emoji：跨设备字形一致、跟随 currentColor、
   * 深色模式无需额外处理。ico('volume', 'icon-class') -> <svg ...>
   */
  function ico(name, cls, title) {
    return '<svg class="' + (cls || 'ico') + '" aria-hidden="true"' +
      (title ? ' role="img" aria-label="' + esc(title) + '"' : '') +
      '><use href="#i-' + name + '"/></svg>';
  }

  /**
   * 结果页的轻量进度环。
   *
   * 之前结果页只有「奖杯图标 + 纯数字」，数字再大也看不出完成度。
   * 这里换成一道 SVG 环：环的弧长就是百分比，中间放数字。
   * 刻意保持克制 —— 单色描边、无阴影、无弹跳动画，
   * 只在出现时走一圈 0.6s 的描边动画（且尊重 prefers-reduced-motion）。
   */
  function resultRing(pct) {
    var p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    var r = 42;
    var c = 2 * Math.PI * r;
    var off = c * (1 - p / 100);
    var tier = p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low';
    return '<div class="result-ring-wrap ' + tier + '">' +
      '<svg class="result-ring" viewBox="0 0 100 100" aria-hidden="true">' +
        '<circle class="ring-track" cx="50" cy="50" r="' + r + '"></circle>' +
        '<circle class="ring-fill" cx="50" cy="50" r="' + r + '" ' +
          'stroke-dasharray="' + c.toFixed(2) + '" ' +
          'stroke-dashoffset="' + off.toFixed(2) + '"></circle>' +
      '</svg>' +
      '<div class="result-ring-num">' + p + '<span>%</span></div>' +
    '</div>';
  }

  /** 三星评价：用 SVG 星形，无表情、跨端一致 */
  function starRow(n) {
    var out = '';
    for (var i = 1; i <= 3; i++) {
      out += ico('star', 'star' + (i <= n ? ' on' : ''));
    }
    return out;
  }

  var currentLevel = '1';
  var VOCAB = [];

  function allWords() {
    var out = [];
    Object.keys(LEVELS).forEach(function (lv) { out = out.concat(LEVELS[lv]); });
    return out;
  }

  /**
   * 全局词索引：跨等级搜索/点击都要能查到完整词条。
   * 旧代码点击时只 VOCAB.filter（当前等级），跨级搜索点词静默失败——
   * 这就是「很多单词点了不弹卡片」的根因之一。
   */
  var WORD_INDEX = null;
  function wordIndex() {
    if (!WORD_INDEX) {
      WORD_INDEX = {};
      allWords().forEach(function (v) { WORD_INDEX[v.hanzi] = v; });
    }
    return WORD_INDEX;
  }

  /** 取一个词里所有可写笔顺的汉字 */
  function drawableChars(item) {
    var out = [];
    (item && item.chars || []).forEach(function (ch) {
      var info = charInfo(ch);
      if (info && info.stroke_count) {
        out.push({ char: ch, stroke_count: info.stroke_count, radical: info.radical });
      }
    });
    return out;
  }

  // 键名由 store.js 统一登记
  var STORE_KEY = window.Store ? window.Store.KEYS.progress : 'vietchinese.progress.v1';
  var progress = load();
  function load() {
    if (window.Store) {
      var p = window.Store.getJSON(STORE_KEY, null);
      return (p && typeof p === 'object' && p.learned) ? p : { learned: {} };
    }
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { learned: {} }; }
    catch (e) { return { learned: {} }; }
  }
  function save() {
    if (window.Store) { window.Store.setJSON(STORE_KEY, progress); return; }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) {}
  }

  // ------------------------------------------------------------ 音频
  var audioEl = null;

  /** 音频缺失只提示一次，避免连续点击反复弹 */
  var audioMissingNotified = false;

  /**
   * 显式报告「发音音频不可用」。
   *
   * 背景：Android WebView 的 speechSynthesis 在没有系统 TTS 引擎的机型上
   * 是个**不发声的空壳** —— API 存在、play() 不 reject、就是没声音。
   * 于是「音频文件不存在」这个真实原因被完全吞掉，
   * 用户只看到「点了没反应」，分不清是 App 坏了还是自己操作错了。
   * 这里把失败原因说出来。
   */
  function notifyAudioMissing() {
    if (audioMissingNotified) return;
    audioMissingNotified = true;
    try { toast(T('audioMissing')); } catch (e) { /* 忽略 */ }
  }

  /**
   * 朗读中文。优先用预生成音频（Edge TTS 合成，音质最好），
   * 无音频或播放失败时回退系统 TTS，并显式提示失败。
   */
  function speak(text, opts) {
    opts = opts || {};
    if (!text) return;
    // 音频 key：优先用显式传入的，否则按词库命名规则推导。
    // **不能只依赖 has_audio 标志**——数据构建时若漏传音频清单，
    // 全部词条会退化成 speechSynthesis，而 Android WebView 的
    // speechSynthesis 基本是个不发声的空壳（API 存在但无输出），
    // 表现为「点了完全没声音且没有任何报错」。
    // 这里改成无条件尝试本地 mp3，文件不存在时再由 onerror 回退。
    //
    // opts.src：直接指定音频路径（句子/笔顺等不在词库里的文本用它）。
    var key = opts.audioKey || ('w_' + text);
    var src = opts.src || ('audio/words/' + key + '.mp3');
    try {
      if (!audioEl) audioEl = new Audio();
      audioEl.src = src;
      audioEl.onerror = function () {
        audioEl.onerror = null;
        notifyAudioMissing();
        ttsFallback(text);
      };
      var p = audioEl.play();
      if (p && p.catch) p.catch(function () {
        notifyAudioMissing();
        ttsFallback(text);
      });
      return;
    } catch (e) {
      notifyAudioMissing();
      ttsFallback(text);
    }
  }

  function ttsFallback(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.85;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  /** 按当前界面语言取释义 */
  /** 取词条的「释义」（词卡最下面那行）。
   *  注意：不能返回拼音——拼音已单独一行显示，返回拼音会造成重复。
   *  中文界面下同样优先展示越南语释义（目标用户是越南人，且暂无中文释义词库）。
   */
  function meaningOf(item) {
    var lang = window.I18N.lang;
    if (lang === 'en') return item.en || item.vi || '';
    return item.vi || item.en || '';
  }

  // ------------------------------------------------------------ 导航
  var gotoMeasureTimer = 0;
  /**
   * 定时器句柄集中登记。
   *
   * 之前这些延时回调都是匿名 setTimeout，没人能取消：
   *   - 答完题 1.1 秒后自动推进到下一题
   *   - 进入听写题 260ms 后自动播一次发音
   * 学员在等待期间切走分区，回调照样执行，
   * 往**已经隐藏**的分区里渲染内容 —— 既浪费，又会跟新分区抢状态
   * （表现：切到别的页面后，测验题自己跳了）。
   * 现在统一登记句柄，切分区时统一取消。
   */
  var quizAdvanceTimer = 0;
  var dictPlayTimer = 0;

  function clearPendingTimers() {
    if (quizAdvanceTimer) { clearTimeout(quizAdvanceTimer); quizAdvanceTimer = 0; }
    if (dictPlayTimer) { clearTimeout(dictPlayTimer); dictPlayTimer = 0; }
    if (dictNextTimer) { clearTimeout(dictNextTimer); dictNextTimer = 0; }
  }


  /**
   * 标记「运行在 APK 内」。
   *
   * APK 是边到边渲染的，内容会伸到状态栏/刘海下面，需要用
   * env(safe-area-inset-*) 做避让；而在手机浏览器里，浏览器自己
   * 已经留好了位置，再加一层就会让页头整体下移、LOGO 到不了顶。
   * 这里靠原生接口是否存在来区分两种运行环境。
   */
  function markRuntime() {
    // 注意：本文件运行在浏览器里，没有 global 别名，必须用 window
    var inApp = !!(window.AthaoNativeRecorder || window.AthaoHttp ||
                   String(location.protocol).indexOf('file') === 0);
    if (inApp) document.documentElement.classList.add('in-app');
  }

  function goto(name) {
    closeMorePanel();
    // 离开测验分区时取消「自动进入下一题」的定时器，
    // 否则切走后它仍会把听写推进到下一题
    clearPendingTimers();
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.section === name);
    });
    // 目标分区在「更多」抽屉里时（复习/笔顺/拼音/听写/设置），
    // 底栏没有对应按钮，此时应高亮「更多」，
    // 否则用户点了首页入口卡跳过去，底栏却没有任何高亮，不知道自己在哪一层。
    var MAIN_SECTIONS = ['home', 'learn', 'sentence', 'quiz'];
    var moreBtn = document.getElementById('nav-more-btn');
    if (moreBtn) {
      moreBtn.classList.toggle('active', MAIN_SECTIONS.indexOf(name) === -1);
    }
    document.querySelectorAll('.section').forEach(function (s) {
      s.classList.toggle('active', s.id === name);
    });
    if (name === 'settings' && window.Settings) { renderStats(); renderWrongList(); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // 筛选栏高度必须**延后**再量。
    // 这里原本紧接着调 syncFilterBarHeight()，而它内部要读 offsetHeight，
    // 等于在「面板下滑 300ms」与「平滑滚动」两个动画进行中强制同步布局，
    // 浏览器必须打断当前帧重排 —— 表现就是点功能页时「顿一下」。
    // 延到动画跑完再测，两边都不受影响。
    clearTimeout(gotoMeasureTimer);
    gotoMeasureTimer = setTimeout(syncFilterBarHeight, 340);
  }

  /* 「更多」抽屉：底部导航 5 主项之外的功能都收在这里 */
  function setMore(open) {
    var panel = document.getElementById('nav-more');
    var scrim = document.getElementById('nav-more-scrim');
    var btn = document.getElementById('nav-more-btn');
    if (!panel || !scrim || !btn) return;
    panel.classList.toggle('open', open);
    scrim.classList.toggle('open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');

    // 抽屉展开时只让「更多」高亮。
    // 否则当前分区的按钮仍是 active，底部会出现两个红色按钮并列，
    // 分不清当前在哪一层。收起时再把高亮还给当前分区。
    var act = document.querySelector('.section.active');
    document.querySelectorAll('.nav-btn[data-section]').forEach(function (b) {
      b.classList.toggle('active', !open && !!act && b.dataset.section === act.id);
    });
  }
  function closeMorePanel() { setMore(false); }

  function initNav() {
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      if (!b.dataset.section) return;      // 「更多」按钮无 section，单独处理
      b.addEventListener('click', function () { goto(b.dataset.section); });
    });
    document.querySelectorAll('[data-more]').forEach(function (b) {
      b.addEventListener('click', function () {
        var panel = document.getElementById('nav-more');
        setMore(!panel.classList.contains('open'));
      });
    });
    document.querySelectorAll('[data-close-more]').forEach(function (b) {
      b.addEventListener('click', closeMorePanel);
    });
    // 面板里的功能项：点击后切区并自动收起
    document.querySelectorAll('.nav-more-item').forEach(function (b) {
      b.addEventListener('click', function () { goto(b.dataset.section); });
    });
    document.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { goto(b.dataset.goto); });
    });
    document.querySelectorAll('.lang-btn').forEach(function (b) {
      b.addEventListener('click', function () { window.I18N.setLang(b.dataset.lang); });
    });
  }

  /**
   * 切换语言后需要重新渲染的**全部**区域。
   *
   * 之前只重渲染了 7 处，设置页统计、错题本、笔顺记录、每日目标、
   * 测验题、听写界面、评测结果、课程详情等都没重画，
   * 于是「有些部分没跟着切换」。
   * 现在把所有 render* 都补齐；个别函数不存在时用 typeof 保护。
   */
  // 记住弹窗的打开参数，切换语言时重新打开以刷新文案
  var strokeOpenArgs = null;

  /** 保护性调用：某个区块渲染失败不影响其它区块 */
  function safe(fn) {
    try { fn(); } catch (e) { console.warn('[i18n] 重渲染失败', e); }
  }

  function rerenderAll() {
    var q = function (sel) { return document.querySelector(sel); };

    safe(function () { syncFilterBarHeight(); });
    safe(function () { renderLevelTabs(); });
    safe(function () { renderSentLevelTabs(); });
    safe(function () { renderVocab(q('#search-input') ? q('#search-input').value : ''); });
    safe(function () { renderHanzi(q('#hanzi-search') ? q('#hanzi-search').value : ''); });
    safe(function () { renderSrsStats(); });
    safe(function () { renderSrsCard(); });
    safe(function () {
      var tab = q('.pinyin-tab.active');
      renderPinyin(tab ? tab.dataset.ptab : 'syllable');
    });
    safe(function () { renderSentCourses(); });
    // 设置页
    safe(function () { renderStats(); });
    safe(function () { renderWrongList(); });
    safe(function () { renderStrokeRecords(); });
    safe(function () { renderGoalWidget(); });
    safe(function () { renderResetButtons(); });
    // 测验 / 听写
    safe(function () { renderQuizQuestion(); });
    safe(function () { renderDictation(); });
  }

  window.__onLangChanged = function () {
    rerenderAll();
    // 弹窗若正处于打开状态，其中的文案也要换 ——
    // 弹窗内容是动态生成的（没有 data-i18n），只能重新打开一次。
    //
    // 判据必须是 classList.contains('open')，不能用 !el.hidden：
    // modal 的显隐由 .open 类驱动（CSS: .modal{display:none} / .modal.open{display:flex}），
    // 而 hidden 属性从未被写过，!el.hidden 恒为 true —— 于是「关闭笔顺后再切语言」
    // 会把已经关掉的笔顺弹窗重新弹出来。
    safe(function () {
      if (isModalOpen('vocab-modal') && vocabCardItem) openVocabCard(vocabCardItem);
    });
    safe(function () {
      if (isModalOpen('stroke-modal') && strokeOpenArgs) openStroke(strokeOpenArgs.ch, strokeOpenArgs.item);
    });
    updateLangToggle();
  };

  /**
   * 弹窗当前是否处于打开状态。
   * 唯一权威判据是 .open 类；hidden 属性在 modal 上从未被设置，不可用。
   */
  function isModalOpen(id) {
    var m = document.getElementById(id);
    return !!(m && m.classList.contains('open'));
  }

  /** 语言切换按钮：显示「切到另一种语言」 */
  function updateLangToggle() {
    var btn = document.getElementById('lang-toggle');
    var txt = document.getElementById('lang-toggle-txt');
    if (!btn || !txt) return;
    var cur = window.I18N ? window.I18N.lang : 'vi';
    var other = cur === 'zh' ? 'vi' : 'zh';
    txt.textContent = other === 'zh' ? '中文' : 'Tiếng Việt';
    btn.setAttribute('title', other === 'zh' ? '切换到中文' : 'Chuyển sang tiếng Việt');
    btn.setAttribute('aria-label', other === 'zh' ? '切换到中文' : 'Chuyển sang tiếng Việt');
  }

  /** 绑定语言切换按钮（只有中/越两种，点一下就切） */
  function initLangToggle() {
    var btn = document.getElementById('lang-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cur = window.I18N ? window.I18N.lang : 'vi';
      window.I18N.setLang(cur === 'zh' ? 'vi' : 'zh');
    });
    updateLangToggle();
  }

  // ------------------------------------------------------------ 等级
  function renderLevelTabs() {
    var box = document.getElementById('level-tabs');
    if (!box) return;
    box.innerHTML = Object.keys(LEVELS).sort().map(function (lv) {
      return '<button class="level-tab' + (lv === currentLevel ? ' active' : '') +
        '" data-level="' + lv + '">' +
        '<span class="lvl-name">HSK ' + lv + '</span>' +
        '<span class="lvl-count">' + LEVELS[lv].length + '</span>' +
        '</button>';
    }).join('');
    box.querySelectorAll('.level-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        currentLevel = b.dataset.level;
        VOCAB = LEVELS[currentLevel] || [];
        renderLevelTabs();
        renderVocab('');
        var vc = document.getElementById('vocab-count');
        if (vc) vc.textContent = VOCAB.length;
      });
    });
  }

  // ------------------------------------------------------------ 词卡
  // HSK6 单级就有 1000+ 词，一次性渲染会卡顿，因此分页追加
  var PAGE = 300;
  var shown = PAGE;

  function renderVocab(filter, reset) {
    var grid = document.getElementById('vocab-grid');
    if (reset !== false) shown = PAGE;
    // 有搜索词时跨全部等级查（查词不该被当前等级限制）；无词时只看当前等级
    var q = (filter || '').trim();
    var rows = q ? searchAll(q) : VOCAB;

    if (!rows.length) {
      grid.innerHTML = '<p class="empty">' + T('notFound') + '</p>';
      return;
    }
    // 结果跨等级时，提示当前处于跨级搜索
    var hint = q ? '<div class="search-hint">' + T('crossLevel') +
      ' (' + rows.length + ')</div>' : '';

    var slice = rows.slice(0, shown);
    var html = slice.map(function (v) {
      var learned = !!progress.learned[v.hanzi];
      var card = window.SRS.getCard(v.hanzi);
      var mean = meaningOf(v);
      return '' +
        '<div class="vocab-card' + (learned ? ' learned' : '') + '" data-word="' + esc(v.hanzi) + '">' +
          '<div class="vocab-hanzi">' + esc(v.hanzi) + '</div>' +
          '<div class="vocab-pinyin">' + esc(v.pinyin) + '</div>' +
          (v.han_viet ? '<div class="vocab-hanviet" title="Hán-Việt">' + ico('globe','vmeta-ico') + esc(v.han_viet) + '</div>' : '') +
          (mean ? '<div class="vocab-mean">' + esc(mean) + '</div>' : '') +
          '<div class="vocab-foot">' +
            (v.stroke_count ? '<span class="vmeta">' + ico('pen','vmeta-ico') + v.stroke_count + '</span>' : '') +
            (v.has_audio ? '<span class="vmeta">' + ico('volume','vmeta-ico') + '</span>' : '') +
            (card ? '<span class="vmeta srs" title="SRS">' + ico('chart','vmeta-ico') + card.interval + 'd</span>' : '') +
          '</div>' +
          '<button class="mark-btn" data-mark="' + esc(v.hanzi) + '">' +
            (learned ? ico('check','inline-ico') + T('learned') : T('mark')) + '</button>' +
        '</div>';
    }).join('');

    html = hint + html;
    // 未显示完时给「加载更多」
    if (rows.length > shown) {
      html += '<div class="load-more-wrap"><button id="load-more" class="btn btn-outline">' +
        T('loadMore') + ' (' + shown + '/' + rows.length + ')</button></div>';
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.vocab-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.dataset.mark) return;
        var w = card.dataset.word;
        // 从全局索引查（含跨级搜索结果），查不到也兜底为仅含汉字的对象
        var item = wordIndex()[w] || { hanzi: w };
        openVocabCard(item);
      });
    });
    grid.querySelectorAll('[data-mark]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var w = btn.dataset.mark;
        if (progress.learned[w]) {
          delete progress.learned[w];
        } else {
          progress.learned[w] = Date.now();
          if (window.DailyGoal) window.DailyGoal.record('newWord', 1);
        }
        save();
        updateBadge();
        renderVocab(document.getElementById('search-input').value, false);
      });
    });
    var more = document.getElementById('load-more');
    if (more) {
      more.addEventListener('click', function () {
        shown += PAGE;
        renderVocab(document.getElementById('search-input').value, false);
      });
    }
  }

  function initSearch() {
    var si = document.getElementById('search-input');
    si.addEventListener('input', function () { renderVocab(si.value); });
    si.setAttribute('placeholder', T('searchVocab'));
    var hs = document.getElementById('hanzi-search');
    hs.addEventListener('input', function () { renderHanzi(hs.value); });
    hs.setAttribute('placeholder', T('searchHanzi'));
  }

  function updateBadge() {
    var n = document.getElementById('learned-count');
    if (n) n.textContent = Object.keys(progress.learned).length;
    var tot = document.getElementById('vocab-total');
    if (tot) tot.textContent = (DATA.meta && DATA.meta.vocabTotal) || allWords().length;
  }

  // ------------------------------------------------------------ 笔顺
  var strokeCache = null;
  var strokeToken = 0;          // openStroke 的并发令牌，见 openStroke 注释
  function loadStrokes(cb) {
    if (strokeCache) { cb(strokeCache); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/strokes.json');
    xhr.onload = function () {
      try { strokeCache = JSON.parse(xhr.responseText).chars || {}; }
      catch (e) { strokeCache = {}; }
      cb(strokeCache);
    };
    xhr.onerror = function () { strokeCache = {}; cb(strokeCache); };
    xhr.send();
  }

  var HANZI_PAGE = 600;
  var hanziShown = HANZI_PAGE;

  function renderHanzi(filter) {
    var box = document.getElementById('hanzi-list');
    var q = (filter || '').trim();
    loadStrokes(function (strokes) {
      var keys = Object.keys(strokes);
      if (q) keys = keys.filter(function (k) { return k.indexOf(q) !== -1; });
      if (!keys.length) { box.innerHTML = '<p class="empty">' + T('notFound') + '</p>'; return; }
      var slice = keys.slice(0, hanziShown);
      var html = slice.map(function (k) {
        var s = strokes[k];
        return '<button class="hanzi-chip" data-char="' + esc(k) + '">' +
          '<span class="chip-char">' + esc(k) + '</span>' +
          '<span class="chip-meta">' + s.stroke_count + ' ' + T('strokes') + '</span></button>';
      }).join('');
      if (keys.length > hanziShown) {
        html += '<div class="load-more-wrap"><button id="hanzi-more" class="btn btn-outline">' +
          T('loadMore') + ' (' + hanziShown + '/' + keys.length + ')</button></div>';
      }
      box.innerHTML = html;
      box.querySelectorAll('.hanzi-chip').forEach(function (b) {
        b.addEventListener('click', function () { openStroke(b.dataset.char); });
      });
      var more = document.getElementById('hanzi-more');
      if (more) {
        more.addEventListener('click', function () {
          hanziShown += HANZI_PAGE;
          renderHanzi(filter);
        });
      }
    });
  }

  function openCharPicker(word, chars, item) {
    var modal = document.getElementById('stroke-modal');
    document.getElementById('stroke-char').textContent = word;
    document.getElementById('stroke-hanviet').textContent =
      (item && item.han_viet) ? item.han_viet : '';
    document.getElementById('stroke-meta').textContent = T('chooseChar');
    var target = document.getElementById('stroke-target');
    target.innerHTML = '<div class="char-picker">' + chars.map(function (c) {
      return '<button class="pick-char" data-char="' + esc(c.char) + '">' +
        esc(c.char) + '<span>' + c.stroke_count + ' ' + T('strokes') + '</span></button>';
    }).join('') + '</div>';
    toggleStrokeBtns(false);
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    target.querySelectorAll('.pick-char').forEach(function (b) {
      b.addEventListener('click', function () { openStroke(b.dataset.char, item); });
    });
  }

  function toggleStrokeBtns(show) {
    document.getElementById('stroke-play').style.display = show ? '' : 'none';
    document.getElementById('stroke-quiz').style.display = show ? '' : 'none';
  }

  // ------------------------------------------------------------ 词卡弹窗
  // 设计原则：点击任意单词**一定**弹出词卡（旧逻辑只开笔顺弹窗，
  // 遇到没有笔顺数据的词就静默无响应——用户反馈「很多词点了不弹卡片」）。
  // 词卡内含发音 / 笔顺 / 标记已学，笔顺作为卡内按钮按需打开。
  var vocabCardItem = null;

  function openVocabCard(item) {
    if (!item || !item.hanzi) return;
    vocabCardItem = item;
    var w = item.hanzi;

    document.getElementById('vm-hanzi').textContent = w;
    document.getElementById('vm-pinyin').textContent = item.pinyin || '';
    document.getElementById('vm-hanviet').textContent =
      item.han_viet ? item.han_viet : '';

    var mean = meaningOf(item) || '';
    document.getElementById('vm-meaning').innerHTML =
      (mean ? esc(mean) : '<i>' + T('notFound') + '</i>') +
      (item.en ? '<span class="vm-en">' + esc(item.en) + '</span>' : '');

    var drawable = drawableChars(item);
    var metas = ['HSK ' + (item.level != null ? item.level : '?')];
    if (drawable.length) metas.push(ico('pen','meta-ico') + drawable.length + ' ' + T('strokes'));
    var card = window.SRS.getCard(w);
    if (card) metas.push(ico('chart','meta-ico') + card.interval + 'd');
    document.getElementById('vm-meta').innerHTML =
      metas.map(function (m) { return '<span>' + m + '</span>'; }).join('');

    // 没有可写汉字时隐藏笔顺按钮，避免点了没反应
    document.getElementById('vm-stroke').style.display = drawable.length ? '' : 'none';
    updateVocabMarkBtn(w);

    var modal = document.getElementById('vocab-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    // 与首页提示一致：点词卡即发音
    speak(w, { audioKey: item.has_audio ? ('w_' + w) : null });
  }

  function closeVocabCard() {
    var m = document.getElementById('vocab-modal');
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    vocabCardItem = null;
  }

  function updateVocabMarkBtn(w) {
    var btn = document.getElementById('vm-mark');
    if (!btn) return;
    var learned = !!progress.learned[w];
    btn.classList.toggle('active-mark', learned);
    btn.innerHTML = (learned ? ico('check','inline-ico') : ico('plus','inline-ico')) + T(learned ? 'learned' : 'mark');
  }

  function initVocabModal() {
    document.querySelectorAll('[data-close-vocab]').forEach(function (el) {
      el.addEventListener('click', closeVocabCard);
    });
    document.getElementById('vm-speak').addEventListener('click', function () {
      if (!vocabCardItem) return;
      var w = vocabCardItem.hanzi;
      speak(w, { audioKey: vocabCardItem.has_audio ? ('w_' + w) : null });
    });
    document.getElementById('vm-stroke').addEventListener('click', function () {
      if (!vocabCardItem) return;
      var drawable = drawableChars(vocabCardItem);
      if (drawable.length > 1) {
        openCharPicker(vocabCardItem.hanzi, drawable, vocabCardItem);
      } else if (drawable.length === 1) {
        openStroke(drawable[0].char, vocabCardItem);
      }
    });
    document.getElementById('vm-mark').addEventListener('click', function () {
      if (!vocabCardItem) return;
      var w = vocabCardItem.hanzi;
      if (progress.learned[w]) {
        delete progress.learned[w];
      } else {
        progress.learned[w] = Date.now();
        if (window.DailyGoal) window.DailyGoal.record('newWord', 1);
      }
      save();
      updateBadge();
      updateVocabMarkBtn(w);
      renderVocab(document.getElementById('search-input').value, false);
      refreshGoalBadge();
    });
    document.getElementById('vm-assess').addEventListener('click', function () {
      if (!vocabCardItem) return;
      var w = vocabCardItem.hanzi;
      openAssess({
        text: w,
        pinyin: vocabCardItem.pinyin || '',
        audioKey: vocabCardItem.has_audio ? ('w_' + w) : null
      });
    });
  }

  // ======================================================== 发音评测
  var assessRec = null;        // SpeechAssess.Recorder
  var assessBusy = false;      // 提交中，禁用按钮防重复扣额度
  var assessTarget = null;     // {text, pinyin, audioKey}

  function asT(key, fallback) {
    var t = window.I18N && window.I18N.t ? window.I18N.t(key) : '';
    return (t && t !== key) ? t : fallback;
  }

  function openAssess(opts) {
    if (!window.SpeechAssess) return;
    assessTarget = opts;
    var m = document.getElementById('assess-modal');
    if (!m) return;

    document.getElementById('as-target').textContent = opts.text || '';
    document.getElementById('as-pinyin').textContent = opts.pinyin || '';

    // 每次打开都回到「待录音」状态
    document.getElementById('as-result').hidden = true;
    var st = document.getElementById('as-status');
    st.hidden = true;
    st.textContent = '';
    st.className = 'as-status';
    document.getElementById('as-meter-fill').style.width = '0%';
    document.getElementById('as-timer').textContent = '';
    var mic = document.getElementById('as-mic');
    mic.classList.remove('recording');
    mic.disabled = false;
    assessBusy = false;

    if (!window.SpeechAssess.configured()) {
      asStatus('info', asT('asNeedSetup',
        'Chưa cấu hình dịch vụ chấm điểm. Vào Cài đặt → Dịch vụ chấm điểm phát âm để nhập địa chỉ máy chủ.'));
      mic.disabled = true;
    }
    m.classList.add('open');
    document.body.classList.add('modal-open');
  }

  function closeAssess() {
    var m = document.getElementById('assess-modal');
    if (m) m.classList.remove('open');
    if (assessRec) { assessRec.cancel(); assessRec = null; }
    var mic = document.getElementById('as-mic');
    if (mic) { mic.classList.remove('recording'); mic.disabled = false; }
    assessBusy = false;
    document.body.classList.remove('modal-open');
  }

  function asStatus(kind, msg) {
    var st = document.getElementById('as-status');
    st.hidden = false;
    st.textContent = msg;
    st.className = 'as-status ' + kind;
  }

  function asFormatSec(ms) {
    return (ms / 1000).toFixed(1) + 's';
  }

  function toggleRecord() {
    if (assessBusy) return;
    if (!window.SpeechAssess || !assessTarget) return;
    var mic = document.getElementById('as-mic');
    var meter = document.getElementById('as-meter-fill');
    var timer = document.getElementById('as-timer');
    var st = document.getElementById('as-status');
    st.hidden = true;

    // 正在录 → 停止并提交
    if (assessRec) {
      var out = assessRec.stop();
      assessRec = null;
      mic.classList.remove('recording');
      meter.style.width = '0%';
      if (!out || out.ms < window.SpeechAssess.MIN_MS) {
        timer.textContent = '';
        asStatus('err', asT('asTooShort', 'Thu âm quá ngắn, hãy đọc to và rõ ràng.'));
        return;
      }
      timer.textContent = asFormatSec(out.ms);
      submitAssess(out);
      return;
    }

    // 开始录
    var rec = new window.SpeechAssess.Recorder();

    // 预检：把「权限已被拒绝」这种情况提前查出来。
    // 浏览器的 getUserMedia 在已拒绝时**不会再弹窗**，
    // 只是一句 Failed to fetch，学员完全不知道该做什么。
    if (!rec.supported()) {
      asStatus('err', asT('asNoSupport',
        'Trình duyệt này không hỗ trợ ghi âm. '
        + 'Hãy mở bằng Chrome, Safari hoặc trình duyệt hệ thống.'));
      return;
    }
    // 注意：APK 内走的是原生 AudioRecord，浏览器的 permissions API
    // 与系统权限不是一回事，在那里查会得到误导性的结果 —— 跳过。
    var inApp = document.documentElement.classList.contains('in-app');
    if (!inApp && navigator.permissions && navigator.permissions.query) {
      try {
        navigator.permissions.query({ name: 'microphone' }).then(function (st) {
          if (st.state === 'denied') {
            asStatus('err', asT('asDenied',
              'Quyền micrô đã bị chặn. Bấm biểu tượng ổ khóa cạnh thanh địa chỉ, '
              + 'cho phép Micrô rồi tải lại trang.'));
          }
        }).catch(function () { /* 部分浏览器不支持该查询，忽略 */ });
      } catch (e) { /* 忽略 */ }
    }
    rec.onLevel = function (rms) {
      // RMS → 0~100%，做平方根压缩让小声也可见
      var pct = Math.min(100, Math.round(Math.sqrt(rms) * 160));
      meter.style.width = pct + '%';
    };
    rec.onTick = function () { timer.textContent = asFormatSec(rec.elapsed()); };
    // 超时（15 秒）自动停止：Recorder 内部已经丢弃了音频并复位自己，
    // 这里必须同步 UI —— 否则按钮一直停在「录音中」，
    // 用户再点一下只会拿到空结果、被判成「录音太短」。
    rec.onTimeout = function () {
      if (assessRec === rec) assessRec = null;
      mic.classList.remove('recording');
      meter.style.width = '0%';
      timer.textContent = '';
      asStatus('err', asT('asTooLong',
        'Đã dừng ghi sau 15 giây. Hãy bấm lại để ghi lại từ đầu.'));
    };

    rec.start().then(function () {
      assessRec = rec;
      mic.classList.add('recording');
    }).catch(function (e) {
      var code = e && e.name;
      var ecode = e && e.code;
      if (ecode === 'permission_denied') {
        // APK 内：系统「麦克风」权限没拿到（用户在系统弹窗里选了拒绝，
        // 或勾了「不再询问」）。
        // 这里**必须**给出系统设置路径 —— APK 里没有浏览器地址栏可以点，
        // 之前那句「去浏览器设置里允许麦克风」在这里是彻底的错误指引。
        asStatus('err', asT('asPermDeniedApk',
          'Chưa được cấp quyền micrô. Vui lòng vào '
          + 'Cài đặt hệ thống → Ứng dụng → 越学中文 → Quyền → Micrô '
          + '→ Luôn cho phép, rồi mở lại ứng dụng.'));
      } else if (ecode === 'not_readable') {
        asStatus('err', asT('asMicBusy',
          'Không mở được micrô (có thể đang được ứng dụng khác chiếm). '
          + 'Hãy đóng các ứng dụng gọi thoại/ghi âm rồi thử lại.'));
      } else if (code === 'NotAllowedError') {
        asStatus('err', asT('asDenied',
          'Bị từ chối quyền thu âm. Hãy cấp quyền Micrô cho ứng dụng trong cài đặt hệ thống.'));
      } else if (code === 'NotFoundError') {
        asStatus('err', asT('asNoMic', 'Không tìm thấy micrô.'));
      } else if (code === 'NotReadableError' || ecode === 'audio_context') {
        // 麦克风被系统独占或音频服务起不来。实测 vivo/Android16 上原生录音
        // 正常、但 WebView 的 getUserMedia 会抛 NotReadableError，
        // 这里给出可操作的指引，而不是把 Chromium 的英文原文抛给用户。
        asStatus('err', asT('asMicBusy',
          'Không mở được micrô (có thể đang được ứng dụng khác chiếm). '
          + 'Hãy đóng các ứng dụng gọi thoại/ghi âm rồi thử lại, '
          + 'hoặc vào Cài đặt → Ứng dụng → 越学中文 → Quyền → Micrô → Luôn cho phép.'));
      } else if (code === 'unsupported' || (e && e.message) === 'unsupported') {
        // 网页环境缺少 getUserMedia / AudioContext。
        // 最常见于「在 App 内置浏览器里打开网页」（微信、应用内置浏览器等），
        // 这类容器普遍禁掉麦克风，必须换系统浏览器。
        asStatus('err', asT('asNoSupport',
          'Trình duyệt này không hỗ trợ ghi âm. '
          + 'Hãy mở bằng Chrome, Safari hoặc trình duyệt hệ thống.'));
      } else if (inApp) {
        // 其余错误在 APK 里都是原生侧的问题，浏览器那套指引在这里没意义。
        console.warn('[assess] 录音失败（APK）', code, ecode, e && e.message, e);
        asStatus('err', asT('asRecFailApk',
          'Không ghi được âm thanh. Hãy thử lại; nếu vẫn lỗi, '
          + 'mở lại ứng dụng và kiểm tra quyền Micrô trong Cài đặt hệ thống.'));
      } else {
        // 其余一律给出「浏览器 + 站点」两个层面的排查指引，
        // 并把真实错误名写进 console，方便对方报障时定位。
        console.warn('[assess] 录音失败', code, e && e.message, e);
        asStatus('err', asT('asRecFail2',
          'Không ghi được âm thanh. '
          + 'Nếu trình duyệt chưa hỏi xin quyền, hãy bấm biểu tượng ổ khóa '
          + 'cạnh thanh địa chỉ → cho phép Micrô → tải lại trang. '
          + 'Nếu vẫn lỗi, hãy thử trình duyệt khác.'));
      }
    });
  }

  function submitAssess(out) {
    if (!window.SpeechAssess || !assessTarget) return;
    assessBusy = true;
    document.getElementById('as-mic').disabled = true;
    asStatus('info', asT('asScoring', 'Đang chấm điểm...'));

    window.SpeechAssess.assess(assessTarget.text, out.bytes, out.ms).then(function (r) {
      assessBusy = false;
      document.getElementById('as-mic').disabled = false;
      document.getElementById('as-status').hidden = true;
      renderAssess(r);
    }).catch(function (e) {
      assessBusy = false;
      document.getElementById('as-mic').disabled = false;
      var msg = (e && e.message) || asT('asErr', 'Lỗi không xác định.');
      if (e && e.code === 'not_configured') {
        msg = asT('asNeedSetup', 'Chưa cấu hình dịch vụ chấm điểm.');
      }
      asStatus('err', msg);
    });
  }

  function renderAssess(r) {
    var box = document.getElementById('as-result');
    if (!box) return;
    box.hidden = false;

    // 归一化：服务端有可能只回 `ok:true` 而漏掉 score/words，
    // 或者把分数写成字符串。历史上这里直接读 `r.score.phone`，
    // 遇到畸形响应会抛 TypeError，catch 之后把英文异常原文甩给用户。
    // 现在任何缺字段/类型不对都当成 0，页面永远能正常渲染。
    r = (r && typeof r === 'object') ? r : {};
    var score = (r.score && typeof r.score === 'object') ? r.score : {};
    function num(v) {
      var n = typeof v === 'number' ? v : parseFloat(v);
      return (isFinite(n) ? n : 0);
    }

    var sc = num(score.overall);
    var el = document.getElementById('as-score');
    if (el) {
      el.textContent = sc;
      el.className = 'as-score' + (sc >= 80 ? '' : sc >= 60 ? ' mid' : ' low');
    }

    // 四个分项
    var dims = [
      ['asDimPhone', num(score.phone),   'Âm tự'],
      ['asDimTone',  num(score.tone),    'Thanh điệu'],
      ['asDimFlu',   num(score.fluency), 'Trôi chảy'],
      ['asDimComp',  num(compScore(r)),  'Đầy đủ']
    ];
    var dimsBox = document.getElementById('as-dims');
    if (dimsBox) {
      dimsBox.innerHTML = dims.map(function (d) {
        return '<div class="as-dim"><b>' + (d[1] > 0 ? d[1] : '—') + '</b><span>' +
               asT(d[0], d[2]) + '</span></div>';
      }).join('');
    }

    // 逐字得分
    // 调试：如果服务器带了讯飞的原始返回（_raw），显示出来。
    // 这样「0 分无明细」时能直接看到讯飞到底返回了什么，不用再靠猜。
    if (r && r._raw) {
      var rawBox = document.getElementById('as-raw');
      if (rawBox) {
        rawBox.textContent = '讯飞原始返回：' + r._raw;
        rawBox.hidden = false;
      }
    }

    var chars = [];
    (r.words || []).forEach(function (w) {
      (w.chars || []).forEach(function (c) { chars.push(c); });
    });
    document.getElementById('as-chars').innerHTML = chars.map(function (c) {
      var cls = c.sc >= 80 ? 'good' : c.sc >= 60 ? 'ok' : 'bad';
      return '<div class="as-char ' + cls + '"><div class="c">' + esc(c.w) +
             '</div><div class="s">' + c.sc + '</div></div>';
    }).join('');

    // 针对性建议：优先指出读得最差的字
    var tip = document.getElementById('as-tip');
    var worst = chars.slice().sort(function (a, b) { return a.sc - b.sc; })[0];
    if (!chars.length) {
      tip.textContent = asT('asNoChar', 'Không nhận được dữ liệu chi tiết.');
    } else if (sc >= 85) {
      tip.textContent = asT('asGreat', 'Phát âm rất tốt! Tiếp tục duy trì.');
    } else if (worst && worst.sc < 60) {
      tip.textContent = asT('asFocus', 'Hãy chú ý đọc rõ chữ “') + worst.w + '”.';
    } else if (r.score && r.score.tone > 0 && r.score.tone < 70) {
      tip.textContent = asT('asToneFocus', 'Thanh điệu chưa chính xác, hãy tập trung cao độ ngoặc.');
    } else {
      tip.textContent = asT('asRetry', 'Nghe lại bản chuẩn rồi đọc lại nhé.');
    }
  }

  function compScore(r) {
    // 完整度：识别到的字 / 目标字数
    var total = (assessTarget && assessTarget.text ? assessTarget.text.length : 0);
    var got = 0;
    (r.words || []).forEach(function (w) { got += (w.chars || []).length; });
    if (!total || !got) return 0;
    return Math.round(Math.min(100, got / total * 100));
  }

  function initAssess() {
    document.querySelectorAll('[data-close-assess]').forEach(function (el) {
      el.addEventListener('click', closeAssess);
    });
    var mic = document.getElementById('as-mic');
    if (mic) mic.addEventListener('click', toggleRecord);

    var again = document.getElementById('as-again');
    if (again) {
      again.addEventListener('click', function () {
        document.getElementById('as-result').hidden = true;
        document.getElementById('as-status').hidden = true;
        document.getElementById('as-timer').textContent = '';
        document.getElementById('as-meter-fill').style.width = '0%';
      });
    }

    var play = document.getElementById('as-play');
    if (play) {
      play.addEventListener('click', function () {
        if (!assessTarget) return;
        speak(assessTarget.text, {
          audioKey: assessTarget.audioKey || null
        });
      });
    }

    // 设置页：评测服务地址
    var input = document.getElementById('ise-endpoint');
    var save = document.getElementById('btn-ise-save');
    var state = document.getElementById('ise-state');
    if (input && window.SpeechAssess) {
      input.value = window.SpeechAssess.endpoint();
      var paint = function () {
        if (!state) return;
        var on = window.SpeechAssess.configured();
        state.textContent = on
          ? asT('asSvcOn', 'Đã cấu hình: ') + window.SpeechAssess.endpoint()
          : asT('asSvcOff', 'Chưa cấu hình — tính năng chấm điểm phát âm đang tắt.');
        state.className = 'ise-state' + (on ? ' on' : '');
      };
      paint();
      if (save) {
        save.addEventListener('click', function () {
          var v = (input.value || '').trim();
          window.SpeechAssess.setEndpoint(v);
          paint();
          if (state) {
            state.textContent = v
              ? asT('asSvcSaved', 'Đã lưu. Thử chấm điểm một từ để kiểm tra kết nối.')
              : asT('asSvcOff', 'Chưa cấu hình — tính năng chấm điểm phát âm đang tắt.');
          }
        });
      }
    }

    // 设置页：代理访问口令（服务端配了 X-Proxy-Key 才需要）
    var keyInput = document.getElementById('ise-proxy-key');
    var keySave = document.getElementById('btn-ise-key-save');
    if (keyInput && window.SpeechAssess) {
      keyInput.value = window.SpeechAssess.proxyKey();
      if (keySave) {
        keySave.addEventListener('click', function () {
          var v = (keyInput.value || '').trim();
          window.SpeechAssess.setProxyKey(v);
          keyInput.value = v;
          toast(v
            ? asT('asKeySaved', 'Đã lưu mật khẩu truy cập proxy.')
            : asT('asKeyCleared', 'Đã xóa mật khẩu truy cập proxy.'));
        });
      }
    }
  }

  var writer = null;
  function openStroke(ch, item) {
    // 打开令牌：loadStrokes 首次是异步 XHR，回调到达时用户可能已经
    // 关闭了弹窗或又打开了别的字。用令牌把过期回调丢弃，
    // 否则会出现「关掉笔顺后它又自己弹出来」的幽灵弹窗。
    var token = ++strokeToken;
    strokeOpenArgs = { ch: ch, item: item };   // 供切换语言时重新打开
    var modal = document.getElementById('stroke-modal');
    loadStrokes(function (strokes) {
      if (token !== strokeToken) return;       // 已过期：弹窗已关或已改开别的字
      var s = strokes[ch];
      if (!s) { speak(ch); return; }
      document.getElementById('stroke-char').textContent = ch;
      document.getElementById('stroke-meta').textContent =
        s.stroke_count + ' ' + T('strokes') + (s.radical ? ' · ' + T('radical') + ' ' + s.radical : '');
      var hv = '';
      if (item) hv = item.han_viet || '';
      else {
        var hit = allWords().filter(function (v) { return v.hanzi.indexOf(ch) !== -1; })[0];
        hv = hit ? hit.han_viet : '';
      }
      document.getElementById('stroke-hanviet').textContent = hv || '';
      toggleStrokeBtns(true);
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      var target = document.getElementById('stroke-target');
      target.innerHTML = '';
      // 注意：HanziWriter 3.x 的签名是 create(target, character, options)，
      // 旧版 2.x 是 create(character, target, options)——传反会让 target
      // 位置拿到数据对象，直接抛 "Cannot read properties of undefined (reading 'toUpperCase')"
      // 另外 3.x 默认通过 charDataLoader 从 CDN 拉数据，离线 App 必须喂本地笔顺数据
      writer = window.HanziWriter.create(target, ch, {
        width: 220, height: 220, padding: 12,
        strokeColor: '#0f766e', radicalColor: '#dc2626',
        outlineColor: '#ddd', drawingColor: '#333',
        showOutline: true, strokeAnimationSpeed: 0.9, delayBetweenStrokes: 320,
        charDataLoader: function (char, onComplete, onError) {
          var data = strokes[char] || s;
          if (data) onComplete(data);
          else if (onError) onError(new Error('no local stroke data: ' + char));
        },
      });
    });
  }

  /** 开始笔顺书写评分 */
  function startStrokeQuiz(ch, total) {
    var target = document.getElementById('stroke-target');
    var opts = window.StrokeScore.buildQuizOptions(ch, total, function (r) {
      showStrokeResult(r);
    });
    writer.quiz(opts);
    // 隐藏按钮，避免误触
    toggleStrokeBtns(false);
  }

  /** 展示书写评分 */
  function showStrokeResult(r) {
    var stars = '';
    stars = starRow(r.stars);
    var speedTxt = '';
    if (r.speedStars != null) {
      var sStars = '';
      for (var j = 1; j <= 3; j++) sStars += ico('zap','speed-zap' + (j <= r.speedStars ? ' on' : ''));
      speedTxt = '<div class="stroke-res-speed">' + T('speed') + ' ' +
        (sStars || '—') + '</div>';
    }
    var fb = document.createElement('div');
    fb.className = 'stroke-result ' + (r.stars >= 3 ? 'perfect' : r.stars >= 2 ? 'good' : 'poor');
    fb.innerHTML =
      '<div class="stroke-res-stars">' + stars + '</div>' +
      '<div class="stroke-res-order">' + T('orderPct') + ' ' + r.orderPct + '%' +
        ' (' + r.correct + '/' + r.total + ')</div>' +
      (r.mistakes > 0
        ? '<div class="stroke-res-mistake">' + T('mistakes') + ' ' + r.mistakes + '</div>'
        : '') +
      speedTxt +
      '<button id="stroke-retry" class="btn btn-outline btn-sm">' + T('tryAgain') + '</button>';

    var box = document.getElementById('stroke-result-box');
    box.innerHTML = '';
    box.appendChild(fb);
    document.getElementById('stroke-retry').addEventListener('click', function () {
      startStrokeQuiz(r.ch, r.total);
    });
    toggleStrokeBtns(true);
    if (window.DailyGoal) window.DailyGoal.record('listen', 0);  // 书写不计入目标
  }

  function closeStroke() {
    var m = document.getElementById('stroke-modal');
    if (!m) return;
    strokeToken++;              // 让在途的 openStroke 回调失效
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    var box = document.getElementById('stroke-result-box');
    if (box) box.innerHTML = '';
    // 必须清掉打开参数：否则切换语言时（__onLangChanged 会重新打开
    // 「正处于打开状态」的弹窗）这个已关闭的笔顺弹窗会被重新弹出来。
    strokeOpenArgs = null;
    // 关弹窗必须停掉笔顺动画与评分回调。
    // HanziWriter 的 quiz 模式有自己的循环，不 cancel 就会一直跑：
    // 关掉弹窗后仍在写、仍会回调评分，并往**已经隐藏**的弹窗里渲染结果。
    if (writer) {
      try { writer.cancelQuiz(); } catch (e) { /* 已结束，忽略 */ }
      try { writer.animateCharacter(); } catch (e) { /* 同上 */ }
    }
  }

  function initStrokeModal() {
    document.querySelectorAll('[data-close-modal]').forEach(function (el) {
      el.addEventListener('click', closeStroke);
    });
    document.getElementById('stroke-play').addEventListener('click', function () {
      if (writer) { writer.cancelQuiz(); writer.animateCharacter(); }
    });
    document.getElementById('stroke-quiz').addEventListener('click', function () {
      if (!writer) return;
      var ch = document.getElementById('stroke-char').textContent;
      var total = (window.StrokeScore.get(ch) || {}).total || 0;
      if (!total) {
        // 从笔顺数据里取总笔画
        loadStrokes(function (st) {
          if (st[ch]) startStrokeQuiz(ch, st[ch].stroke_count);
          else writer.quiz({ showHintAfterMisses: 2 });
        });
      } else {
        startStrokeQuiz(ch, total);
      }
    });
  }

  // ------------------------------------------------------------ SRS
  function renderSrsStats() {
    var box = document.getElementById('srs-stats');
    if (!box) return;
    var st = window.SRS.stats();
    box.innerHTML =
      '<div class="srs-stat"><div class="srs-num">' + st.due + '</div><div class="srs-lbl">' + T('dueToday') + '</div></div>' +
      '<div class="srs-stat"><div class="srs-num">' + st.mastered + '</div><div class="srs-lbl">' + T('mastered') + '</div></div>' +
      '<div class="srs-stat"><div class="srs-num">' + st.total + '</div><div class="srs-lbl">' + T('learned') + '</div></div>';
  }

  var srsState = null;
  function startSrs() {
    // 新词限制在当前等级；已学词跨等级参与到期复习
    var learnedPool = Object.keys(progress.learned);
    var pool = window.SRS.dueCards(
      VOCAB.length ? VOCAB : allWords(), 10, learnedPool);
    var box = document.getElementById('srs-area');
    if (!pool.length) {
      box.innerHTML = '<p class="empty">' + T('noDue') + '</p>';
      return;
    }
    srsState = { pool: pool, idx: 0, right: 0 };
    renderSrsCard();
  }

  function renderSrsCard() {
    var box = document.getElementById('srs-area');
    if (!srsState || srsState.idx >= srsState.pool.length) {
      box.innerHTML = '<div class="quiz-result"><div class="result-score">' +
        srsState.right + '/' + srsState.pool.length + '</div>' +
        '<button id="srs-again" class="btn btn-primary">' + T('again') + '</button></div>';
      document.getElementById('srs-again').addEventListener('click', startSrs);
      return;
    }
    var w = srsState.pool[srsState.idx];
    var item = allWords().filter(function (x) { return x.hanzi === w; })[0] || {};
    var card = window.SRS.getCard(w);
    var opts = buildOptions(w, item);
    box.innerHTML =
      '<div class="quiz-q">' + (srsState.idx + 1) + '/' + srsState.pool.length +
        (card ? ' · ' + ico('chart','inline-ico') + card.interval + 'd' : '') + '</div>' +
      '<div class="quiz-prompt">' + esc(w) + '</div>' +
      '<div class="quiz-pinyin">' + esc(item.pinyin || '') + '</div>' +
      (item.han_viet ? '<div class="quiz-hanviet">' + ico('globe','inline-ico') + esc(item.han_viet) + '</div>' : '') +
      '<div class="quiz-opts">' + opts.map(function (o) {
        return '<button class="quiz-opt" data-answer="' + esc(o.answer) + '">' + esc(o.label) + '</button>';
      }).join('') + '</div>';
    box.querySelectorAll('.quiz-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var ok = b.dataset.answer === w;
        window.SRS.review(w, ok ? 4 : 1);
        if (ok) {
          srsState.right++;
          if (window.DailyGoal) window.DailyGoal.record('review', 1);
          if (window.Settings) window.Settings.clearWrong(w);
        } else if (window.Settings) {
          window.Settings.addWrong(w, 'srs');
        }
        b.classList.add(ok ? 'right' : 'wrong');
        speak(w, { audioKey: item.has_audio ? ('w_' + w) : null });
        setTimeout(function () {
          srsState.idx++;
          renderSrsStats();
          renderSrsCard();
        }, 700);
      });
    });
  }

  /** 生成 4 个选项。选项显示「拼音 + 释义」，正确项与干扰项结构完全一致。 */
  function buildOptions(correct, item) {
    var pool = VOCAB.length ? VOCAB : allWords();
    var others = pool.filter(function (x) { return x.hanzi !== correct; });
    for (var i = others.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = others[i]; others[i] = others[j]; others[j] = t;
    }
    var mk = function (o) {
      return {
        answer: o.hanzi,
        pinyin: o.pinyin || '',
        label: meaningOf(o) || o.hanzi,
      };
    };
    var opts = [mk(item)];
    others.slice(0, 3).forEach(function (o) { opts.push(mk(o)); });
    for (var m = opts.length - 1; m > 0; m--) {
      var n = Math.floor(Math.random() * (m + 1));
      var tmp = opts[m]; opts[m] = opts[n]; opts[n] = tmp;
    }
    return opts;
  }

  // ------------------------------------------------------------ 拼音
  var pyTab = 'initial';

  function initPinyin() {
    document.querySelectorAll('.pinyin-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        pyTab = tab.dataset.ptab;
        document.querySelectorAll('.pinyin-tab').forEach(function (x) {
          x.classList.toggle('active', x === tab);
        });
        renderPinyin(pyTab);
      });
    });
    renderPinyin(pyTab);
  }

  function renderPinyin(kind) {
    var box = document.getElementById('pinyin-content');
    var html = '';

    if (kind === 'syllable') {
      var syl = typeof PINYIN_SYLLABLES !== 'undefined' ? PINYIN_SYLLABLES : [];
      html += '<div class="syl-grid">' + syl.map(function (s) {
        // 朗读文本取例子里的汉字（如 '八 bā' → '八'）：
        // 带声调符号的拼音（'bā'）会被 TTS 当英文读，汉字才可靠
        var say = (s.example || '').split(' ')[0] || s.text;
        return '<button class="syl-card" data-say="' + esc(say) + '">' +
          '<span class="syl-text">' + esc(s.text) + '</span>' +
          '<span class="syl-eg">' + esc(s.example) + '</span>' +
        '</button>';
      }).join('') + '</div>';
      var tips = typeof PINYIN_TIPS !== 'undefined' ? PINYIN_TIPS : [];
      html += '<div class="tips-block">' + tips.map(function (t) {
        // 提示文案按当前界面语言取；缺失时回退中文，避免出现空白块
        var L = window.I18N ? window.I18N.lang : 'vi';
        var ti = L === 'zh' ? t.title : (L === 'en' ? t.titleEn : t.titleVi) || t.title;
        var de = L === 'zh' ? t.desc  : (L === 'en' ? t.descEn  : t.descVi)  || t.desc;
        return '<div class="tip-card">' +
          '<div class="tip-title">' + esc(ti) + '</div>' +
          '<div class="tip-desc">' + esc(de) + '</div>' +
        '</div>';
      }).join('') + '</div>';
    } else if (kind === 'initial') {
      var ini = typeof PINYIN_INITIALS !== 'undefined' ? PINYIN_INITIALS : [];
      var ig = typeof PINYIN_INITIAL_GROUPS !== 'undefined' ? PINYIN_INITIAL_GROUPS : [];
      html += ig.map(function (g) {
        var items = ini.filter(function (x) { return x.labialType === g.key; });
        if (!items.length) return '';
        return '<div class="py-group">' +
          '<div class="py-group-head">' + esc(g.label) +
            '<span class="py-group-sub">' + esc(g.labelVi) + '</span></div>' +
          '<div class="pinyin-grid">' + items.map(function (it) {
            return '<button class="pinyin-cell" data-audio="audio/pinyin/' + it.audio + '"' +
              (it.say ? ' data-say="' + esc(it.say) + '"' : '') + '>' +
              '<span class="py-symbol">' + esc(it.display) + '</span>' +
              (it.sound ? '<span class="py-sound" title="Cách đọc">' + esc(it.sound) + '</span>' : '') +
              (it.example ? '<span class="py-example">' + esc(it.example) + '</span>' : '') +
            '</button>';
          }).join('') + '</div></div>';
      }).join('');
    } else if (kind === 'final') {
      var fin = typeof PINYIN_FINALS !== 'undefined' ? PINYIN_FINALS : [];
      var fg = typeof PINYIN_FINAL_GROUPS !== 'undefined' ? PINYIN_FINAL_GROUPS : [];
      html += fg.map(function (g) {
        var items = fin.filter(function (x) { return x.group === g.key; });
        if (!items.length) return '';
        return '<div class="py-group">' +
          '<div class="py-group-head">' + esc(g.label) +
            '<span class="py-group-sub">' + esc(g.labelVi) + '</span></div>' +
          '<div class="pinyin-grid">' + items.map(function (it) {
            return '<button class="pinyin-cell" data-audio="audio/pinyin/' + it.audio + '"' +
              (it.say ? ' data-say="' + esc(it.say) + '"' : '') + '>' +
              '<span class="py-symbol">' + esc(it.display) + '</span>' +
              (it.example ? '<span class="py-example">' + esc(it.example) + '</span>' : '') +
            '</button>';
          }).join('') + '</div></div>';
      }).join('');
    } else {
      var ton = typeof PINYIN_TONES !== 'undefined' ? PINYIN_TONES : [];
      html += '<div class="tone-grid">' + ton.map(function (t) {
        return '<button class="tone-card" data-audio="audio/pinyin/' + t.audio + '"' +
          (t.say ? ' data-say="' + esc(t.say) + '"' : '') + '>' +
          '<span class="tone-display">' + esc(t.display) + '</span>' +
          '<span class="tone-mark">' + esc(t.mark) + '</span>' +
          '<span class="tone-tip">' + esc(t.tip) + '</span>' +
          (t.example ? '<span class="tone-eg">' + esc(t.example) + '</span>' : '') +
        '</button>';
      }).join('') + '</div>';
    }

    box.innerHTML = html || '<p class="empty">' + T('empty') + '</p>';

    // 事件绑定：mp3 播放 / TTS 朗读
    box.querySelectorAll('[data-audio]').forEach(function (b) {
      b.addEventListener('click', function () { playLocal(b.dataset.audio, b.dataset.say); });
    });
    box.querySelectorAll('[data-say]').forEach(function (b) {
      b.addEventListener('click', function () {
        // 同时带 data-audio 的元素（声母/韵母/声调卡）由上面的处理器负责，
        // 那里已内置播放失败回退；这里只处理纯 TTS 元素，避免双重播放
        if (b.dataset.audio) return;
        speak(b.dataset.say);
      });
    });
  }

  /** 播放本地音频；文件缺失/播放失败时用 sayText 回退系统 TTS（不再静默） */
  function playLocal(src, sayText) {
    try {
      if (!audioEl) audioEl = new Audio();
      audioEl.onerror = function () {
        audioEl.onerror = null;
        notifyAudioMissing();
        if (sayText) speak(sayText);
      };
      audioEl.src = src;
      var p = audioEl.play();
      if (p && p.catch) p.catch(function () { notifyAudioMissing(); });
      return true;
    } catch (e) {
      notifyAudioMissing();
      return false;
    }
  }

  // ------------------------------------------------------------ 课程句子
  // 按 HSK 等级分组，UI 与「学词」页保持一致
  var sentLevel = '1';

  /**
   * 测量底部等级筛选栏的真实高度，写入 CSS 变量 --filter-bar-h。
   *
   * 背景：筛选栏改为 position:fixed 后不再占文档流，内容会钻到它下面被遮住。
   * 栏内是两行等级标签，宽度变化时（不同语言字号）高度会变，写死数值不可靠，
   * 故在渲染完成与语言切换后各量一次。
   */
  var filterBarRaf = 0;

  function syncFilterBarHeight() {
    // 一帧内连续调用只测一次；并放进 requestAnimationFrame，
    // 让浏览器先把手上的动画画完再回来量，避免在动画中途触发同步布局。
    if (filterBarRaf) return;
    filterBarRaf = requestAnimationFrame(function () {
      filterBarRaf = 0;
      // 只看当前可见分区的栏：隐藏分区量不到高度（offsetHeight 恒 0），
      // 遍历它们纯属浪费。首页/测验/设置等没有栏的分区直接跳过，保持原值。
      var bar = document.querySelector('.section.active .section-bottom-bar');
      if (!bar) return;
      var h = bar.offsetHeight;
      if (h > 0) {
        document.documentElement.style.setProperty('--filter-bar-h', h + 'px');
      }
    });
  }

  window.addEventListener('resize', syncFilterBarHeight);
  window.addEventListener('orientationchange', syncFilterBarHeight);

  function initCourses() {
    renderSentLevelTabs();
    // 初始就要渲染课程标签与第一课内容（旧代码漏了这一步，
    // 导致进入句子页只有 HSK 等级、下面全空，必须手点一个等级才有内容）
    renderSentCourses();
    syncFilterBarHeight();
  }

  function renderSentLevelTabs() {
    var box = document.getElementById('sent-level-tabs');
    if (!box) return;
    var byLv = {};
    COURSES.forEach(function (c) {
      var lv = String(c.level || 1);
      byLv[lv] = byLv[lv] || { courses: 0, sentences: 0 };
      byLv[lv].courses++;
      byLv[lv].sentences += c.sentences.length;
    });
    box.innerHTML = Object.keys(byLv).sort().map(function (lv) {
      // 等级在上、句数在下（两行分层）；课数仍留在 title 里备查。
      // 早期为了避免窄屏横向滚动只显示「HSK N」，现在底部筛选栏已改成
      // 单行 6 列栅格、不再横向滚动，所以可以把数量显示出来了。
      return '<button class="level-tab' + (lv === sentLevel ? ' active' : '') +
        '" data-slv="' + lv + '" title="HSK ' + lv + ' · ' +
        byLv[lv].courses + ' ' + T('courseUnit') + ' · ' +
        byLv[lv].sentences + ' ' + T('sentenceUnit') + '">' +
        '<span class="lvl-name">HSK ' + lv + '</span>' +
        '<span class="lvl-count">' + byLv[lv].sentences + '</span>' +
        '</button>';
    }).join('');
    box.querySelectorAll('[data-slv]').forEach(function (b) {
      b.addEventListener('click', function () {
        sentLevel = b.dataset.slv;
        renderSentLevelTabs();
        renderSentCourses();
        syncFilterBarHeight();
      });
    });
  }

  function renderSentCourses() {
    var box = document.getElementById('course-content');
    var list = COURSES.filter(function (c) {
      return String(c.level || 1) === sentLevel;
    });
    if (!list.length) {
      box.innerHTML = '<p class="empty">' + T('empty') + '</p>';
      return;
    }
    // 课程用卡片网格呈现（旧版是 14 个 pill 换行 4 行，把内容挤出屏幕）
    box.innerHTML = '<div class="course-grid">' + list.map(function (c, i) {
      return '<button class="course-card" data-course="' + i + '">' +
        '<span class="cc-title">' + esc(courseLabel(c)) + '</span>' +
        '<span class="cc-meta">' + c.sentences.length + ' ' + T('sentenceUnit') + '</span>' +
        '</button>';
    }).join('') + '</div>';
    box.querySelectorAll('.course-card').forEach(function (card) {
      card.addEventListener('click', function () {
        renderCourse(list[+card.dataset.course]);
      });
    });
  }

  /** 课程标题按当前语言显示 */
  function courseLabel(c) {
    var lang = window.I18N.lang;
    if (lang === 'zh') return c.courseTitle;
    return c.courseTitleVi || c.courseTitle;
  }

  function renderCourse(course) {
    var box = document.getElementById('course-content');
    if (!course) { box.innerHTML = ''; return; }
    // 课序用于定位预生成音频 s_<课序>_<句序>
    var ci = COURSES.indexOf(course);
    box.innerHTML =
      '<button class="course-back" data-back="1">' + ico('arrow-left','inline-ico') + T('backToCourses') + '</button>' +
      '<div class="course-head">' +
        '<h3>' + esc(courseLabel(course)) + '</h3>' +
        '<span class="badge-level">HSK ' + (course.level || 1) + '</span>' +
      '</div>' +
      '<div class="sentence-list">' +
      course.sentences.map(function (s, i) {
        var key = 's_' + ci + '_' + i;
        return '<div class="sentence-row" data-say="' + esc(s.hanzi) + '" ' +
          'data-audio="audio/sentences/' + key + '.mp3">' +
          '<div class="sent-idx">' + (i + 1) + '</div>' +
          '<div class="sent-body">' +
            '<div class="sent-hanzi">' + esc(s.hanzi) + '</div>' +
            '<div class="sent-pinyin">' + esc(s.pinyin) + '</div>' +
            (s.han_viet
              ? '<div class="sent-hanviet">' + ico('globe','inline-ico') + esc(s.han_viet) + '</div>' : '') +
            '<div class="sent-vi">' + esc(s.vi) + '</div>' +
          '</div>' +
          '<button class="sent-play" data-key="' + key + '" title="Nghe">' + ico('volume','inline-ico') + '</button>' +
        '</div>';
      }).join('') +
      '</div>';
    box.querySelectorAll('.sentence-row').forEach(function (r) {
      r.addEventListener('click', function (e) {
        if (e.target.dataset.key) return;      // 右侧喇叭按钮自己处理
        // 整行点读要走**句子音频**（data-audio），不能用 speak() ——
        // speak() 的键规则是 `w_<文本>`，对整句会去找 audio/words/w_<整句>.mp3，
        // 那文件永远不存在，于是 404 -> TTS 回退 -> WebView 里没有 TTS 引擎 ->
        // 完全无声。表现为「点句子正文没声音，但点右边喇叭有声音」。
        if (r.dataset.audio) {
          playLocal(r.dataset.audio, r.dataset.say);
          return;
        }
        speak(r.dataset.say);
      });
    });
    // 优先播放预生成的句子音频；失败回退系统 TTS
    box.querySelectorAll('.sent-play').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var src = 'audio/sentences/' + b.dataset.key + '.mp3';
        // 不能用 audioEl 是否存在来判断能否播本地音频 —— audioEl 是懒创建的，
        // 首次点击时必为 null，导致第一次永远走 TTS（WebView 里等于没声音）。
        if (playLocal(src, b.closest('.sentence-row').dataset.say)) return;
        speak(b.closest('.sentence-row').dataset.say);
      });
    });
    // 返回课程卡片网格
    var back = box.querySelector('[data-back]');
    if (back) {
      back.addEventListener('click', function () {
        renderSentCourses();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  // ------------------------------------------------------------ 测验
  var quizState = null;

  function initQuiz() {
    document.getElementById('quiz-area').innerHTML =
      '<div class="quiz-intro">' +
        '<div class="quiz-intro-icon">' + ico('quiz','intro-ico') + '</div>' +
        '<p class="quiz-intro-text">' + T('quizIntro') + '</p>' +
        '<button id="quiz-start" class="btn btn-primary btn-large">' +
          T('startQuiz') + '</button>' +
      '</div>';
    document.getElementById('quiz-start').addEventListener('click', startQuiz);
  }

  function startQuiz() {
    var pool = (VOCAB.length ? VOCAB : allWords()).slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    // 新一轮开始前，取消上一轮可能还在跑的自动推进
    if (quizAdvanceTimer) { clearTimeout(quizAdvanceTimer); quizAdvanceTimer = 0; }
    quizState = { pool: pool.slice(0, 10), idx: 0, correct: 0 };
    renderQuizQuestion();
  }

  /** 完成一轮练习后记录 */
  function logPractice(type) {
    if (window.DailyGoal) {
      window.DailyGoal.record(type, 1);
      refreshGoalBadge();
    }
  }

  function renderQuizQuestion() {
    var box = document.getElementById('quiz-area');
    if (quizState.idx >= quizState.pool.length) {
      var pct = Math.round(quizState.correct / quizState.pool.length * 100);
      box.innerHTML = '<div class="quiz-result">' +
        resultRing(pct) +
        '<div class="result-score">' + quizState.correct +
          '<span>/' + quizState.pool.length + '</span></div>' +
        '<button id="quiz-again" class="btn btn-primary">' + T('again') + '</button>' +
        '</div>';
      document.getElementById('quiz-again').addEventListener('click', startQuiz);
      logPractice('listen');
      return;
    }
    var q = quizState.pool[quizState.idx];
    var opts = buildOptions(q.hanzi, q);
    var prog = Math.round(quizState.idx / quizState.pool.length * 100);

    box.innerHTML =
      '<div class="quiz-card">' +
        '<div class="quiz-top">' +
          '<span class="quiz-count">' + T('question') + ' ' +
            (quizState.idx + 1) + '/' + quizState.pool.length + '</span>' +
          '<span class="quiz-progress">' + prog + '%</span>' +
        '</div>' +
        '<div class="quiz-progressbar"><i style="width:' + prog + '%"></i></div>' +
        // 题干只显示汉字，不显示拼音（避免提示）
        '<div class="quiz-prompt">' + esc(q.hanzi) + '</div>' +
        (q.han_viet ? '<div class="quiz-hanviet">' + ico('globe', 'inline-ico') + esc(q.han_viet) + '</div>' : '') +
        '<div class="quiz-hint">' + T('quizHint') + '</div>' +
        '<div class="quiz-opts">' + opts.map(function (o) {
          return '<button class="quiz-opt" data-answer="' + esc(o.answer) + '">' +
            '<span class="opt-pinyin">' + esc(o.pinyin) + '</span>' +
            '<span class="opt-mean">' + esc(o.label) + '</span>' +
          '</button>';
        }).join('') + '</div>' +
      '</div>';

    box.querySelectorAll('.quiz-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var ok = b.dataset.answer === q.hanzi;
        if (ok) quizState.correct++;
        b.classList.add(ok ? 'right' : 'wrong');
        if (ok) {
          if (window.Settings) window.Settings.clearWrong(q.hanzi);
        } else {
          if (window.Settings) window.Settings.addWrong(q.hanzi, 'quiz');
          box.querySelectorAll('.quiz-opt').forEach(function (x) {
            if (x.dataset.answer === q.hanzi) x.classList.add('right');
          });
        }
        speak(q.hanzi, { audioKey: q.has_audio ? ('w_' + q.hanzi) : null });
        // 登记句柄：切走分区时能被取消，不往隐藏分区里渲染
        if (quizAdvanceTimer) clearTimeout(quizAdvanceTimer);
        quizAdvanceTimer = setTimeout(function () {
          quizAdvanceTimer = 0;
          quizState.idx++; renderQuizQuestion();
        }, 1100);
      });
    });
  }

  // ------------------------------------------------------------ 设置与数据
  function initSettings() {
    renderStats();
    renderResetButtons();
    renderWrongList();
    renderStrokeRecords();

    var io = document.getElementById('data-io');
    var be = document.getElementById('btn-export');
    var bi = document.getElementById('btn-import');
    var bra = document.getElementById('btn-reset-all');

    if (be) be.addEventListener('click', function () {
      io.value = window.Settings.exportData();
      io.select();
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(io.value);
      } catch (e) { /* 忽略 */ }
      toast(T('exported'));
    });
    if (bi) bi.addEventListener('click', function () {
      var r = window.Settings.importData(io.value);
      if (r.ok) {
        toast(T('imported'));
        renderStats();
        updateBadge();
        renderSrsStats();
        renderVocab(document.getElementById('search-input').value, false);
      } else {
        toast(T('importFail'));
      }
    });
    if (bra) bra.addEventListener('click', function () {
      if (confirm(T('confirmResetAll'))) {
        var cleared = window.Settings.resetAll();
        toast(T('resetDone') + (cleared ? ' (' + cleared + ')' : ''));
        renderStats();
        renderSrsStats();
        updateBadge();
        renderVocab('', false);
      }
    });
  }

  function renderStats() {
    var grid = document.getElementById('stat-grid');
    if (!grid || !window.Settings) return;
    var s = window.Settings.collectStats();
    var items = [
      [s.learnedTotal, T('statLearned')],
      [s.learning, T('statLearning')],
      [s.mastered, T('statMastered')],
      [s.due, T('dueToday')],
      [s.activeDays, T('statDays')],
      [s.wrongTotal || 0, T('statWrong')],
    ];
    grid.innerHTML = items.map(function (it) {
      return '<div class="stat-cell"><div class="stat-num">' + it[0] +
        '</div><div class="stat-lbl">' + it[1] + '</div></div>';
    }).join('');

    var lv = document.getElementById('stat-levels');
    if (lv) {
      var keys = Object.keys(s.byLevel).sort();
      lv.innerHTML = keys.length
        ? keys.map(function (k) {
            var total = (LEVELS[k] || []).length;
            var pct = Math.round(s.byLevel[k] / total * 100);
            return '<div class="lv-row"><span class="lv-name">HSK ' + k + '</span>' +
              '<span class="lv-bar"><i style="width:' + pct + '%"></i></span>' +
              '<span class="lv-num">' + s.byLevel[k] + '/' + total + '</span></div>';
          }).join('')
        : '<p class="empty">' + T('noDataYet') + '</p>';
    }
  }

  /** 渲染笔顺书写记录 */
  function renderStrokeRecords() {
    var sumBox = document.getElementById('stroke-summary');
    var listBox = document.getElementById('stroke-records');
    if (!sumBox || !window.StrokeScore) return;
    var s = window.StrokeScore.summary();
    if (!s.practiced) {
      sumBox.innerHTML = '<p class="empty">' + T('noStrokeRecord') + '</p>';
      listBox.innerHTML = '';
      return;
    }
    sumBox.innerHTML =
      '<div class="stat-cell"><div class="stat-num">' + s.practiced + '</div>' +
        '<div class="stat-lbl">' + T('strokePracticed') + '</div></div>' +
      '<div class="stat-cell"><div class="stat-num">' + s.avgStars + '</div>' +
        '<div class="stat-lbl">' + T('avgStars') + '</div></div>' +
      '<div class="stat-cell"><div class="stat-num">' + s.perfect + '</div>' +
        '<div class="stat-lbl">' + T('strokePerfect') + '</div></div>';

    var recs = Object.keys(s.records).map(function (k) { return s.records[k]; })
      .sort(function (a, b) { return b.at - a.at; }).slice(0, 30);
    listBox.innerHTML = recs.map(function (r) {
      var stars = '';
      stars = starRow(r.stars);
      return '<div class="stroke-row">' +
        '<span class="sr-char">' + esc(r.ch) + '</span>' +
        '<span class="sr-stars">' + stars + '</span>' +
        '<span class="sr-meta">' + r.orderPct + '% · ' +
          r.correct + '/' + r.total + ' · ' +
          (r.mistakes > 0 ? T('mistakes') + ' ' + r.mistakes : ico('check','inline-ico')) +
        '</span>' +
      '</div>';
    }).join('');

    var cb = document.getElementById('btn-clear-stroke');
    if (cb) {
      cb.onclick = function () {
        if (confirm(T('confirmClearStroke'))) {
          window.StrokeScore.clear();
          renderStrokeRecords();
        }
      };
    }
  }

  /** 渲染错词本 */
  function renderWrongList() {
    var box = document.getElementById('wrong-list');
    if (!box || !window.Settings) return;
    var list = window.Settings.getWrongList();
    if (!list.length) {
      box.innerHTML = '<p class="empty">' + T('noWrong') + '</p>';
      return;
    }
    var lookup = {};
    allWords().forEach(function (v) { lookup[v.hanzi] = v; });
    box.innerHTML = list.slice(0, 40).map(function (r) {
      var v = lookup[r.word] || {};
      var src = Object.keys(r.data.sources || {}).join('/');
      return '<div class="wrong-row">' +
        '<span class="wrong-char">' + esc(r.word) + '</span>' +
        '<span class="wrong-py">' + esc(v.pinyin || '') + '</span>' +
        (v.han_viet ? '<span class="wrong-hv">' + ico('globe','inline-ico') + esc(v.han_viet) + '</span>' : '') +
        '<span class="wrong-meta">×' + r.data.count +
          (src ? ' · ' + esc(src) : '') + '</span>' +
        '<button class="wrong-play" data-word="' + esc(r.word) + '">' + ico('volume','inline-ico') + '</button>' +
      '</div>';
    }).join('');
    box.querySelectorAll('.wrong-play').forEach(function (b) {
      b.addEventListener('click', function () {
        var w = b.dataset.word;
        var v = lookup[w] || {};
        speak(w, { audioKey: v.has_audio ? ('w_' + w) : null });
      });
    });
    var cb = document.getElementById('btn-clear-wrong');
    if (cb) {
      cb.onclick = function () {
        if (confirm(T('confirmClearWrong'))) {
          window.Settings.clearAllWrong();
          renderWrongList();
          renderStats();
        }
      };
    }
  }

  function renderResetButtons() {
    var box = document.getElementById('reset-levels');
    if (!box) return;
    box.innerHTML = Object.keys(LEVELS).sort().map(function (lv) {
      return '<button class="btn btn-outline btn-sm" data-reset-lv="' + lv +
        '">HSK ' + lv + '</button>';
    }).join('');
    box.querySelectorAll('[data-reset-lv]').forEach(function (b) {
      b.addEventListener('click', function () {
        var lv = b.dataset.resetLv;
        if (confirm(T('confirmResetLevel').replace('%s', lv))) {
          var n = window.Settings.resetLevel(lv);
          toast(T('resetLevelDone').replace('%s', lv + ' (' + n + ')'));
          renderStats();
          renderSrsStats();
          updateBadge();
        }
      });
    });
  }

  /** 轻提示 */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  // ------------------------------------------------------------ 听写模式
  // 目标：只听发音，学员自己写出汉字——补上「认」这一环的主动回忆。
  var dictNextTimer = 0;

  function initDictation() {
    document.getElementById('dict-area').innerHTML =
      '<div class="quiz-intro">' +
        '<div class="quiz-intro-icon">' + ico('headphones','intro-ico') + '</div>' +
        '<p class="quiz-intro-text">' + T('dictIntro') + '</p>' +
        '<button id="dict-start" class="btn btn-primary btn-large">' +
          T('dictStart') + '</button>' +
      '</div>';
    document.getElementById('dict-start').addEventListener('click', startDictation);
  }

  function startDictation() {
    var pool = VOCAB.length ? VOCAB : allWords();
    var D = window.Dictation.STATE;
    D.queue = window.Dictation.buildQueue(pool, 10);
    D.idx = 0; D.correct = 0; D.partial = 0; D.wrong = 0;
    renderDictation();
  }

  function renderDictation() {
    var box = document.getElementById('dict-area');
    var D = window.Dictation.STATE;

    if (D.idx >= D.queue.length) {
      var pct = Math.round(D.correct / D.queue.length * 100);
      box.innerHTML = '<div class="quiz-result">' +
        resultRing(pct) +
        '<div class="result-score">' + D.correct +
          '<span>/' + D.queue.length + '</span></div>' +
        '<div class="result-pct">' +
          T('dictPartial') + ' ' + D.partial +
          ' · ' + T('dictWrong') + ' ' + D.wrong + '</div>' +
        '<div class="dict-result-actions">' +
          '<button id="dict-again" class="btn btn-primary">' + T('again') + '</button>' +
          '<button id="dict-exit" class="btn btn-outline">' + T('home') + '</button>' +
        '</div>' +
        '</div>';
      document.getElementById('dict-again').addEventListener('click', startDictation);
      var exitBtn = document.getElementById('dict-exit');
      if (exitBtn) exitBtn.addEventListener('click', function () { goto('home'); });
      logPractice('dictation');
      return;
    }

    var w = D.queue[D.idx];
    var bare = (w.hanzi || '').replace(/[^一-鿿]/g, '');
    var cands = bare.split('').map(function (ch) {
      return { ch: ch, opts: window.Dictation.charCandidates(ch, VOCAB, 4) };
    });
    var prog = Math.round(D.idx / D.queue.length * 100);

    box.innerHTML =
      '<div class="dict-card">' +
        '<div class="quiz-top">' +
          '<span class="quiz-count">' + T('dictProgress') + ' ' +
            (D.idx + 1) + '/' + D.queue.length + '</span>' +
          '<span class="quiz-progress">' + prog + '%</span>' +
        '</div>' +
        '<div class="quiz-progressbar"><i style="width:' + prog + '%"></i></div>' +

        '<button id="dict-play" class="dict-play">' + ico('volume','inline-ico') + '</button>' +
        '<div class="dict-hint">' + T('dictHint') + '</div>' +

        // 逐字作答区
        '<div class="dict-slots">' + cands.map(function (c, i) {
          return '<div class="dict-slot" data-slot="' + i + '" data-answer="' +
            esc(c.ch) + '">' +
            '<span class="slot-char">?</span>' +
            '<div class="slot-opts">' + c.opts.map(function (o) {
              return '<button class="slot-opt" data-ch="' + esc(o) +
                '" data-slot="' + i + '">' + esc(o) + '</button>';
            }).join('') + '</div>' +
          '</div>';
        }).join('') + '</div>' +

        '<div class="dict-actions">' +
          '<button id="dict-submit" class="btn btn-primary">' + T('dictSubmit') + '</button>' +
          '<button id="dict-reveal" class="btn btn-outline">' + T('dictReveal') + '</button>' +
        '</div>' +
        '<div id="dict-feedback" class="dict-feedback"></div>' +
      '</div>';

    var picked = {};
    // 播放发音
    var playBtn = document.getElementById('dict-play');
    var doPlay = function () {
      speak(w.hanzi, { audioKey: w.has_audio ? ('w_' + w.hanzi) : null });
    };
    playBtn.addEventListener('click', doPlay);
    // 登记句柄：切走分区时能被取消
    if (dictPlayTimer) clearTimeout(dictPlayTimer);
    dictPlayTimer = setTimeout(function () { dictPlayTimer = 0; doPlay(); }, 260);  // 进入题目自动播一次

    box.querySelectorAll('.slot-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var si = b.dataset.slot;
        picked[si] = b.dataset.ch;
        box.querySelectorAll('.dict-slot').forEach(function (s) {
          if (+s.dataset.slot === +si) {
            s.querySelector('.slot-char').textContent = b.dataset.ch;
            s.classList.add('filled');
          }
        });
        box.querySelectorAll('.slot-opt').forEach(function (x) {
          if (x.dataset.slot === si) x.classList.remove('picked');
        });
        b.classList.add('picked');
      });
    });

    var fb = document.getElementById('dict-feedback');
    var submit = document.getElementById('dict-submit');
    submit.addEventListener('click', function () {
      var input = cands.map(function (c, i) { return picked[i] || ''; }).join('');
      var r = window.Dictation.grade(input, w.hanzi);
      D.correct += r.level === 'correct' ? 1 : 0;
      D.partial += r.level === 'partial' ? 1 : 0;
      D.wrong += r.level === 'wrong' ? 1 : 0;

      if (r.level === 'correct') {
        fb.className = 'dict-feedback ok';
        fb.innerHTML = ico('circle-check','fb-ico') + T('dictCorrect');
        if (window.Settings) window.Settings.clearWrong(w.hanzi);
        window.SRS.review(w.hanzi, 5);
      } else {
        fb.className = 'dict-feedback ng';
        var tag = r.level === 'partial' ? 'circle-alert' : 'circle-x';
        fb.innerHTML = ico(tag,'fb-ico') + T('dictAnswer') + ': <b>' + esc(w.hanzi) +
          '</b> (' + esc(w.pinyin) + ')' +
          (w.han_viet ? ' · ' + ico('globe','inline-ico') + esc(w.han_viet) : '');
        if (window.Settings) window.Settings.addWrong(w.hanzi, 'dictation');
        window.SRS.review(w.hanzi, 1);
      }
      submit.disabled = true;
      box.querySelectorAll('.slot-opt').forEach(function (x) { x.disabled = true; });
      scheduleNextDictation();
    });

    document.getElementById('dict-reveal').addEventListener('click', function () {
      box.querySelectorAll('.dict-slot').forEach(function (s, i) {
        s.querySelector('.slot-char').textContent = cands[i].ch;
        s.classList.add('revealed');
      });
      if (window.Settings) window.Settings.addWrong(w.hanzi, 'dictation');
      fb.className = 'dict-feedback ng';
      fb.innerHTML = T('dictAnswer') + ': <b>' + esc(w.hanzi) + '</b> (' +
        esc(w.pinyin) + ')' + (w.vi ? ' · ' + esc(w.vi) : '');
      submit.disabled = true;
      box.querySelectorAll('.slot-opt').forEach(function (x) { x.disabled = true; });

      // 看答案后必须**自动进入下一题**。
      // 原来这里只禁用了按钮和选项、没有推进题目，
      // 页面就停在原地、没有任何可点的东西 —— 表现为「卡死、不能退出」。
      // 点「检查」之所以正常，是因为它带了 setTimeout 自动下一题；
      // 看答案少了这一步。补上后行为与检查一致。
      scheduleNextDictation();
    });
  }

  /** 延迟进入下一题（检查 / 看答案 共用）。用变量存句柄，便于取消。 */
  function scheduleNextDictation() {
    if (dictNextTimer) clearTimeout(dictNextTimer);
    var D = window.Dictation.STATE;
    dictNextTimer = setTimeout(function () {
      dictNextTimer = 0;
      D.idx++;
      renderDictation();
    }, 1900);
  }

  /** 搜索改为跨全部等级（学员查词不应受当前等级限制） */
  function searchAll(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return VOCAB;
    var all = allWords();
    return all.filter(function (v) {
      return (v.hanzi + ' ' + v.pinyin + ' ' + v.vi + ' ' + v.en + ' ' + v.han_viet)
        .toLowerCase().indexOf(q) !== -1;
    });
  }

  // ------------------------------------------------------------ 每日目标
  /** 刷新首页目标徽标 */
  function refreshGoalBadge() {
    var box = document.getElementById('goal-widget');
    if (!box || !window.DailyGoal) return;
    renderGoalWidget(box);
  }

  function renderGoalWidget(box) {
    var t = window.DailyGoal.today();
    var g = window.DailyGoal.getGoal();
    var streak = window.DailyGoal.computeStreak();
    var items = t.items.map(function (i) {
      var done = Math.min(i.done, i.goal);
      var pct = i.goal > 0 ? Math.round(done / i.goal * 100) : 0;
      return '<div class="goal-item">' +
        '<span class="goal-ico">' + ico(pct >= 100 ? 'circle-check' : 'circle','goal-ico-svg') + '</span>' +
        '<span class="goal-lbl">' + T(i.label) + '</span>' +
        '<span class="goal-num">' + i.done + '/' + i.goal + '</span>' +
        '<span class="goal-bar"><i style="width:' + pct + '%"></i></span>' +
      '</div>';
    }).join('');
    var recent = window.DailyGoal.recent(7);
    var dots = recent.map(function (d) {
      return '<span class="day-dot' + (d.achieved ? ' on' : '') +
        '" title="' + d.label + '"></span>';
    }).join('');

    var learned = Object.keys(progress.learned).length;
    var total = (window.APP_DATA && window.APP_DATA.meta)
      ? window.APP_DATA.meta.vocabTotal : 0;
    box.innerHTML =
      '<div class="goal-overview">' +
        '<span>' + T('learnedTotal') + ' <b>' + learned + '</b>' +
          (total ? ' / ' + total : '') + '</span>' +
        '<span>' + T('totalWords') + ' <b>' + total + '</b></span>' +
      '</div>' +
      '<div class="goal-head">' +
        '<div class="goal-title">' + T('dailyGoal') + '</div>' +
        '<div class="goal-ring" style="--pct:' + t.pct + '">' +
          '<span>' + t.pct + '%</span></div>' +
      '</div>' +
      '<div class="goal-items">' + items + '</div>' +
      '<div class="goal-foot">' +
        '<span class="streak">' + ico('flame','streak-ico') + T('streak') + ' <b>' + streak + '</b>' +
          ' · ' + T('best') + ' ' + (g.best || 0) + '</span>' +
        '<span class="goal-days">' + dots + '</span>' +
      '</div>';
  }

  /** 打开目标设置 */
  function openGoalSettings() {
    var box = document.getElementById('goal-settings');
    if (!box) return;
    var t = window.DailyGoal.getGoal().target;
    var keys = ['newWords', 'review', 'listen', 'dictation'];
    box.innerHTML =
      '<div class="settings-title">' + T('goalSettings') + '</div>' +
      '<div class="goal-edit">' + keys.map(function (k) {
        return '<label class="goal-edit-row">' +
          '<span>' + T(k) + '</span>' +
          '<input type="number" min="0" max="200" value="' + t[k] +
            '" data-gtarget="' + k + '">' +
        '</label>';
      }).join('') + '</div>' +
      '<button id="goal-save" class="btn btn-primary btn-sm">' + T('save') + '</button>';
    document.getElementById('goal-save').addEventListener('click', function () {
      var patch = {};
      box.querySelectorAll('[data-gtarget]').forEach(function (i) {
        patch[i.dataset.gtarget] = i.value;
      });
      window.DailyGoal.setTarget(patch);
      renderGoalWidget(document.getElementById('goal-widget'));
      toast(T('goalSaved'));
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // 发音评测：暴露给回归测试与 Android 桥接使用
  window.__openAssess = openAssess;
  window.__closeAssess = closeAssess;
  window.__renderAssess = function (result) {
    if (!assessTarget) assessTarget = { text: '', pinyin: '', audioKey: null };
    renderAssess(result);
  };

  window.__onAndroidBack = function () {
    var am = document.getElementById('assess-modal');
    if (am && am.classList.contains('open')) { closeAssess(); return 'true'; }
    var vm = document.getElementById('vocab-modal');
    if (vm && vm.classList.contains('open')) { closeVocabCard(); return 'true'; }
    var modal = document.getElementById('stroke-modal');
    if (modal && modal.classList.contains('open')) { closeStroke(); return 'true'; }
    var panel = document.getElementById('nav-more');
    if (panel && panel.classList.contains('open')) { closeMorePanel(); return 'true'; }
    var active = document.querySelector('.section.active');
    if (active && active.id !== 'home') { goto('home'); return 'true'; }
    return 'false';
  };

  document.addEventListener('DOMContentLoaded', function () {
    // ---- 存储层先初始化 ----
    // 写失败必须**可见**：iOS Safari 无痕模式 / 存储配额满时，
    // 学习进度会静默丢失，学员只看到「关掉就没了」，却不知道原因。
    if (window.Store) {
      window.Store.onError(function (msg) {
        toast(T('storageFull',
          'Không lưu được dữ liệu — bộ nhớ trình duyệt có thể đã đầy. '
          + 'Hãy xóa bớt dữ liệu trình duyệt hoặc tắt chế độ riêng tư.'));
      });
      // 数据结构升级（老版本的数据补齐缺省字段）
      try { window.Store.migrate(); } catch (e) { /* 迁移失败不能挡住启动 */ }
      // 清理过期的每日记录，避免按天建键无限膨胀
      try { window.Store.pruneDaily(); } catch (e) { /* 同上 */ }
    }
    VOCAB = LEVELS[currentLevel] || [];
    initNav();
    renderLevelTabs();
    initSearch();
    initStrokeModal();
    initVocabModal();
    initAssess();
    initPinyin();
    initCourses();
    initQuiz();
    renderVocab('');
    renderHanzi('');
    renderSrsStats();
    initSettings();
    initDictation();
    refreshGoalBadge();
    openGoalSettings();
    updateBadge();
    window.I18N.apply();
    var vc = document.getElementById('vocab-count');
    if (vc) vc.textContent = VOCAB.length;
    var sb = document.getElementById('srs-start');
    if (sb) sb.addEventListener('click', startSrs);
    // 先判定运行环境（APK / 浏览器），影响页头是否做安全区避让
    markRuntime();
    // 语言切换按钮（只有中文 / 越南语两种）
    initLangToggle();
  });
})();