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
 */
(function (global) {
  'use strict';

  var PROGRESS_KEY = 'vietchinese.progress.v1';
  var SRS_KEY = 'srs';
  var LANG_KEY = 'vietchinese.lang';
  var WRONG_KEY = 'vietchinese.wrong';

  function readJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
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
    var payload = {
      app: 'vietchinese',
      version: 1,
      exportedAt: new Date().toISOString(),
      progress: readJSON(PROGRESS_KEY, { learned: {} }),
      srs: readJSON(SRS_KEY, {}),
      wrong: readJSON(WRONG_KEY, {}),
      lang: localStorage.getItem(LANG_KEY) || 'vi',
    };
    return JSON.stringify(payload);
  }

  /** 从导出的文本导入（会合并，不会丢已有数据） */
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
    var inc = (data.progress && data.progress.learned) || {};
    Object.keys(inc).forEach(function (w) {
      if (!cur.learned[w] || inc[w] < cur.learned[w]) {
        cur.learned[w] = inc[w];
      }
    });
    writeJSON(PROGRESS_KEY, cur);

    // 合并 SRS（保留间隔更长的一方）
    var curSrs = readJSON(SRS_KEY, {});
    var incSrs = data.srs || {};
    Object.keys(incSrs).forEach(function (w) {
      var a = curSrs[w], b = incSrs[w];
      if (!a || (b.interval || 0) > (a.interval || 0)) curSrs[w] = b;
    });
    writeJSON(SRS_KEY, curSrs);

    // 错词本：计数取大的一方
    var curWrong = readJSON(WRONG_KEY, {});
    var incWrong = data.wrong || {};
    Object.keys(incWrong).forEach(function (w) {
      var a = curWrong[w], b = incWrong[w];
      if (!a || (b.count || 0) > (a.count || 0)) curWrong[w] = b;
    });
    writeJSON(WRONG_KEY, curWrong);

    if (data.lang) {
      try { localStorage.setItem(LANG_KEY, data.lang); } catch (e) { /* 忽略 */ }
    }
    return { ok: true, learned: Object.keys(cur.learned).length };
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

  /** 清空全部学习数据（不可恢复，需二次确认） */
  function resetAll() {
    try {
      localStorage.removeItem(PROGRESS_KEY);
      localStorage.removeItem(SRS_KEY);
      localStorage.removeItem(WRONG_KEY);
      return true;
    } catch (e) {
      return false;
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
    try { localStorage.removeItem(WRONG_KEY); } catch (e) { /* 忽略 */ }
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