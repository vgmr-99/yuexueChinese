/**
 * shots.js — 视觉验收截图
 *
 * 用途：为 UI 改造做人工验收，覆盖这几处改动：
 *   - 首页功能格改成可点击入口卡（带箭头）
 *   - 测验 / 听写结果页的进度环
 *   - 宽屏（720px）词卡三列自适应
 *   - 设置页新增的评测代理口令输入框
 *   - 浅色 / 深色两套配色
 *
 * 用法：node tools/shots.js [输出目录]
 * 依赖 playwright（解析方式与 smoke_test.js 一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'deliverables', 'shots'));
const PORT = Number(process.env.SHOTS_PORT || 8801);

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    'playwright-core',
  ].filter(Boolean);
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
    try { return require(c); } catch (e) { /* 试下一个 */ }
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

const SHOTS = [];
async function shot(page, name, note) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  SHOTS.push({ name, note });
  console.log(`  [SHOT] ${name}  ${note}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pw = loadPlaywright();
  if (!pw) { console.error('找不到 playwright'); process.exit(2); }
  const exe = findBrowser();
  const launchOpts = { headless: true };
  if (exe) launchOpts.executablePath = exe;

  const server = await startServer();
  const browser = await pw.chromium.launch(launchOpts);
  const errors = [];

  async function newPage(width, height, colorScheme) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: colorScheme || 'light',
      locale: 'vi-VN',
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    return { ctx, page };
  }

  // ---------- 1. 手机浅色：首页 / 学习 / 更多抽屉 / 设置 ----------
  {
    const { ctx, page } = await newPage(420, 900, 'light');
    await shot(page, '01-home-phone-light.png', '首页 420px 浅色（功能格入口卡 + 箭头）');

    await page.click('.nav-btn[data-section="learn"]');
    await page.waitForTimeout(500);
    await shot(page, '02-learn-phone-light.png', '学词页 420px');

    // 更多抽屉
    await page.click('#nav-more-btn');
    await page.waitForTimeout(400);
    await shot(page, '03-more-panel.png', '「更多」抽屉（含高亮态）');
    // 用遮罩关闭（再点按钮会被遮罩挡住）
    await page.click('#nav-more-scrim');
    await page.waitForTimeout(400);

    // 设置页（新增代理口令输入框）
    await page.evaluate(() => {
      document.querySelector('.nav-more-item[data-section="settings"]')?.click();
    });
    await page.waitForTimeout(500);
    await shot(page, '04-settings.png', '设置页（每日目标 / 笔顺 / 统计）');

    // 滚到新增的「评测代理口令」区域
    const found = await page.evaluate(() => {
      const el = document.getElementById('ise-proxy-key');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    });
    await page.waitForTimeout(400);
    if (found) {
      await shot(page, '04b-settings-ise-key.png', '设置页（在线评测代理口令 + 评测地址）');
    } else {
      console.log('  [WARN] 未找到 #ise-proxy-key');
    }

    await ctx.close();
  }

  // ---------- 2. 手机深色 ----------
  {
    const { ctx, page } = await newPage(420, 900, 'dark');
    await shot(page, '05-home-phone-dark.png', '首页 420px 深色');
    await ctx.close();
  }

  // ---------- 3. 宽屏 720px：词卡三列 ----------
  {
    const { ctx, page } = await newPage(720, 1000, 'light');
    await page.click('.nav-btn[data-section="learn"]');
    await page.waitForTimeout(600);
    await shot(page, '06-learn-wide-720.png', '学词页 720px 宽屏（词卡多列自适应）');

    // 量一下实际列数
    const cols = await page.evaluate(() => {
      const card = document.querySelector('.vocab-card');
      if (!card) return null;
      const top = card.getBoundingClientRect().top;
      let n = 0;
      document.querySelectorAll('.vocab-card').forEach(c => {
        if (Math.abs(c.getBoundingClientRect().top - top) < 4) n++;
      });
      return n;
    });
    console.log('  [INFO] 720px 首行词卡数 =', cols);
    await ctx.close();
  }

  // ---------- 4. 测验结果页（进度环） ----------
  {
    const { ctx, page } = await newPage(420, 900, 'light');
    await page.click('.nav-btn[data-section="quiz"]');
    await page.waitForTimeout(400);
    await page.click('#quiz-start');
    await page.waitForTimeout(500);
    await shot(page, '07-quiz-question.png', '测验题目页');

    // 连答 10 题（每题 1.1s 自动推进）—— 故意答对 8 题，制造 80% 的高分结果
    for (let i = 0; i < 12; i++) {
      const done = await page.evaluate(() => {
        const opts = document.querySelectorAll('#quiz-area .quiz-opt');
        if (!opts.length) return true;          // 已是结果页
        const prompt = document.querySelector('#quiz-area .quiz-prompt');
        const want = prompt ? prompt.textContent.trim() : '';
        let target = null;
        opts.forEach(o => { if (o.dataset.answer === want) target = o; });
        (target || opts[0]).click();
        return false;
      });
      if (done) break;
      await page.waitForTimeout(1250);
    }
    await page.waitForTimeout(400);
    await shot(page, '08-quiz-result-ring.png', '测验结果页（进度环）');

    const ring = await page.evaluate(() => {
      const r = document.querySelector('.result-ring .ring-fill');
      if (!r) return null;
      return {
        dasharray: r.getAttribute('stroke-dasharray'),
        dashoffset: r.getAttribute('stroke-dashoffset'),
        num: document.querySelector('.result-ring-num')?.textContent,
      };
    });
    console.log('  [INFO] 进度环 =', JSON.stringify(ring));
    await ctx.close();
  }

  // ---------- 5. 听写结果页（进度环） ----------
  {
    const { ctx, page } = await newPage(420, 900, 'light');
    await page.evaluate(() => {
      document.querySelector('.nav-more-item[data-section="dictation"]')?.click();
    });
    await page.waitForTimeout(600);
    const hasStart = await page.$('#dict-start');
    if (hasStart) {
      await page.click('#dict-start');
      await page.waitForTimeout(500);
      // 直接把状态推到末尾，制造 8/10 的结果
      await page.evaluate(() => {
        const D = window.Dictation && window.Dictation.STATE;
        if (D) { D.correct = 8; D.partial = 1; D.wrong = 1; D.idx = 99; }
      });
      await page.click('#dict-reveal');
      await page.waitForTimeout(2600);          // 看答案后 1.9s 自动进入下一题
    }
    await shot(page, '09-dict-result-ring.png', '听写结果页（进度环）');
    const ring = await page.evaluate(() => {
      const r = document.querySelector('.result-ring .ring-fill');
      if (!r) return null;
      return {
        dasharray: r.getAttribute('stroke-dasharray'),
        dashoffset: r.getAttribute('stroke-dashoffset'),
        num: document.querySelector('.result-ring-num')?.textContent,
      };
    });
    console.log('  [INFO] 听写进度环 =', JSON.stringify(ring));
    await ctx.close();
  }

  // ---------- 6. 词卡详情弹窗 ----------
  {
    const { ctx, page } = await newPage(420, 900, 'light');
    await page.click('.nav-btn[data-section="learn"]');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const c = document.querySelector('.vocab-card');
      if (c) c.click();
    });
    await page.waitForTimeout(700);
    await shot(page, '10-word-card-modal.png', '词卡详情弹窗');
    await ctx.close();
  }

  await browser.close();
  try { server.kill(); } catch (e) { /* ignore */ }

  console.log('\n共 ' + SHOTS.length + ' 张截图 → ' + OUT);
  if (errors.length) {
    console.log('\n[注意] 页面 JS 错误 ' + errors.length + ' 条：');
    errors.slice(0, 5).forEach(e => console.log('   - ' + e));
  } else {
    console.log('[OK] 全程无 JS 运行时错误');
  }
  fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(SHOTS, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
