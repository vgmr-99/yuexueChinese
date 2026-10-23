/* 本地复现 & 回归测试：用 file:// 加载 web 应用（与 Android WebView 场景一致）。
 * 覆盖：JS 无错初始化 / 标题翻译 / 导航切换 / 词卡弹窗 / 拼音呼读音 / 语言切换。
 * 用法：node tools/repro_js.js */
const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 }); // 典型手机视口
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('[console] ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message + '\n' + (err.stack || '').split('\n').slice(0, 4).join('\n')));
  page.on('requestfailed', (req) =>
    errors.push('[requestfailed] ' + req.url() + ' :: ' + (req.failure() && req.failure().errorText)));

  const url = 'file:///' + path.resolve('C:/Users/PC/WorkBuddy/2026-10-16-13-34-21/viet-chinese-app/web/index.html').replace(/\\/g, '/');
  // 模拟学员环境：预设越南语（本机 Chrome 默认 zh-CN 会走中文分支）
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('vietchinese.lang', 'vi'); } catch (e) {}
  });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  const results = {};
  const check = (name, ok, extra) => {
    results[name] = ok ? 'PASS' : 'FAIL' + (extra ? ' :: ' + extra : '');
  };

  // 1. 初始化无错 + 标题被翻译成 Athao
  const init = await page.evaluate(() => ({
    title: (document.querySelector('.header h1') || {}).textContent,
    sub: (document.querySelector('.logo-sub') || {}).textContent,
    goalLen: (document.getElementById('goal-widget') || {}).innerHTML.length,
    cards: document.querySelectorAll('.vocab-card').length,
    back: typeof window.__onAndroidBack,
  }));
  check('JS init (no pageerror)', errors.length === 0, errors.join(' | '));
  check('title translated', init.title === 'Athao Học Tiếng Trung', init.title);
  check('goal widget rendered', init.goalLen > 50, 'len=' + init.goalLen);
  check('vocab cards rendered', init.cards > 0, 'n=' + init.cards);

  // 2. 导航切换到学词
  await page.click('[data-section="learn"]');
  await new Promise((r) => setTimeout(r, 300));
  const nav = await page.evaluate(() => ({
    learnActive: document.getElementById('learn').classList.contains('active'),
    homeActive: document.getElementById('home').classList.contains('active'),
  }));
  check('nav goto learn', nav.learnActive && !nav.homeActive, JSON.stringify(nav));

  // 3. 词卡点击弹出词卡弹窗
  const cardTap = await page.evaluate(() => {
    const card = document.querySelector('.vocab-card');
    if (!card) return { err: 'no card' };
    card.click();
    const modal = document.getElementById('vocab-modal');
    return {
      opened: modal && modal.classList.contains('open'),
      hanzi: (document.getElementById('vm-hanzi') || {}).textContent,
    };
  });
  check('vocab card opens modal', cardTap.opened === true, JSON.stringify(cardTap));

  // 4. 词卡弹窗内笔顺按钮打开笔顺弹窗（且 SVG 真正画出笔画路径）
  const strokeTap = await page.evaluate(() => {
    const btn = document.getElementById('vm-stroke');
    if (!btn || btn.style.display === 'none') return { err: 'no stroke btn' };
    btn.click();
    return new Promise((resolve) => setTimeout(() => {
      const m = document.getElementById('stroke-modal');
      const svg = document.querySelector('#stroke-target svg');
      resolve({
        opened: m && m.classList.contains('open'),
        paths: svg ? svg.querySelectorAll('path').length : 0,
      });
    }, 1500));
  });
  check('stroke modal + SVG paths', strokeTap.opened === true && strokeTap.paths > 0, JSON.stringify(strokeTap));

  // 5. 拼音页：呼读音注释存在（拼音在「更多」面板里，先开面板）
  //    先关掉可能开着的弹窗——弹窗遮罩会吞掉导航点击
  await page.evaluate(() => {
    ['vocab-modal', 'stroke-modal'].forEach(function (id) {
      var m = document.getElementById(id);
      if (m) m.classList.remove('open');
    });
  });
  await page.click('#nav-more-btn');
  await new Promise((r) => setTimeout(r, 350));
  const moreOpen = await page.evaluate(() => ({
    panel: document.getElementById('nav-more').classList.contains('open'),
    items: document.querySelectorAll('.nav-more-item').length,
    navBtns: document.querySelectorAll('.nav .nav-btn').length,
    navPos: getComputedStyle(document.querySelector('.nav')).position,
    navBottom: getComputedStyle(document.querySelector('.nav')).bottom,
  }));
  check('bottom nav: 5 buttons + fixed', moreOpen.navBtns === 5 && moreOpen.navPos === 'fixed' && moreOpen.navBottom === '0px', JSON.stringify(moreOpen));
  check('more panel opens with 5 items', moreOpen.panel === true && moreOpen.items === 5, JSON.stringify(moreOpen));
  await page.click('.nav-more-item[data-section="pinyin"]');
  await new Promise((r) => setTimeout(r, 300));
  const panelClosed = await page.evaluate(() => ({
    closed: !document.getElementById('nav-more').classList.contains('open'),
    active: !!document.querySelector('.nav-more-item[data-section="pinyin"]'),
    section: document.getElementById('pinyin').classList.contains('active'),
  }));
  check('more panel item navigates + auto-closes', panelClosed.closed === true && panelClosed.section === true, JSON.stringify(panelClosed));
  const py = await page.evaluate(() => {
    const b = document.querySelector('.pinyin-cell .py-symbol');
    const sound = document.querySelector('.pinyin-cell .py-sound');
    return {
      symbol: b ? b.textContent : null,
      sound: sound ? sound.textContent : null,
    };
  });
  check('pinyin sound annotation', py.sound === 'bo' && py.symbol === 'b', JSON.stringify(py));

  // 5c. 防双重播放：声母/韵母/声调卡同时带 data-audio + data-say，
  //     点击后只应走本地播放一次，不得再触发系统 TTS（曾因两个监听器都触发而双重播放）
  const dbl = await page.evaluate(() => {
    let playN = 0, speakN = 0;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { playN++; return origPlay.apply(this, arguments); };
    const origSpeak = window.speechSynthesis && window.speechSynthesis.speak;
    if (window.speechSynthesis) window.speechSynthesis.speak = function () { speakN++; };
    const cell = document.querySelector('.pinyin-cell');
    cell.click();
    HTMLMediaElement.prototype.play = origPlay;
    if (window.speechSynthesis && origSpeak) window.speechSynthesis.speak = origSpeak;
    return { playN, speakN };
  });
  check('pinyin cell plays once (no double TTS)', dbl.playN === 1 && dbl.speakN === 0, JSON.stringify(dbl));

  // 5b. 内置字体：Nunito 子集加载成功，且 z/c/s 单元格用小写字形
  //     （防个别机型系统变字体把粗体 z/c/s 渲染成大写的回归）
  const fontChk = await page.evaluate(() => {
    const out = {};
    out.loaded = document.fonts.check('700 19px Nunito');
    const cell = [...document.querySelectorAll('.pinyin-cell')].find((c) => {
      const s = c.querySelector('.py-symbol');
      return s && s.textContent === 'z';
    });
    if (!cell) { out.err = 'no z cell'; return out; }
    const sp = cell.querySelector('.py-symbol');
    out.ff = getComputedStyle(sp).fontFamily;
    // 参考宽度：同一字号字重下，Nunito 与 Arial(设备回退字体) 各自的小写/大写
    const ref = (ch, family) => {
      const s = document.createElement('span');
      s.textContent = ch;
      s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:19px;font-weight:700;font-family:' + family + ';';
      document.body.appendChild(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    };
    const textW = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect().width; };
    const refs = { nZ: ref('Z', 'Nunito'), nz: ref('z', 'Nunito'), aZ: ref('Z', 'Arial'), az: ref('z', 'Arial') };
    const cellW = textW(sp);
    out.widths = Object.keys(refs).reduce((o, k) => { o[k] = +refs[k].toFixed(2); return o; }, {});
    out.cell = +cellW.toFixed(2);
    out.zLower = Math.abs(cellW - refs.nz) < Math.abs(cellW - refs.nZ);
    // 真确定性：单元格必须落在 Nunito 小写附近，而不是设备字体(Arial 回退)附近
    out.usesNunito = Math.abs(cellW - refs.nz) < Math.abs(cellW - refs.az);
    return out;
  });
  check('bundled font loaded (Nunito)', fontChk.loaded === true, JSON.stringify(fontChk));
  check('pinyin z renders lowercase', fontChk.zLower === true, JSON.stringify(fontChk));
  check('pinyin z uses bundled font (not device fallback)', fontChk.usesNunito === true, JSON.stringify(fontChk));

  // 6. 语言切换（只有中文 / 越南语两种，一枚按钮来回切）
  // 先关掉可能开着的弹窗，遮罩会挡住头部按钮
  await page.evaluate(() => {
    ['vocab-modal', 'stroke-modal'].forEach(function (id) {
      var m = document.getElementById(id);
      if (m) m.classList.remove('open');
    });
  });
  const langBefore = await page.evaluate(() => ({
    lang: window.I18N && window.I18N.lang,
    title: (document.querySelector('.header h1') || {}).textContent,
    btnTxt: (document.getElementById('lang-toggle-txt') || {}).textContent,
  }));
  await page.click('#lang-toggle');
  await new Promise((r) => setTimeout(r, 600));
  const langAfter = await page.evaluate(() => ({
    title: (document.querySelector('.header h1') || {}).textContent,
    lang: window.I18N && window.I18N.lang,
    btnTxt: (document.getElementById('lang-toggle-txt') || {}).textContent,
    htmlLang: document.documentElement.getAttribute('lang'),
    noEn: !document.querySelector('[data-lang="en"]'),
    toggleCount: document.querySelectorAll('.lang-toggle').length,
    oldBtnCount: document.querySelectorAll('.lang-btn').length,
  }));
  check('lang toggle switches vi<->zh',
    langAfter.lang !== langBefore.lang &&
    langAfter.title !== langBefore.title &&
    langAfter.btnTxt !== langBefore.btnTxt,
    JSON.stringify({ before: langBefore, after: langAfter }));
  check('only one language toggle button', langAfter.toggleCount === 1 && langAfter.oldBtnCount === 0,
    'toggle=' + langAfter.toggleCount + ' old=' + langAfter.oldBtnCount);
  check('english option removed', langAfter.noEn === true, 'noEn=' + langAfter.noEn);

  // 切回原语言，别影响后续用例
  await page.click('#lang-toggle');
  await new Promise((r) => setTimeout(r, 500));

  // ===== 6. 发音评测模块（讯飞 ISE 客户端）=====
  const sa = await page.evaluate(() => {
    const out = {};
    out.module = typeof window.SpeechAssess === 'object';
    out.hasModal = !!document.getElementById('assess-modal');
    out.hasMic = !!document.getElementById('as-mic');
    out.hasEndpointInput = !!document.getElementById('ise-endpoint');
    out.hasVocabBtn = !!document.getElementById('vm-assess');
    return out;
  });
  check('speech module + assess modal mounted',
    sa.module && sa.hasModal && sa.hasMic && sa.hasEndpointInput && sa.hasVocabBtn,
    JSON.stringify(sa));

  // 内置默认评测服务地址：装完即用，不要求用户先填
  const dflt = await page.evaluate(() => {
    const S = window.SpeechAssess;
    S.resetEndpoint();                       // 清掉任何历史设置，回到出厂态
    const on = S.configured();
    const url = S.endpoint();
    S.setEndpoint('');                       // 显式关闭
    const off = S.configured();
    S.resetEndpoint();                       // 恢复默认
    return { on, url, off, restored: S.configured() };
  });
  check('default endpoint built in + can be disabled',
    dflt.on === true && dflt.url === 'https://kimthao.22web.org/api/ise.php'
    && dflt.off === false && dflt.restored === true,
    JSON.stringify(dflt));

  // 词条音频标志：必须为 true，否则 App 会退化成 speechSynthesis（WebView 不发声）
  const au = await page.evaluate(() => {
    const d = window.APP_DATA;
    let tot = 0, has = 0, missing = [];
    for (const lv of Object.keys(d.levels)) {
      for (const w of d.levels[lv]) {
        tot++;
        if (w.has_audio) has++;
        else if (missing.length < 5) missing.push(w.hanzi);
      }
    }
    return { tot, has, pct: +(has / tot * 100).toFixed(1), missing };
  });
  check('word audio flags present (>99%)', au.pct > 99, JSON.stringify(au));

  // WAV 头必须合法：RIFF/WAVE/fmt /data、单声道、16bit、16k
  const wav = await page.evaluate(() => {
    const S = window.SpeechAssess;
    const n = 1600; // 0.1s @16k
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.sin(i / 10) * 0.5;
    const bytes = S._toWav16(pcm, S.TARGET_RATE);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o, n2) => String.fromCharCode(...bytes.slice(o, o + n2));
    return {
      len: bytes.length,
      riff: tag(0, 4), wave: tag(8, 4), fmt: tag(12, 4), data: tag(36, 4),
      audioFmt: dv.getUint16(20, true),
      channels: dv.getUint16(22, true),
      rate: dv.getUint32(24, true),
      bits: dv.getUint16(34, true),
      dataSize: dv.getUint32(40, true),
      durationMs: S.wavDurationMs(bytes.length, S.TARGET_RATE),
      b64len: S._toBase64(bytes).length,
    };
  });
  check('WAV header valid (16k/16bit/mono)',
    wav.riff === 'RIFF' && wav.wave === 'WAVE' && wav.fmt === 'fmt ' && wav.data === 'data'
    && wav.audioFmt === 1 && wav.channels === 1 && wav.rate === 16000
    && wav.bits === 16 && wav.dataSize === 1600 * 2 && wav.len === 44 + 3200
    && wav.durationMs === 100,
    JSON.stringify(wav));

  // 重采样必须等比缩放（48k → 16k）
  const rs = await page.evaluate(() => {
    const src = new Float32Array(480);
    for (let i = 0; i < 480; i++) src[i] = i / 480;
    return { inLen: src.length, outLen: window.SpeechAssess._resample(src, 48000, 16000).length };
  });
  check('resample 48k->16k = /3', rs.inLen === 480 && rs.outLen === 160, JSON.stringify(rs));

  // 未配置服务端：按钮禁用 + 明确提示（不能静默失败）
  const unconf = await page.evaluate(() => {
    window.SpeechAssess.setEndpoint('');
    const out = {};
    out.configured = window.SpeechAssess.configured();
    // 打开词卡并点发音评测
    document.querySelector('[data-section="learn"]').click();
    return new Promise((resolve) => setTimeout(() => {
      const card = document.querySelector('.vocab-card');
      card.click();
      setTimeout(() => {
        document.getElementById('vm-assess').click();
        setTimeout(() => {
          const st = document.getElementById('as-status');
          out.modalOpen = document.getElementById('assess-modal').classList.contains('open');
          out.micDisabled = document.getElementById('as-mic').disabled;
          out.statusShown = !st.hidden && st.textContent.length > 10;
          out.statusText = st.textContent.slice(0, 40);
          resolve(out);
        }, 150);
      }, 200);
    }, 250));
  });
  check('assess opens from vocab card', unconf.modalOpen === true, JSON.stringify(unconf));
  check('unconfigured → mic disabled + hint shown',
    unconf.configured === false && unconf.micDisabled === true && unconf.statusShown === true,
    JSON.stringify(unconf));

  // 配置端点后 → 重新打开弹窗，按钮可用；并用打桩的 fetch 验证成功路径
  const conf = await page.evaluate(async () => {
    const url = 'https://example.test/api/ise.php';
    window.SpeechAssess.setEndpoint(url);
    const out = {
      configured: window.SpeechAssess.configured(),
      roundtrip: window.SpeechAssess.endpoint() === url,
    };

    // 打桩 fetch：避免真实网络请求污染 page error 统计
    const origFetch = window.fetch;
    let sent = null;
    window.fetch = (u, opt) => {
      sent = { url: u, body: JSON.parse(opt.body) };
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          ok: true,
          score: { overall: 88, phone: 90, tone: 85, fluency: 92, pron: 0 },
          words: [{ chars: [{ w: '长', sc: 95 }, { w: '城', sc: 81 }], sc: 88 }],
        })),
      });
    };

    // 重新打开评测弹窗（模拟：设置完地址后再点一次发音评测）
    window.__openAssess({ text: '长城', pinyin: 'chángchéng', audioKey: null });
    out.micEnabled = !document.getElementById('as-mic').disabled;

    const bytes = window.SpeechAssess._toWav16(new Float32Array(16000), 16000);
    const r = await window.SpeechAssess.assess('长城', bytes, 1000);
    out.serverScore = r.score.overall;
    out.postedText = sent && sent.body.text;
    out.postedRate = sent && sent.body.sample_rate;
    out.postedAudioIsB64 = !!(sent && /^[A-Za-z0-9+/=]+$/.test(sent.body.audio));

    // 渲染层：验证总分/分项/逐字卡片
    window.__renderAssess({
      score: { overall: 78, phone: 82, tone: 65, flu: 88, pron: 0 },
      words: [{ chars: [{ w: '长', sc: 92 }, { w: '城', sc: 64 }, { w: '好', sc: 41 }], sc: 66 }],
    });
    out.render = {
      score: document.getElementById('as-score').textContent,
      dims: document.querySelectorAll('#as-dims .as-dim').length,
      chars: document.querySelectorAll('#as-chars .as-char').length,
      good: document.querySelectorAll('#as-chars .as-char.good').length,
      ok: document.querySelectorAll('#as-chars .as-char.ok').length,
      bad: document.querySelectorAll('#as-chars .as-char.bad').length,
      tip: document.getElementById('as-tip').textContent.length,
      visible: !document.getElementById('as-result').hidden,
    };
    window.fetch = origFetch;
    return out;
  });
  check('endpoint save/load roundtrip', conf.configured === true && conf.roundtrip === true, JSON.stringify(conf));
  check('configured → mic enabled', conf.micEnabled === true, JSON.stringify(conf));
  check('assess posts 16k base64 + target text',
    conf.postedText === '长城' && conf.postedRate === 16000 && conf.postedAudioIsB64 === true
    && conf.serverScore === 88, JSON.stringify(conf));
  const r0 = conf.render;
  check('assess result renders (score/dims/chars/tip)',
    r0.score === '78' && r0.dims === 4 && r0.chars === 3
    && r0.good === 1 && r0.ok === 1 && r0.bad === 1 && r0.tip > 0 && r0.visible === true,
    JSON.stringify(r0));
  // 收尾：关掉评测弹窗与词卡弹窗，否则遮罩会吃掉后续步骤的导航点击
  await page.evaluate(() => {
    window.__closeAssess && window.__closeAssess();
    document.querySelectorAll('[data-close-vocab]').forEach((el) => el.click());
    window.SpeechAssess.setEndpoint('');   // 不污染后续用例
  });

  // 7. 标题单行不换行（white-space: nowrap 生效）
  const nowrap = await page.evaluate(() => {
    const h1 = document.querySelector('.header h1');
    const cs = getComputedStyle(h1);
    return { ws: cs.whiteSpace, sw: h1.scrollWidth, cw: h1.clientWidth };
  });
  check('title nowrap', nowrap.ws === 'nowrap', JSON.stringify(nowrap));

  // 8. 句子页：课程卡片网格 + 底部筛选栏
  await page.click('[data-section="sentence"]');
  await new Promise((r) => setTimeout(r, 400));
  const sent = await page.evaluate(() => ({
    cards: document.querySelectorAll('.course-card').length,
    bottomBar: !!document.querySelector('#sentence .section-bottom-bar'),
    barPos: getComputedStyle(document.querySelector('#sentence .section-bottom-bar')).position,
    levels: document.querySelectorAll('#sent-level-tabs .level-tab').length,
  }));
  check('sentence course cards', sent.cards === 14, JSON.stringify(sent));
  check('sentence bottom bar fixed', sent.bottomBar && sent.barPos === 'fixed', JSON.stringify(sent));
  check('sentence level tabs', sent.levels === 6, JSON.stringify(sent));
  // HSK 1-6 筛选改为 2 行 × 3 列网格
  const tabsGrid = await page.evaluate(() => {
    const tabs = document.querySelector('#sent-level-tabs');
    const cs = getComputedStyle(tabs);
    const first = tabs.querySelector('.level-tab').getBoundingClientRect();
    const second = tabs.querySelectorAll('.level-tab')[3].getBoundingClientRect();
    const bar = document.querySelector('#sentence .section-bottom-bar').getBoundingClientRect();
    const clipped = [...tabs.querySelectorAll('.level-tab')]
      .filter((t) => t.scrollWidth > t.clientWidth + 1).length;
    return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length,
             twoRows: second.top > first.top + 2, barH: Math.round(bar.height), clipped,
             count: tabs.querySelectorAll('.level-tab').length };
  });
  // 布局已按需求重做为「单行 6 列 + 等级/数量上下分层」，栏高从 92px 压到 ~59px
  check('sentence HSK tabs single-row 6 cols',
    tabsGrid.display === 'grid' && tabsGrid.cols === 6 && tabsGrid.twoRows === false,
    JSON.stringify(tabsGrid));
  check('HSK tab bar height compact', tabsGrid.barH <= 60, 'barH=' + tabsGrid.barH);
  check('HSK tab labels not clipped', tabsGrid.clipped === 0, 'clipped=' + tabsGrid.clipped);

  // 底部筛选栏是 position:fixed(left:0;right:0)，一旦出现横向外边距就会撑出视口，
  // 表现为第一个标签被屏幕左缘切掉（实测曾溢出 27px）。这里锁死。
  const barFit2 = await page.evaluate(() => {
    const bar = document.querySelector('#sentence .section-bottom-bar');
    const b = bar.getBoundingClientRect();
    const tabs = [...bar.querySelectorAll('.level-tab')];
    const first = tabs[0].getBoundingClientRect();
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), vw: innerWidth,
             firstLeft: Math.round(first.left), lastRight: Math.round(last.right),
             barW: Math.round(b.width) };
  });
  check('filter bar stays inside viewport',
    barFit2.left >= 0 && barFit2.right <= barFit2.vw + 1 && barFit2.barW <= barFit2.vw
      && barFit2.firstLeft >= 0 && barFit2.lastRight <= barFit2.vw,
    JSON.stringify(barFit2));

  // 9. 点开课程卡片 → 句子 + 返回按钮 → 返回卡片网格
  await page.click('.course-card');
  await new Promise((r) => setTimeout(r, 400));
  const detail = await page.evaluate(() => ({
    sentences: document.querySelectorAll('.sentence-row').length,
    back: !!document.querySelector('[data-back]'),
  }));
  check('course detail sentences', detail.sentences >= 5, JSON.stringify(detail));
  check('course back button', detail.back === true, JSON.stringify(detail));
  await page.click('[data-back]');
  await new Promise((r) => setTimeout(r, 300));
  const backGrid = await page.evaluate(() => document.querySelectorAll('.course-card').length);
  check('back to course grid', backGrid === 14, 'n=' + backGrid);

  // 9.5 固定筛选栏必须给内容区留出等高内边距，否则最后一行卡片会被遮住
  await page.click('[data-section="sentence"]');
  await new Promise((r) => setTimeout(r, 400));
  const barFit = await page.evaluate(() => {
    const bar = document.querySelector('#sentence .section-bottom-bar');
    const box = document.querySelector('#course-content');
    const cs = getComputedStyle(document.documentElement);
    return {
      measured: cs.getPropertyValue('--filter-bar-h').trim(),
      barH: Math.round(bar.getBoundingClientRect().height),
      pad: parseFloat(getComputedStyle(box).paddingBottom),
      navH: 54,
    };
  });
  check('filter bar height measured',
    /px$/.test(barFit.measured) && parseFloat(barFit.measured) === barFit.barH,
    JSON.stringify(barFit));
  check('content clears fixed filter bar',
    barFit.pad >= barFit.barH + barFit.navH,
    `padding=${barFit.pad} need>=${barFit.barH + barFit.navH}`);

  // 切换所有 HSK 等级，筛选栏位置必须始终一致（此前 sticky 会随内容长短漂移）
  const barBottoms = new Set();
  for (let i = 1; i <= 6; i++) {
    await page.evaluate((n) => document.querySelectorAll('#sent-level-tabs .level-tab')[n - 1].click(), i);
    await new Promise((r) => setTimeout(r, 220));
    barBottoms.add(await page.evaluate(() =>
      Math.round(document.querySelector('#sentence .section-bottom-bar').getBoundingClientRect().bottom)));
  }
  check('filter bar pinned across HSK 1-6', barBottoms.size === 1, 'bottoms=' + [...barBottoms].join('/'));

  // 10. 学词页底部筛选栏 + 切换 HSK 3
  await page.click('[data-section="learn"]');
  await new Promise((r) => setTimeout(r, 300));
  const learnBar = await page.evaluate(() => ({
    bar: !!document.querySelector('#learn .section-bottom-bar'),
    pos: getComputedStyle(document.querySelector('#learn .section-bottom-bar')).position,
    tabs: document.querySelectorAll('#level-tabs .level-tab').length,
  }));
  check('learn bottom bar fixed', learnBar.bar && learnBar.pos === 'fixed', JSON.stringify(learnBar));
  await page.click('#level-tabs .level-tab[data-level="3"]');
  await new Promise((r) => setTimeout(r, 300));
  const lv3 = await page.evaluate(() => ({
    active: (document.querySelector('#level-tabs .level-tab.active') || {}).textContent,
    count: (document.getElementById('vocab-count') || {}).textContent,
    firstCard: (document.querySelector('.vocab-hanzi') || {}).textContent,
  }));
  check('learn switch HSK3', lv3.active.indexOf('HSK 3') !== -1 && lv3.count === '973', JSON.stringify(lv3));

  // 11. 跨级搜索：搜一个 HSK5 的词，点它必须弹词卡（旧 bug：只查当前等级）
  await page.evaluate(() => {
    const input = document.getElementById('search-input');
    input.value = '经济';
    input.dispatchEvent(new Event('input'));
  });
  await new Promise((r) => setTimeout(r, 400));
  const cross = await page.evaluate(() => {
    const card = document.querySelector('.vocab-card');
    if (!card) return { err: 'no card' };
    const word = card.dataset.word;
    card.click();
    const m = document.getElementById('vocab-modal');
    return {
      word: word,
      opened: m.classList.contains('open'),
      hanzi: (document.getElementById('vm-hanzi') || {}).textContent,
    };
  });
  check('cross-level search card opens', cross.opened === true && cross.hanzi === cross.word, JSON.stringify(cross));

  console.log('==== RESULTS ====');
  Object.keys(results).forEach((k) => console.log((results[k] === 'PASS' ? '✅ ' : '❌ ') + k + ' :: ' + results[k]));
  const fails = Object.keys(results).filter((k) => results[k] !== 'PASS').length;
  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
  console.log('PAGE ERRORS (' + errors.length + '):');
  errors.slice(0, 15).forEach((e) => console.log('  ' + e));
  await browser.close();
  process.exit(fails === 0 && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
