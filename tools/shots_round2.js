/**
 * 视觉验收（第二轮）—— 针对本轮修复
 *
 * 覆盖：
 *  1. 首页功能格
 *  2. 词卡弹窗（含发音按钮）
 *  3. 笔顺弹窗打开 → 关闭 → 切语言（验证不复现）
 *  4. 课程句子整行（含 data-audio）
 *  5. 设置页的评测代理口令区
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'deliverables', 'shots');
const PORT = 8791;

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    'playwright-core',
  ].filter(Boolean);
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  candidates.push(path.join(ROOT, 'node_modules', 'playwright'));
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
    try { return require(c); } catch (e) { /* 试下一个 */ }
  }
  return null;
}

function findBrowser() {
  const roots = [
    process.env.LOCALAPPDATA,
    'C:/Program Files',
    'C:/Program Files (x86)',
  ];
  for (const r of roots) {
    if (!r) continue;
    const base = path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(base)) return base;
    const edge = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(edge)) return edge;
  }
  return null;
}

function startServer() {
  const p = spawn('python', ['-m', 'http.server', String(PORT)], {
    cwd: path.join(ROOT, 'web'), stdio: 'ignore',
  });
  return p;
}

(async () => {
  const pw = loadPlaywright();
  if (!pw) { console.log('找不到 playwright，跳过'); process.exit(0); }
  const exe = findBrowser();
  fs.mkdirSync(OUT, { recursive: true });

  const server = startServer();
  await new Promise(r => setTimeout(r, 1500));

  const browser = await pw.chromium.launch({
    executablePath: exe || undefined,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    colorScheme: 'light', locale: 'vi-VN',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const shot = async (name, label) => {
    await page.screenshot({ path: path.join(OUT, name) });
    console.log(`  [SHOT] ${name} — ${label}`);
  };

  // ---- 1. 首页 ----
  await shot('r2-01-home.png', '首页（功能格入口卡）');

  // ---- 2. 词卡弹窗 ----
  await page.evaluate(() => {
    const c = document.querySelector('.vocab-card');
    if (c) c.click();
  });
  await page.waitForTimeout(500);
  await shot('r2-02-vocab-card.png', '词卡弹窗（发音按钮）');
  await page.evaluate(() => {
    document.querySelector('[data-close-vocab]')?.click();
  });
  await page.waitForTimeout(300);

  // ---- 3. 笔顺：打开 → 关闭 → 切语言 ----
  await page.evaluate(() => {
    const btn = document.querySelector('[data-goto="hanzi"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => {
    const b = document.querySelector('[data-char]');
    if (b) { b.click(); return true; }
    return false;
  });
  await page.waitForTimeout(900);
  const strokeOpen = await page.evaluate(() =>
    document.getElementById('stroke-modal')?.classList.contains('open'));
  console.log('  [INFO] 笔顺弹窗已打开 =', strokeOpen, '(点击入口:', opened, ')');
  await shot('r2-03-stroke-modal.png', '笔顺弹窗');

  // 关闭
  await page.evaluate(() => {
    document.querySelector('#stroke-modal [data-close-modal]')?.click();
  });
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() =>
    !document.getElementById('stroke-modal')?.classList.contains('open'));
  console.log('  [INFO] 笔顺弹窗已关闭 =', closed);

  // 切语言
  await page.evaluate(() => {
    document.getElementById('lang-toggle')?.click();
  });
  await page.waitForTimeout(900);
  const reopened = await page.evaluate(() =>
    document.getElementById('stroke-modal')?.classList.contains('open'));
  console.log('  [INFO] 切语言后笔顺弹窗是否复现 =', reopened, '（应为 false）');
  await shot('r2-04-after-lang-switch.png', '关闭笔顺后切换语言（不应复现弹窗）');

  // ---- 4. 课程句子整行 ----
  await page.evaluate(() => {
    document.querySelector('.nav-btn[data-section="sentence"]')?.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.querySelector('.course-card')?.click();
  });
  await page.waitForTimeout(600);
  const sentAudio = await page.evaluate(() => {
    const r = document.querySelector('.sentence-row');
    return r ? { audio: r.dataset.audio, say: r.dataset.say } : null;
  });
  console.log('  [INFO] 句子整行音频 =', JSON.stringify(sentAudio));
  await shot('r2-05-course-sentence.png', '课程句子（整行可点读）');

  // ---- 5. 设置页 ----
  await page.evaluate(() => {
    document.querySelector('.nav-more-btn')?.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelector('.nav-more-item[data-section="settings"]')?.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.getElementById('ise-proxy-key')?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await shot('r2-06-settings-ise.png', '设置页（评测代理口令）');

  console.log('\n  JS 运行时错误:', errs.length ? errs.join(' | ') : '无 ✓');

  await browser.close();
  try { server.kill(); } catch (e) { /* 忽略 */ }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
