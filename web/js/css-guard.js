/* css-guard.js — 样式表加载兜底
 *
 * 背景：实测 vivo 自带浏览器在「省流量/加速」模式下会拦截外部样式表，
 * 页面因此完全没有样式（Chrome 正常）。这是浏览器侧的加载失败，
 * 不是 CSS 本身的问题（该文件已通过 tinycss2 校验：482 条规则 0 错误）。
 *
 * 做法：
 *   1. DOM 就绪后检查 style.css 是否真的产生了规则；
 *   2. 没生效 → 给 <html> 加 class="nc"，index.html 里那段
 *      `html.nc {...}` 关键样式立即接管，页面不至于白屏；
 *   3. 同时用带时间戳的新地址重试 style.css，成功后移除 nc。
 *
 * 为什么用 .nc 限定而不是直接写内联样式：
 *   内联 <style> 在 <link> 之前，同优先级下 link 会覆盖内联，但
 *   style.css 从未声明的属性会**残留**下来造成真实布局破坏
 *   （已因此出过三次事故）。加了 html.nc 限定后，
 *   style.css 正常时兜底样式完全不参与计算。
 */
(function () {
  'use strict';

  var HREF = 'css/style.css';
  var NC = 'nc';
  var tried = 0;

  function setFallback(on) {
    var el = document.documentElement;
    if (!el) return;
    if (on) { el.classList.add(NC); } else { el.classList.remove(NC); }
  }

  /** style.css 是否真的产生了规则 */
  function sheetsUsable() {
    var list = document.styleSheets || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.href || s.href.indexOf(HREF) === -1) continue;
      // 同源可读 cssRules；跨源会抛异常，此时用 ownerNode 判断
      try {
        if (s.cssRules && s.cssRules.length > 0) return true;
      } catch (e) { /* 跨源，忽略 */ }
      if (s.ownerNode) return true;
    }
    return false;
  }

  function retry() {
    if (tried >= 2) {
      console.warn('[css-guard] 样式表重试失败，继续使用兜底样式');
      return;
    }
    tried += 1;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = HREF + '?reload=' + Date.now();
    link.onload = function () {
      // 真实样式表回来了，撤掉兜底，避免两套样式叠加
      setFallback(false);
      console.log('[css-guard] 样式表重载成功，已撤除兜底样式');
    };
    link.onerror = function () {
      console.warn('[css-guard] 重载仍失败，继续使用兜底样式');
    };
    document.head.appendChild(link);
  }

  function check() {
    if (sheetsUsable()) {
      setFallback(false);
      return;
    }
    console.warn('[css-guard] 样式表未生效，启用兜底样式并尝试重载');
    setFallback(true);
    retry();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }

  // 移动端网络切换后（Wi-Fi → 蜂窝）有些浏览器会丢样式，再兜一次
  window.addEventListener('pageshow', check);
  window.addEventListener('online', check);
})();
