/**
 * store.js — 持久化存储的统一入口
 *
 * ## 为什么要有这一层
 *
 * 之前每个模块自己 `localStorage.getItem/setItem`，
 * 带来三个老问题：
 *
 * 1. **写失败是静默的**。`try { setItem } catch {}` 一把吞掉，
 *    在「存储空间已满」（iOS Safari 隐私模式、无痕模式）时，
 *    学员的学习进度**全部存不下去**，界面却毫无提示 ——
 *    关掉重开发现白学一场，投诉都说不清。
 *    现在写失败会触发 `Store.onError` 回调，由 app.js 弹 toast。
 *
 * 2. **没有版本号**。数据结构一变，老用户的数据就成了脏数据，
 *    且无法区分「没数据」和「数据是旧格式」。
 *    现在有 `vietchinese.schema` 版本号 + 迁移链。
 *
 * 3. **键名散落各处**，`resetAll()` 想清干净都做不到
 *    （以前只删了 3 个键，`daily.*`、`goal`、`strokerecord` 全留下了）。
 *    现在所有键登记在 `KEYS` 里，清除与导出都有唯一依据。
 *
 * ## 用法
 *
 *   var data = Store.getJSON(Store.KEYS.srs, {});
 *   Store.setJSON(Store.KEYS.srs, data);
 *
 * 字符串型用 `Store.get/set`（语言、代理地址这类）。
 */
(function (global) {
  'use strict';

  /** 数据结构版本号。改动数据结构时 +1，并在 MIGRATIONS 里补一条迁移。 */
  var CURRENT_VERSION = 2;

  var VERSION_KEY = 'vietchinese.schema';

  /**
   * 键注册表 —— 所有持久化键的唯一来源。
   * 改这里的值等于改键名，必须同时写一条迁移，否则老用户数据会丢。
   */
  var KEYS = {
    progress:     'vietchinese.progress.v1',
    srs:          'srs',
    lang:         'vietchinese.lang',
    wrong:        'vietchinese.wrong',
    goal:         'vietchinese.goal',
    strokeRecord: 'vietchinese.strokerecord',
    iseEndpoint:  'vietchinese.iseEndpoint',
    iseProxyKey:  'vietchinese.iseProxyKey',
  };

  /** 按天存储的前缀：vietchinese.daily.YYYY-MM-DD */
  var DAILY_PREFIX = 'vietchinese.daily.';

  /**
   * 每日记录保留天数上限。
   *
   * 之前按天建键且**没有上限**，用一年就会多出 365 个键；
   * 且 `computeStreak()` 最多回溯 400 天，
   * 所以保留 400 天既够算连续天数，又不会无限膨胀。
   */
  var MAX_DAILY_DAYS = 400;

  var errorHandlers = [];

  // ------------------------------------------------------------ 错误上报

  function reportError(op, key, err) {
    var msg = '存储操作失败（' + op + ' · ' + key + '）';
    for (var i = 0; i < errorHandlers.length; i++) {
      try { errorHandlers[i](msg, err); } catch (x) { /* 处理器本身出错也不能影响主流程 */ }
    }
    if (global.console && console.warn) {
      console.warn('[store] ' + msg, err);
    }
  }

  /**
   * 注册存储错误回调（app.js 用它弹 toast）。
   * @param {function(string, Error)} fn
   */
  function onError(fn) {
    if (typeof fn === 'function') errorHandlers.push(fn);
  }

  // ------------------------------------------------------------ 基础读写

  function get(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      reportError('read', key, e);
      return fallback;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(key, String(value));
      return true;
    } catch (e) {
      // 最常见的是 QuotaExceededError（存储已满 / 无痕模式）
      reportError('write', key, e);
      return false;
    }
  }

  function remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      reportError('remove', key, e);
      return false;
    }
  }

  function getJSON(key, fallback) {
    var raw = get(key, null);
    if (raw === null || raw === '') return fallback;
    try {
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) {
      // 数据损坏：宁可退回默认值，也不要让整个模块崩掉
      reportError('parse', key, e);
      return fallback;
    }
  }

  function setJSON(key, value) {
    var text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      reportError('serialize', key, e);
      return false;
    }
    return set(key, text);
  }

  // ------------------------------------------------------------ 每日记录

  /** YYYY-MM-DD（本地时区） */
  function dayKey(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' +
      (m < 10 ? '0' + m : m) + '-' +
      (day < 10 ? '0' + day : day);
  }

  function dailyKeys() {
    var list = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(DAILY_PREFIX) === 0) list.push(k);
      }
    } catch (e) {
      reportError('scan', DAILY_PREFIX, e);
    }
    return list;
  }

  /**
   * 清理过期的每日记录。
   * @returns {number} 清掉的条数
   */
  function pruneDaily(maxDays) {
    maxDays = maxDays || MAX_DAILY_DAYS;
    var cutoff = dayKey(new Date(Date.now() - maxDays * 86400000));
    var n = 0;
    dailyKeys().forEach(function (k) {
      var date = k.slice(DAILY_PREFIX.length);
      // YYYY-MM-DD 字典序即时间序，直接比较即可
      if (date < cutoff) {
        if (remove(k)) n++;
      }
    });
    return n;
  }

  // ------------------------------------------------------------ 迁移

  /**
   * 版本迁移链。
   * MIGRATIONS[n] 负责把数据从版本 n-1 升到 n。
   */
  var MIGRATIONS = {
    // v1 → v2：早期版本的 SRS 卡片字段不全（只有 interval / ease），
    // 缺 due 会让「今日待复习」列表算错，缺 reps 会让间隔曲线错乱。
    // 这里把缺的字段补齐，不改动已有值。
    2: function () {
      var srs = getJSON(KEYS.srs, {});
      var changed = false;
      Object.keys(srs).forEach(function (w) {
        var c = srs[w];
        if (!c || typeof c !== 'object') {
          delete srs[w];
          changed = true;
          return;
        }
        if (typeof c.ease !== 'number' || !isFinite(c.ease)) { c.ease = 2.5; changed = true; }
        if (typeof c.interval !== 'number' || !isFinite(c.interval)) { c.interval = 0; changed = true; }
        if (typeof c.reps !== 'number' || !isFinite(c.reps)) { c.reps = 0; changed = true; }
        if (typeof c.due !== 'number' || !isFinite(c.due)) { c.due = 0; changed = true; }
        if (typeof c.lapses !== 'number' || !isFinite(c.lapses)) { c.lapses = 0; changed = true; }
      });
      if (changed) setJSON(KEYS.srs, srs);
    },
  };

  /**
   * 执行迁移。幂等：版本已是最新时什么都不做。
   * @returns {number} 迁移后的版本号
   */
  function migrate() {
    var v = 0;
    try {
      v = parseInt(localStorage.getItem(VERSION_KEY), 10) || 0;
    } catch (e) {
      v = 0;
    }
    if (v >= CURRENT_VERSION) return v;
    for (var n = v + 1; n <= CURRENT_VERSION; n++) {
      var fn = MIGRATIONS[n];
      if (typeof fn === 'function') {
        try {
          fn();
        } catch (e) {
          reportError('migrate', 'v' + n, e);
        }
      }
    }
    set(VERSION_KEY, String(CURRENT_VERSION));
    return CURRENT_VERSION;
  }

  function version() {
    try {
      return parseInt(localStorage.getItem(VERSION_KEY), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  // ------------------------------------------------------------ 批量操作

  /** 全部受管键（含每日记录） */
  function allKeys() {
    var list = [];
    Object.keys(KEYS).forEach(function (name) {
      if (list.indexOf(KEYS[name]) === -1) list.push(KEYS[name]);
    });
    return list.concat(dailyKeys());
  }

  /**
   * 清空全部学习数据。
   * 之前只删了 3 个键，daily.* / goal / strokerecord / iseEndpoint 全留在原地，
   * 结果是「重置了但每日目标还是满的」「重置了但端点还在」。
   * @returns {number} 清掉的键数
   */
  function resetAll() {
    var n = 0;
    allKeys().forEach(function (k) {
      if (remove(k)) n++;
    });
    remove(VERSION_KEY);
    return n;
  }

  /** 存储占用概览（设置页可展示） */
  function stats() {
    var bytes = 0;
    var count = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        count++;
        var v = localStorage.getItem(k);
        bytes += (k.length + (v ? v.length : 0)) * 2;   // UTF-16
      }
    } catch (e) {
      reportError('stats', '*', e);
    }
    return { keys: count, bytes: bytes, version: version() };
  }

  global.Store = {
    CURRENT_VERSION: CURRENT_VERSION,
    KEYS: KEYS,
    DAILY_PREFIX: DAILY_PREFIX,
    MAX_DAILY_DAYS: MAX_DAILY_DAYS,
    get: get,
    set: set,
    remove: remove,
    getJSON: getJSON,
    setJSON: setJSON,
    dayKey: dayKey,
    dailyKeys: dailyKeys,
    pruneDaily: pruneDaily,
    migrate: migrate,
    version: version,
    allKeys: allKeys,
    resetAll: resetAll,
    stats: stats,
    onError: onError,
  };
})(window);
