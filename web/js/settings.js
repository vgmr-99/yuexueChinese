/**
 * settings.js — 设置与学习数据管理
 *
 * 真实用户诉求（站在使用者角度）：
 *   1. 学习了一堆天，想知道「我到底学了多少」→ 统计面板
 *   2. 换手机 / 怕数据丢 → 导出备份（纯文本，可复制）
 *   3. 选错了等级想重来 → 分级重置进度
 *   4. 界面语言、发音偏好 → 常驻设置
 *
 * 全部数据都在 localStorage，导出为 JSON 文本，
 * 学员可用微信/邮件发给另一台设备导入。
 *
 * 存储读写统一走 store.js（键注册表 + 版本迁移 + 写失败上报）。
 */
(function (global) {
  'use strict';

  // 键名由 store.js 统一登记
  var PROGRESS_KEY = global.Store ? global.Store.KEYS.progress : 'vietchinese.progress.v1';
  var SRS_KEY = global.Store ? global.Store.KEYS.srs : 'srs';
  var LANG_KEY = global.Store ? global.Store.KEYS.lang : 'vietchinese.lang';
  var WRONG_KEY = global.Store ? global.Store.KEYS.wrong : 'vietchinese.wrong';
  var GOAL_KEY = global.Store ? global.Store.KEYS.goal : 'vietchinese.goal';
  var STROKE_KEY = global.Store ? global.Store.KEYS.strokeRecord : 'vietchinese.strokerecord';
  var DAILY_PREFIX = global.Store ? global.Store.DAILY_PREFIX : 'vietchinese.daily.';

  /** 导出时包含最近多少天的每日记录（再多就没必要了，占体积） */
  var EXPORT_DAILY_DAYS = 90;

  function readJSON(key, fallback) {
    if (global.Store) return global.Store.getJSON(key, fallback);
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, val) {
    if (global.Store) return global.Store.setJSON(key, val);
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeKey(key) {
    if (global.Store) { global.Store.remove(key); return; }
    try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  // ------------------------------------------------------------ 类型校验
  //
  // 导入的数据来自用户手抄/转发/文件，可能被截断、被手改、被旧版本污染。
  // 直接把任意 JSON 灌进状态层，轻则页面报错，重则污染 SRS 间隔曲线。
  // 这里对每个字段做白名单式校验，**不合法的条目直接丢弃**，
  // 而不是让整份导入失败。

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isFiniteNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 学习记录：{词条: 时间戳} */
  function sanitizeLearned(src) {
    var out = {};
    if (!isPlainObject(src)) return out;
    Object.keys(src).forEach(function (w) {
      var t = src[w];
      if (typeof t === 'number' && isFinite(t)) out[w] = t;
      else if (typeof t === 'string') {
        var n = parseInt(t, 10);
        if (isFinite(n)) out[w] = n;
      }
    });
    return out;
  }

  /** SRS 卡片：{ease, interval, reps, due, lapses, lastReview} */
  function sanitizeSrs(src) {
    var out = {};
    if (!isPlainObject(src)) return out;
    Object.keys(src).forEach(function (w) {
      var c = src[w];
      if (!isPlainObject(c)) return;
      var card = {};
      card.ease = isFiniteNum(c.ease) ? c.ease : 2.5;
      card.interval = isFiniteNum(c.interval) ? c.interval : 0;
      card.reps = isFiniteNum(c.reps) ? c.reps : 0;
      card.due = isFiniteNum(c.due) ? c.due : 0;
      card.lapses = isFiniteNum(c.lapses) ? c.lapses : 0;
      if (isFiniteNum(c.lastReview)) card.lastReview = c.lastReview;
      // interval 上限与 srs.js 的 MAX_INTERVAL 保持一致，防止被手改成 1e9
      if (card.interval > 180) card.interval = 180;
      if (card.interval < 0) card.interval = 0;
      out[w] = card;
    });
    return out;
  }

  /** 错词本：{词条: {count, sources:{}, lastAt}} */
  function sanitizeWrong(src) {
    var out = {};
    if (!isPlainObject(src)) return out;
    Object.keys(src).forEach(function (w) {
      var c = src[w];
      if (!isPlainObject(c)) return;
      var item = { count: isFiniteNum(c.count) ? Math.max(0, c.count) : 1, sources: {} };
      if (isPlainObject(c.sources)) {
        Object.keys(c.sources).forEach(function (k) {
          if (isFiniteNum(c.sources[k])) item.sources[k] = c.sources[k];
        });
      }
      if (isFiniteNum(c.lastAt)) item.lastAt = c.lastAt;
      out[w] = item;
    });
    return out;
  }

  /** 书写记录：{汉字: {ch,total,correct,mistakes,...}} */
  function sanitizeStrokes(src) {
    var out = {};
    if (!isPlainObject(src)) return out;
    Object.keys(src).forEach(function (ch) {
      var r = src[ch];
      if (!isPlainObject(r)) return;
      var total = isFiniteNum(r.total) ? r.total : 0;
      var correct = isFiniteNum(r.correct) ? r.correct : 0;
      out[ch] = {
        ch: typeof r.ch === 'string' ? r.ch : ch,
        total: total,
        correct: Math.min(correct, total || correct),
        mistakes: isFiniteNum(r.mistakes) ? r.mistakes : 0,
        attempts: isFiniteNum(r.attempts) ? r.attempts : 0,
        best: isFiniteNum(r.best) ? r.best : 0,
        updatedAt: isFiniteNum(r.updatedAt) ? r.updatedAt : 0,
      };
    });
    return out;
  }

  /** 每日目标配置 */
  function sanitizeGoal(src) {
    var def = global.DailyGoal ? global.DailyGoal.DEFAULT_GOAL
      : { newWords: 10, review: 20, listen: 5, dictation: 5 };
    if (!isPlainObject(src)) return null;
    var target = {};
    Object.keys(def).forEach(function (k) {
      var v = src.target ? src.target[k] : undefined;
      target[k] = isFiniteNum(v) && v >= 0 ? Math.min(9999, Math.round(v)) : def[k];
    });
    return {
      target: target,
      streak: isFiniteNum(src.streak) ? Math.max(0, src.streak) : 0,
      best: isFiniteNum(src.best) ? Math.max(0, src.best) : 0,
      lastDone: typeof src.lastDone === 'string' ? src.lastDone : '',
    };
  }

  /** 汇总学习统计 */
  function collectStats() {
    var progress = readJSON(PROGRESS_KEY, { learned: {} });
    var srs = readJSON(SRS_KEY, {});
    var learned = Object.keys(progress.learned || {});
    var now = Date.now();

    var due = 0, mastered = 0, learning = 0;
    Object.keys(srs).forEach(function (w) {
      var c = srs[w];
      if (c.due <= now) due++;
      if (c.interval >= 21) mastered++;
      else learning++;
    });

    // 连续学习天数
    var days = {};
    learned.forEach(function (w) {
      var d = new Date(progress.learned[w]);
      days[d.toDateString()] = 1;
    });
    var streak = Object.keys(days).length;

    // 各等级学习量
    var levels = global.APP_DATA && global.APP_DATA.levels ? global.APP_DATA.levels : {};
    var byLevel = {};
    learned.forEach(function (w) {
      Object.keys(levels).forEach(function (lv) {
        if (levels[lv].some(function (x) { return x.hanzi === w; })) {
          byLevel[lv] = (byLevel[lv] || 0) + 1;
        }
      });
    });

    return {
      learnedTotal: learned.length,
      srsTotal: Object.keys(srs).length,
      due: due, mastered: mastered, learning: learning,
      activeDays: streak,
      wrongTotal: Object.keys(readJSON(WRONG_KEY, {})).length,
      byLevel: byLevel,
    };
  }

  /** 导出全部学习数据为可复制的文本 */
  function exportData() {
    // 每日记录：只带最近 EXPORT_DAILY_DAYS 天
    var daily = {};
    var cutoff = global.Store
      ? global.Store.dayKey(new Date(Date.now() - EXPORT_DAILY_DAYS * 86400000))
      : '';
    (global.Store ? global.Store.dailyKeys() : []).forEach(function (k) {
      var date = k.slice(DAILY_PREFIX.length);
      if (cutoff && date < cutoff) return;
      daily[date] = readJSON(k, {});
    });

    var payload = {
      app: 'vietchinese',
      version: global.Store ? global.Store.CURRENT_VERSION : 1,
      exportedAt: new Date().toISOString(),
      progress: readJSON(PROGRESS_KEY, { learned: {} }),
      srs: readJSON(SRS_KEY, {}),
      wrong: readJSON(WRONG_KEY, {}),
      goal: readJSON(GOAL_KEY, null),
      strokes: readJSON(STROKE_KEY, {}),
      daily: daily,
      lang: (global.Store ? global.Store.get(LANG_KEY, null) : localStorage.getItem(LANG_KEY)) || 'vi',
      // 注意：**不导出**评测服务地址与代理口令。
      // 这份文本是要发给别人的，带上代理口令等于把服务端的口令公开。
    };
    return JSON.stringify(payload);
  }

  /**
   * 从导出的文本导入（会合并，不会丢已有数据）
   *
   * 所有字段都过一遍类型校验：不合法的条目直接丢弃，
   * 而不是把脏数据灌进 SRS 间隔曲线。
   */
  function importData(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, msg: 'invalid' };
    }
    if (!data || data.app !== 'vietchinese') {
      return { ok: false, msg: 'mismatch' };
    }

    // 合并学习记录（取较早的时间戳 = 更早学过）
    var cur = readJSON(PROGRESS_KEY, { learned: {} });
    if (!isPlainObject(cur.learned)) cur.learned = {};
    var inc = sanitizeLearned(data.progress && data.progress.learned);
    Object.keys(inc).forEach(function (w) {
      if (!cur.learned[w] || inc[w] < cur.learned[w]) {
        cur.learned[w] = inc[w];
      }
    });
    writeJSON(PROGRESS_KEY, cur);

    // 合并 SRS（保留间隔更长的一方）
    var curSrs = readJSON(SRS_KEY, {});
    if (!isPlainObject(curSrs)) curSrs = {};
    var incSrs = sanitizeSrs(data.srs);
    Object.keys(incSrs).forEach(function (w) {
      var a = curSrs[w], b = incSrs[w];
      if (!isPlainObject(a) || (b.interval || 0) > (a.interval || 0)) curSrs[w] = b;
    });
    writeJSON(SRS_KEY, curSrs);

    // 错词本：计数取大的一方
    var curWrong = readJSON(WRONG_KEY, {});
    if (!isPlainObject(curWrong)) curWrong = {};
    var incWrong = sanitizeWrong(data.wrong);
    Object.keys(incWrong).forEach(function (w) {
      var a = curWrong[w], b = incWrong[w];
      if (!isPlainObject(a) || (b.count || 0) > (a.count || 0)) curWrong[w] = b;
    });
    writeJSON(WRONG_KEY, curWrong);

    // 书写记录：次数更多的一方胜出
    var curStroke = readJSON(STROKE_KEY, {});
    if (!isPlainObject(curStroke)) curStroke = {};
    var incStroke = sanitizeStrokes(data.strokes);
    Object.keys(incStroke).forEach(function (ch) {
      var a = curStroke[ch], b = incStroke[ch];
      if (!isPlainObject(a) || (b.attempts || 0) > (a.attempts || 0)) curStroke[ch] = b;
    });
    writeJSON(STROKE_KEY, curStroke);

    // 每日目标：只在本地还没有配置时才用导入的覆盖
    if (!readJSON(GOAL_KEY, null)) {
      var g = sanitizeGoal(data.goal);
      if (g) writeJSON(GOAL_KEY, g);
    }

    // 每日记录：按天合并（取各项累加）
    if (isPlainObject(data.daily)) {
      Object.keys(data.daily).forEach(function (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        var incDay = data.daily[date];
        if (!isPlainObject(incDay)) return;
        var key = DAILY_PREFIX + date;
        var curDay = readJSON(key, {});
        if (!isPlainObject(curDay)) curDay = {};
        Object.keys(incDay).forEach(function (f) {
          if (isFiniteNum(incDay[f]) && f !== 'updatedAt') {
            curDay[f] = (isFiniteNum(curDay[f]) ? curDay[f] : 0) + incDay[f];
          }
        });
        curDay.updatedAt = Date.now();
        writeJSON(key, curDay);
      });
    }

    if (typeof data.lang === 'string' && data.lang) {
      if (global.Store) global.Store.set(LANG_KEY, data.lang);
      else { try { localStorage.setItem(LANG_KEY, data.lang); } catch (e) { /* 忽略 */ } }
    }
    return {
      ok: true,
      learned: Object.keys(cur.learned).length,
      srs: Object.keys(curSrs).length,
      wrong: Object.keys(curWrong).length,
    };
  }

  /** 重置某等级的学习进度（不动其他等级） */
  function resetLevel(level) {
    var levels = global.APP_DATA && global.APP_DATA.levels ? global.APP_DATA.levels : {};
    var words = (levels[level] || []).map(function (x) { return x.hanzi; });
    var set = {};
    words.forEach(function (w) { set[w] = 1; });

    var progress = readJSON(PROGRESS_KEY, { learned: {} });
    var removed = 0;
    Object.keys(progress.learned).forEach(function (w) {
      if (set[w]) { delete progress.learned[w]; removed++; }
    });
    writeJSON(PROGRESS_KEY, progress);

    var srs = readJSON(SRS_KEY, {});
    words.forEach(function (w) { delete srs[w]; });
    writeJSON(SRS_KEY, srs);

    var wrong = readJSON(WRONG_KEY, {});
    words.forEach(function (w) { delete wrong[w]; });
    writeJSON(WRONG_KEY, wrong);

    return removed;
  }

  /**
   * 清空全部学习数据（不可恢复，需二次确认）
   *
   * 之前只删了 3 个键，daily.* / goal / strokerecord 全留在原地，
   * 结果是「重置了但每日目标还是满的」「重置了但书写记录还在」。
   * 现在交给 store.js 的键注册表统一清，能删干净。
   *
   * @returns {number} 清掉的键数
   */
  function resetAll() {
    if (global.Store) return global.Store.resetAll();
    try {
      localStorage.removeItem(PROGRESS_KEY);
      localStorage.removeItem(SRS_KEY);
      localStorage.removeItem(WRONG_KEY);
      localStorage.removeItem(GOAL_KEY);
      localStorage.removeItem(STROKE_KEY);
      return 5;
    } catch (e) {
      return 0;
    }
  }

  // ------------------------------------------------------------ 错词本
  /**
   * 记录错词。
   * @param {string} word 词条
   * @param {string} from 来源：quiz / srs / dictation
   */
  function addWrong(word, from) {
    if (!word) return;
    var all = readJSON(WRONG_KEY, {});
    var cur = all[word] || { count: 0, sources: {} };
    cur.count++;
    cur.sources[from || 'quiz'] = (cur.sources[from || 'quiz'] || 0) + 1;
    cur.lastAt = Date.now();
    all[word] = cur;
    writeJSON(WRONG_KEY, all);
  }

  /** 取错词列表（按错误次数倒序） */
  function getWrongList() {
    var all = readJSON(WRONG_KEY, {});
    return Object.keys(all)
      .map(function (w) { return { word: w, data: all[w] }; })
      .sort(function (a, b) { return b.data.count - a.data.count; });
  }

  /** 答对一次就从错词本移除 */
  function clearWrong(word) {
    var all = readJSON(WRONG_KEY, {});
    delete all[word];
    writeJSON(WRONG_KEY, all);
  }

  function clearAllWrong() {
    removeKey(WRONG_KEY);
  }

  global.Settings = {
    collectStats: collectStats,
    exportData: exportData,
    importData: importData,
    resetLevel: resetLevel,
    resetAll: resetAll,
    addWrong: addWrong,
    getWrongList: getWrongList,
    clearWrong: clearWrong,
    clearAllWrong: clearAllWrong,
  };
})(window);