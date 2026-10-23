/**
 * dictation.js — 听写模式（Dictation）
 *
 * 为什么需要（学习闭环）
 * ----------------------
 * 现有流程都是「看 → 记」，属于**被动识别**。
 * 听写要求学员**只听发音、自己写出汉字**，强制主动回忆，
 * 这才是「会说会认」里「认」的关键闭环。
 *
 * 流程
 * ----
 *   出题（按当前等级取词）
 *   → 播放预生成音频（无则 TTS）
 *   → 学员用拼音键盘/汉字键盘输入
 *   → 判分（完全正确 / 部分正确 / 错误）
 *   → 错词自动进错词本，供专项复习
 *
 * 输入方案
 * --------
 * 汉字无法直接键入，这里提供两种：
 *   1. **手写输入框**：桌面端可直接粘贴，手机端点「看答案」后对照
 *   2. **候选字选择**：把词拆成单字，给每个字提供 3~4 个候选字供点选
 *      （零基础友好——越南学员往往还不熟悉输入法）
 *   3. 支持粘贴汉字（从别的 App 复制过来）
 */
(function (global) {
  'use strict';

  var STATE = {
    queue: [],
    idx: 0,
    correct: 0,
    partial: 0,
    wrong: 0,
    current: null,
    answered: false,
  };

  /** 从词库里挑题：优先 SRS 到期，其次新词 */
  function buildQueue(vocab, limit) {
    if (!vocab || !vocab.length) return [];
    var learned = global.Settings ? null : null;
    var pool = vocab.slice();
    // 洗牌
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, limit || 10);
  }

  /** 取单字候选（干扰项从同等级随机取） */
  function charCandidates(ch, vocab, n) {
    var out = [];
    // 正确项**无条件**放进候选。
    // 原写法是 `if (charIndex[ch]) out.push(ch)` —— 一旦 charIndex 里
    // 没有这个字（词库更新后 charIndex 不同步、或某字只出现在多字词中间），
    // 正确项就进不了候选；而干扰项又用 `c !== ch` 把它排掉了，
    // 结果这个字**无论怎么点都答不对**（真机截图里「仅仅」第一个字位
    // 的选项是 仪/适/判/烟，压根没有「仅」）。
    // 听写的第一条铁律是：正确答案必须能选到。
    if (out.indexOf(ch) === -1) out.push(ch);

    var others = [];
    vocab.forEach(function (v) {
      var bare = (v.hanzi || '').replace(/[^一-鿿]/g, '');
      bare.split('').forEach(function (c) {
        if (c && c !== ch && others.indexOf(c) === -1) others.push(c);
      });
    });
    // 洗牌干扰项
    for (var i = others.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = others[i]; others[i] = others[j]; others[j] = t;
    }
    // 打乱候选顺序（正确项不固定在第一位）。
    // slice 的长度按 out 实际长度算，正确项永远排在拼接结果的最前，
    // 不会被干扰项挤出去。
    var picked = out.concat(others.slice(0, Math.max(0, (n || 3) - out.length)));
    for (var k = picked.length - 1; k > 0; k--) {
      var m = Math.floor(Math.random() * (k + 1));
      var t2 = picked[k]; picked[k] = picked[m]; picked[m] = t2;
    }
    return picked;
  }

  /** 归一化：去掉标点空格、统一全角 */
  function normalize(s) {
    return String(s || '')
      .replace(/[\s]/g, '')
      .replace(/[！？。，、；：""''（）《》…—,.?!;:"'()\[\]{}~·]/g, '')
      .trim();
  }

  /**
   * 判分
   * @returns {{level:'correct'|'partial'|'wrong', score:number}}
   */
  function grade(input, answer) {
    var a = normalize(input);
    var b = normalize(answer);
    if (!a) return { level: 'wrong', score: 0 };
    if (a === b) return { level: 'correct', score: 1 };

    // 逐字比对，给部分分
    if (b.indexOf(a) === 0 || a.indexOf(b) === 0) {
      return { level: 'partial', score: 0.5 };
    }
    var hit = 0;
    var set = {};
    b.split('').forEach(function (c) { set[c] = (set[c] || 0) + 1; });
    a.split('').forEach(function (c) {
      if (set[c] > 0) { hit++; set[c]--; }
    });
    var ratio = hit / b.length;
    if (ratio >= 0.5) return { level: 'partial', score: ratio };
    return { level: 'wrong', score: 0 };
  }

  global.Dictation = {
    STATE: STATE,
    buildQueue: buildQueue,
    charCandidates: charCandidates,
    normalize: normalize,
    grade: grade,
  };
})(window);