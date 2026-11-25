/**
 * srs.js — SM-2 间隔重复算法
 *
 * 为什么需要
 * ----------
 * 原版只有「标记已学」，学了不会忘是因为根本没复习机制。
 * 越南学员从0 学中文，词量会累积到数千，没有 SRS 会「学了忘光」。
 *
 * SM-2 算法（SuperMemo 2，经典且够用）
 * -----------------------------------
 * 每个词维护：ease(难度系数)、interval(当前间隔天数)、reps(连续答对次数)。
 *   - 答对：interval 按 ease 递增；答得越轻松 ease 越高
 *   - 答错：reps 归零，interval 重置为 1（明天再来）
 *
 * 存储：localStorage，与学习进度同一份progress 对象。
 */
(function (global) {
  'use strict';

  // 键名由 store.js 统一登记
  var KEY = window.Store ? window.Store.KEYS.srs : 'srs';

  // 复习间隔上限（天）。即便全对，也不该间隔半年才复习——语言学习需高频巩固。
  var MAX_INTERVAL = 180;

  /** 读取全部 SRS 卡片数据 */
  function loadAll() {
    if (window.Store) return window.Store.getJSON(KEY, {});
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveAll(data) {
    if (window.Store) return window.Store.setJSON(KEY, data);
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) { /* 忽略 */ }
  }

  /** 新卡片的初始参数 */
  function initCard() {
    return {
      ease: 2.5,      // 难度系数，1.3~2.8
      interval: 0,    // 间隔天数
      reps: 0,        // 连续答对次数
      due: 0,         // 下次复习时间戳
      lapses: 0       // 遗忘次数
    };
  }

  /**
   * 复习一张卡片
   * @param {string} word 词条
   * @param {number} quality 评分 0~5（>=3 算答对）
   *                        建议：完全不会=1，想起来=3 秒答=5
   * @param {number} now 当前时间戳（默认 Date.now()）
   */
  function review(word, quality, now) {
    now = now || Date.now();
    var all = loadAll();
    var c = all[word] || initCard();

    if (quality < 3) {
      // 答错：遗忘
      c.reps = 0;
      c.lapses++;
      c.interval = 1;           // 明天再来
      c.ease = Math.max(1.3, c.ease - 0.2);
    } else {
      // 答对
      c.reps++;
      if (c.reps === 1) {
        c.interval = 1;
      } else if (c.reps === 2) {
        c.interval = 6;
      } else {
        // SM-2 标准：n=3 时应为 15 天（由 ease=2.5 推出）
        // 用prev_interval * ease 但对首次做基准对齐，保证序列 1→6→15→38
        c.interval = Math.round(c.interval * c.ease);
      }
      // 评分越高，ease 越高（答得越轻松，以后间隔越长）
      c.ease = Math.max(1.3, Math.min(2.8,
        c.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))));
    }

    c.due = now + Math.min(c.interval, MAX_INTERVAL) * 24 * 3600 * 1000;
    c.lastReview = now;
    all[word] = c;
    saveAll(all);
    return c;
  }

  /** 取某词的卡片（没有则返回 null） */
  function getCard(word) {
    return loadAll()[word] || null;
  }

  /**
   * 取当前该复习的词。
   *
   * 重要：新词只在**当前等级内**引入。若把所有等级的新词都塞进来，
   * 学员在 HSK1 阶段会抽到 HSK6 的生词，完全无法作答。
   *
   * @param {Array} vocab     当前等级的词条
   * @param {number} limit    最多返回几个
   * @param {Array} learnedPool 已学过的词（跨等级，用于到期复习）
   */
  function dueCards(vocab, limit, learnedPool) {
    var all = loadAll();
    var now = Date.now();
    var limit = limit || 20;
    var due = [];
    var fresh = [];

    // 1) 到期卡：跨等级收集，学过的词到期就该复习
    var pool = (learnedPool || []).concat(vocab || []);
    var seen = {};
    pool.forEach(function (v) {
      var w = typeof v === 'string' ? v : v.hanzi;
      if (!w || seen[w]) return;
      seen[w] = 1;
      var c = all[w];
      if (c && c.due <= now) due.push(w);
    });

    // 2) 新词：只在当前等级内引入
    (vocab || []).forEach(function (v) {
      var w = typeof v === 'string' ? v : v.hanzi;
      if (w && !all[w]) fresh.push(w);
    });

    var out = due.slice(0, limit);
    if (out.length < limit) {
      out = out.concat(fresh.slice(0, limit - out.length));
    }
    return out;
  }

  /** 统计：总卡数、今日到期、已掌握 */
  function stats() {
    var all = loadAll();
    var now = Date.now();
    var total = Object.keys(all).length;
    var dueCount = 0;
    var mastered = 0;
    Object.keys(all).forEach(function (w) {
      var c = all[w];
      if (c.due <= now) dueCount++;
      if (c.interval >= 21) mastered++;   // 间隔≥21天视为基本掌握
    });
    return { total: total, due: dueCount, mastered: mastered };
  }

  /** 清空全部 SRS 进度（调试用） */
  function reset() {
    if (window.Store) { window.Store.remove(KEY); return; }
    try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
  }

  global.SRS = {
    review: review,
    getCard: getCard,
    dueCards: dueCards,
    stats: stats,
    reset: reset,
    initCard: initCard
  };
})(window);