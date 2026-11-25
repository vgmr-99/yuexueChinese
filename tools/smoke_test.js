/**
 * smoke_test.js — 前端冒烟测试
 *
 * 覆盖「改了前端会不会悄悄坏掉」这件事：
 *   1. 页面能加载，无 JS 运行时错误
 *   2. 关键分区都能打开并渲染出内容
 *   3. 正文里没有 emoji（图标必须是 SVG）
 *   4. 存储层可用：写入 → 读回 → 重置
 *   5. 无 404 资源（音频目录不在仓库里的除外，那是有意为之）
 *
 * 用法：
 *   node tools/smoke_test.js
 *
 * 依赖 playwright。解析顺序：
 *   1. 环境变量 PLAYWRIGHT_MODULE 指定的路径
 *   2. 本地 node_modules
 *   3. npx 缓存里的全局副本（开发机上最常见）
 * 浏览器同理：PLAYWRIGHT_CHROMIUM_PATH → 本机 Chrome → Playwright 自带。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.SMOKE_PORT || 8799);

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    'playwright-core',
  ].filter(Boolean);
  // npx 缓存里通常有一份全局副本
  const npxCache = path.join(
    process.env.LOCALAPPDATA || 'C:/Users/PC/AppData/Local',
    'npm-cache', '_npx'
  );
  if (fs.existsSync(npxCache)) {
    for (const d of fs.readdirSync(npxCache)) {
      candidates.push(path.join(npxCache, d, 'node_modules', 'playwright'));
    }
  }
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

function findBrowser() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const guesses = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

/** 起一个静态服务器（优先 python，其次 node 内置） */
function startServer() {
  return new Promise((resolve, reject) => {
    const py = spawnSync('python', ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
    if (py.status === 0) {
      const proc = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
        cwd: WEB, stdio: 'ignore',
      });
      proc.on('error', reject);
      setTimeout(() => resolve(proc), 1200);
      return;
    }
    reject(new Error('找不到 python，无法启动静态服务器'));
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? '[OK]  ' : '[FAIL]';
  console.log(`  ${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.error('找不到 playwright。请先 npm i -D playwright 或设置 PLAYWRIGHT_MODULE。');
    process.exit(2);
  }
  const exe = findBrowser();
  const launchOpts = { headless: true };
  if (exe) launchOpts.executablePath = exe;

  let server = null;
  try {
    server = await startServer();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  const browser = await pw.chromium.launch(launchOpts);
  const page = await browser.newPage({
    viewport: { width: 420, height: 900 },
    deviceScaleFactor: 2,
  });

  const pageErrors = [];
  const failedReqs = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('requestfailed', r => failedReqs.push(r.url()));
  page.on('response', r => {
    if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url());
  });

  try {
    const resp = await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    console.log('\n[1] 页面加载');
    check('HTTP 200', resp && resp.status() === 200, resp ? String(resp.status()) : 'no response');
    check('无 JS 运行时错误', pageErrors.length === 0, pageErrors.join(' | '));

    console.log('\n[2] 存储层');
    const storeInfo = await page.evaluate(() => {
      if (!window.Store) return { ok: false };
      const probe = '__smoke_probe__';
      window.Store.set(probe, 'v1');
      const back = window.Store.get(probe, null);
      window.Store.set(probe, 'v2');
      const back2 = window.Store.get(probe, null);
      window.Store.remove(probe);
      return {
        ok: back === 'v1' && back2 === 'v2' && window.Store.get(probe, null) === null,
        version: window.Store.version(),
        keys: window.Store.allKeys().length,
      };
    });
    check('Store 可读写可删除', storeInfo.ok, JSON.stringify(storeInfo));
    check('Store 已完成版本迁移', storeInfo.version >= 1, 'version=' + storeInfo.version);

    console.log('\n[3] 各分区渲染');
    const sections = ['home', 'learn', 'sentence', 'quiz'];
    for (const s of sections) {
      const n = await page.evaluate((id) => {
        const btn = document.querySelector(`.nav-btn[data-section="${id}"]`);
        if (!btn) return -1;
        btn.click();
        const el = document.getElementById(id);
        return el ? el.querySelectorAll('*').length : -1;
      }, s);
      check(`分区 ${s} 有内容`, n > 3, '节点数 ' + n);
    }

    // 更多抽屉里的分区
    for (const s of ['review', 'pinyin', 'settings']) {
      const n = await page.evaluate((id) => {
        const btn = document.querySelector(`.nav-more-item[data-section="${id}"]`);
        if (!btn) return -1;
        btn.click();
        const el = document.getElementById(id);
        return el ? el.querySelectorAll('*').length : -1;
      }, s);
      check(`分区 ${s} 有内容`, n > 3, '节点数 ' + n);
    }

    console.log('\n[4] 图标与文案');
    const gfx = await page.evaluate(() => {
      const text = document.body.innerText;
      const emoji = text.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu) || [];
      return {
        emoji: emoji.length,
        emojiSample: emoji.slice(0, 5),
        svgUse: document.querySelectorAll('svg use').length,
        cards: document.querySelectorAll('.vocab-card').length,
      };
    });
    check('正文无 emoji', gfx.emoji === 0, gfx.emoji ? JSON.stringify(gfx.emojiSample) : '');
    check('SVG 图标已渲染', gfx.svgUse > 50, gfx.svgUse + ' 个');
    check('词卡已渲染', gfx.cards > 0, gfx.cards + ' 张');

    console.log('\n[5] 资源加载');
    // web/audio 不在仓库里（.gitignore），音频 404 属于已知情况
    const realFails = failedReqs.filter(u => !/\/audio\//.test(u));
    check('无意外的资源 404', realFails.length === 0, realFails.slice(0, 3).join(' | '));

    console.log('\n[6] 触控热区');
    const small = await page.evaluate(() => {
      const sel = '.btn, .btn-sm, .level-tab, .nav-btn, .nav-more-item, .quiz-opt';
      const bad = [];
      document.querySelectorAll(sel).forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;   // 未渲染出来的跳过
        if (r.height < 44) {
          bad.push((el.className || el.tagName) + ' h=' + Math.round(r.height));
        }
      });
      return bad;
    });
    check('可点击元素高度均 ≥44px', small.length === 0, small.slice(0, 5).join(' | '));

    // 6b) 换到窄屏 + 深色模式再测一遍。
    // 这一步专门防「媒体查询把 min-height 覆盖回去」这类问题：
    // style.css 的 @media(max-width:400px) 和 @media(dark) 里各有一条
    // .btn-sm{min-height:38px}，只看浅色宽屏是发现不了的。
    console.log('\n[7] 窄屏 + 深色模式下的触控热区');
    const combos = [
      { w: 360, h: 780, scheme: 'light', label: '360px 浅色' },
      { w: 360, h: 780, scheme: 'dark', label: '360px 深色' },
      { w: 420, h: 900, scheme: 'dark', label: '420px 深色' },
    ];
    for (const c of combos) {
      const cctx = await browser.newContext({
        viewport: { width: c.w, height: c.h },
        colorScheme: c.scheme,
        locale: 'vi-VN',
      });
      const cpage = await cctx.newPage();
      const cerrs = [];
      cpage.on('pageerror', e => cerrs.push(e.message));
      await cpage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
      await cpage.waitForTimeout(500);
      const bad2 = await cpage.evaluate(() => {
        const sel = '.btn, .btn-sm, .level-tab, .pinyin-tab, .nav-btn, .nav-more-item, .quiz-opt';
        const out = [];
        document.querySelectorAll(sel).forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          if (r.height < 44) out.push((el.className || el.tagName) + ' h=' + Math.round(r.height));
        });
        return out;
      });
      check(`${c.label} 热区 ≥44px 且无 JS 错误`,
        bad2.length === 0 && cerrs.length === 0,
        (bad2.slice(0, 3).join(' | ') || '') + (cerrs.length ? ' ERR:' + cerrs[0] : ''));
      await cctx.close();
    }

  } catch (e) {
    check('测试执行未抛异常', false, e.message);
  }

  await browser.close();
  if (server) { try { server.kill(); } catch (e) { /* ignore */ } }

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length} 通过 / ${failed.length} 失败 ===`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
