/**
 * dailyGoal.js — 每日学习目标与打卡
 *
 * 为什么需要
 * ----------
 * 语言学习是长线行为，最大的流失点是「不知道今天该做什么」和
 * 「看不到积累」。给学员一个**具体、够得着的每日目标**
 * （如「学 10 个新词 + 复习到期词」），配合连续天数与进度环，
 * 比单纯堆功能更能支撑坚持。
 *
 * 目标组成（可单独开关）
 * --------------------
 *   newWords  学新词数量
 *   review    复习数量（配合 SRS 到期）
 *   listen    听力练习（听写完成数）
 *   dictation 听写完成数
 *
 * 数据：localStorage vietchinese.daily.<YYYY-MM-DD> = {newWords, review, ...}
 * 另存 meta 记录当前目标配置与最长连续天数。
 */
(function (global) {
  'use strict';

  var DAY_KEY = 'vietchinese.daily.';      // + YYYY-MM-DD
  var META_KEY = 'vietchinese.goal';

  var DEFAULT_GOAL = {
    newWords: 10,
    review: 20,
    listen: 5,
    dictation: 5,
  };

  function todayStr(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' +
      (m < 10 ? '0' + m : m) + '-' +
      (day < 10 ? '0' + day : day);
  }

  function readDay(key) {
    try {
      return JSON.parse(localStorage.getItem(DAY_KEY + key)) || {};
    } catch (e) {
      return {};
    }
  }

  function writeDay(key, data) {
    try {
      localStorage.setItem(DAY_KEY + key, JSON.stringify(data));
    } catch (e) { /* 忽略 */ }
  }

  /** 读/初始化目标配置 */
  function getGoal() {
    var g;
    try {
      g = JSON.parse(localStorage.getItem(META_KEY));
    } catch (e) { g = null; }
    if (!g || !g.newWords) {
      g = { target: { ...DEFAULT_GOAL }, streak: 0, best: 0, lastDone: '' };
      saveGoal(g);
    }
    if (!g.target) g.target = { ...DEFAULT_GOAL };
    return g;
  }

  function saveGoal(g) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(g));
    } catch (e) { /* 忽略 */ }
  }

  /** 记录一次活动。type: newWord/review/listen/dictation */
  function record(type, n) {
    n = n || 1;
    var key = todayStr();
    var day = readDay(key);
    day[type] = (day[type] || 0) + n;
    day.updatedAt = Date.now();
    writeDay(key, day);
    return day;
  }

  /** 今日各项目完成情况 + 是否达成 */
  function today() {
    var g = getGoal();
    var day = readDay(todayStr());
    var t = g.target;
    var items = [
      { key: 'newWord', label: 'newWords', goal: t.newWords, done: day.newWord || 0 },
      { key: 'review', label: 'review', goal: t.review, done: day.review || 0 },
      { key: 'listen', label: 'listen', goal: t.listen, done: day.listen || 0 },
      { key: 'dictation', label: 'dictation', goal: t.dictation, done: day.dictation || 0 },
    ];
    var achieved = items.filter(function (i) {
      return i.goal > 0 && i.done >= i.goal;
    }).length;
    var pct = 0;
    var sumGoal = 0, sumDone = 0;
    items.forEach(function (i) {
      sumGoal += i.goal; sumDone += Math.min(i.done, i.goal);
    });
    pct = sumGoal > 0 ? Math.round(sumDone / sumGoal * 100) : 0;
    return {
      items: items,
      achieved: achieved,
      totalItems: items.filter(function (i) { return i.goal > 0; }).length,
      pct: pct,
      day: day,
    };
  }

  /**
   * 计算连续天数。
   * 达成目标才计入；今天没达成不影响昨天已形成的连续。
   */
  function computeStreak() {
    var g = getGoal();
    var streak = 0;
    var d = new Date();
    for (var i = 0; i < 400; i++) {
      var key = todayStr(d);
      var day = readDay(key);
      var ok = isDayAchieved(day, g.target);
      if (ok) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        // 今天未达成是正常的（还在学），不中断连续；更早的日子未达成才中断
        if (i === 0) {
          d.setDate(d.getDate() - 1);
          continue;
        }
        break;
      }
    }
    return streak;
  }

  function isDayAchieved(day, target) {
    if (!day) return false;
    var t = target || DEFAULT_GOAL;
    var need = 0;
    var got = 0;
    [
      ['newWord', t.newWords], ['review', t.review],
      ['listen', t.listen], ['dictation', t.dictation],
    ].forEach(function (p) {
      if (p[1] > 0) { need++; if ((day[p[0]] || 0) >= p[1]) got++; }
    });
    // 达成一半即算当天有效（门槛过高校验过严会让人放弃）
    return need > 0 && got >= Math.ceil(need / 2);
  }

  /** 打卡：刷新 streak / best */
  function checkIn() {
    var g = getGoal();
    var streak = computeStreak();
    g.streak = streak;
    if (streak > (g.best || 0)) g.best = streak;
    saveGoal(g);
    return { streak: streak, best: g.best };
  }

  /** 最近 n 天完成情况，用于画小柱状图 */
  function recent(n) {
    var g = getGoal();
    var out = [];
    var d = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var dd = new Date();
      dd.setDate(d.getDate() - i);
      var key = todayStr(dd);
      var day = readDay(key);
      out.push({
        date: key,
        label: (dd.getMonth() + 1) + '/' + dd.getDate(),
        achieved: isDayAchieved(day, g.target),
        done: (day.newWord || 0) + (day.review || 0) +
               (day.listen || 0) + (day.dictation || 0),
      });
    }
    return out;
  }

  function setTarget(patch) {
    var g = getGoal();
    Object.keys(patch || {}).forEach(function (k) {
      var v = parseInt(patch[k], 10);
      if (!isNaN(v) && v >= 0) g.target[k] = v;
    });
    saveGoal(g);
    return g.target;
  }

  global.DailyGoal = {
    DEFAULT_GOAL: DEFAULT_GOAL,
    today: today,
    record: record,
    checkIn: checkIn,
    computeStreak: computeStreak,
    recent: recent,
    setTarget: setTarget,
    getGoal: getGoal,
    isDayAchieved: function (day) {
      return isDayAchieved(day, getGoal().target);
    },
  };
})(window);