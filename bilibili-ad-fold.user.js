// ==UserScript==
// @name         B站动态带货折叠
// @namespace    local.bilibili.adfold
// @version      1.4.3
// @updateURL    https://raw.githubusercontent.com/areusa/bilibili-ad-fold-release/main/bilibili-ad-fold.user.js
// @downloadURL  https://raw.githubusercontent.com/areusa/bilibili-ad-fold-release/main/bilibili-ad-fold.user.js
// @description  折叠动态带货，提示视频推广信息，并在原生进度条标记疑似推广区间
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/watchlater*
// @match        https://www.bilibili.com/zh-Hans/video/*
// @match        https://www.bilibili.com/zh-Hant/video/*
// @match        https://www.bilibili.com/zh-Hans/list/watchlater*
// @match        https://www.bilibili.com/zh-Hant/list/watchlater*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      bsbsb.top
// @connect      aisubtitle.hdslb.com
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  // 规则在本机执行；视频首评未加载时匿名预取B站接口，不读取Cookie或上传文案。
  const productWords = '电动牙刷|冲牙器|小冰被|凉感被|空调被|泡芙被|棉花被|冬被|被子|卫衣|连帽|按摩仪|按摩器|筋膜枪|剃须刀|脱毛仪|洗脸巾|洗地机|扫地机器人|护眼灯|人体工学椅'.split('|');
  const PRODUCT = new RegExp(productWords.join('|'));
  const GROUPS = [
    ['领券导购', /领券|评论区.{0,16}(?:下单|链接|优惠|羊毛)|点击.{0,12}(?:购买|下单|链接)|橱窗|购买链接/],
    ['促销价格', /大促|抄底价|地板价|到手价|底价|优惠券|限时优惠|不要\s*\d+|\d+\s*\+?\s*(?:元|就能带回家)/],
    ['售后承诺', /运费险|运险|贰险|以换代修|免费换新|保价.{0,5}[年月天]|[一二两三\d]+年.{0,12}(?:质保|换新|保修|质量问题)/],
    ['跨平台低价', /某[宝东猫多物音]|[淘京拼得]宝?\s*\d*.{0,12}(?:咱们|只要|仅)|咱们仅|买贵退差/],
    ['购买动员', /推荐.{0,12}(?:入手|大家|试试)|安排上|自用.{0,8}送|送礼.{0,8}自用|有需要.{0,12}(?:领券|入手|试试)|赶紧.{0,8}(?:买|入手)/]
  ];
  function classify(text, goods) {
    const normalized = text.toLocaleLowerCase();
    const matches = keywords.filter(word => normalized.includes(word.toLocaleLowerCase()));
    if (matches.length) return matches.map(word => `自定义关键词：${word}`);
    if (goods) return ['商品卡片或商品链接'];
    const hits = GROUPS.filter(([, re]) => re.test(text)).map(([name]) => name);
    return PRODUCT.test(text) && hits.length >= 2 && (hits.includes('领券导购') || hits.includes('售后承诺') || hits.includes('跨平台低价'))
      ? [`商品词：${productWords.filter(word => text.includes(word)).join('、')}`, ...GROUPS.filter(([name]) => hits.includes(name)).map(([name, re]) => `${name}：${text.match(re)[0]}`)] : [];
  }
  function matchDetails(text, goods) {
    // 仅对本轮已判定的广告提取详情并缓存；hover时不遍历动态、不改变扫描时序。
    const lines = [];
    const normalized = text.toLocaleLowerCase();
    const custom = keywords.filter(word => normalized.includes(word.toLocaleLowerCase()));
    if (custom.length) lines.push(`自定义词：${custom.join('、')}`);
    if (goods) lines.push('结构：商品卡片或商品链接');
    const products = productWords.filter(word => text.includes(word));
    if (products.length) lines.push(`商品词：${products.join('、')}`);
    for (const [name, re] of GROUPS) {
      const found = [...new Set(Array.from(text.matchAll(new RegExp(re.source, 'g')), match => match[0]))];
      if (found.length) lines.push(`${name}：${found.slice(0, 8).join('、')}${found.length > 8 ? `（另${found.length - 8}项）` : ''}`);
    }
    return lines;
  }
  const CARD = '.bili-dyn-list__item';
  const TEXT = '.dyn-card-opus__title,.dyn-card-opus__summary,.bili-dyn-content__orig__desc,.bili-dyn-content__forw__desc';
  const GOODS = '.bili-dyn-card-goods,.goods-shop,.bili-rich-text-module.goods';
  const states = new Map();
  // 全部动态的锚点与判定信息；展示是否折叠仍由卡片自身状态决定。
  const entries = new Map();
  let keywords = GM_getValue('customKeywords', []);
  if (!Array.isArray(keywords)) keywords = [];
  keywords = keywords.filter(word => typeof word === 'string' && word.trim()).map(word => word.trim());
  let allowed = GM_getValue('allowedAuthors', []);
  if (!Array.isArray(allowed)) allowed = [];
  // 普通视频从路径取编号；稍后再看在同一路径内用查询参数切换视频。
  // 只移除明确支持的语言前缀，不把推荐卡片或其他页面当作当前播放视频。
  function videoPagePath() {
    return location.pathname.replace(/^\/zh-(?:Hans|Hant)(?=\/)/i, '');
  }
  function isVideoPage() {
    const path = videoPagePath();
    return /^\/video\//.test(path) || /^\/list\/watchlater\/?$/.test(path);
  }
  function currentVideoKey() {
    const path = videoPagePath();
    const video = path.match(/^\/video\/(BV[0-9A-Za-z]+|av[1-9]\d*)(?:\/|$)/);
    if (video) return video[1];
    if (!/^\/list\/watchlater\/?$/.test(path)) return null;
    const params = new URLSearchParams(location.search);
    const bvid = params.get('bvid');
    if (/^BV[0-9A-Za-z]+$/.test(bvid || '')) return bvid;
    const aid = params.get('oid');
    return /^[1-9]\d*$/.test(aid || '') ? `av${aid}` : null;
  }
  function pageVideoAid(key) {
    if (key !== currentVideoKey()) return '';
    if (/^av[1-9]\d*$/.test(key || '')) return key.slice(2);
    if (!/^\/list\/watchlater\/?$/.test(videoPagePath())) return '';
    const params = new URLSearchParams(location.search);
    const aid = params.get('oid');
    if (params.get('bvid') !== key || !/^[1-9]\d*$/.test(aid || '')) return '';
    // 列表换集时URL和组件可能分批更新，同时核对标题链接与评论绑定编号。
    const title = document.querySelector?.('h1 a[href]');
    const comments = document.querySelector?.('#commentapp bili-comments,bili-comments');
    if (comments?.getAttribute('data-params') !== `1,${aid}`) return '';
    try {
      const href = title?.getAttribute('href');
      if (!href) return '';
      const url = new URL(href, 'https://www.bilibili.com/');
      const path = url.pathname.replace(/^\/zh-(?:Hans|Hant)(?=\/)/i, '');
      return url.hostname === 'www.bilibili.com' && path.replace(/\/$/, '') === `/video/${key}` ? aid : '';
    } catch { return ''; }
  }
  const segmentRulesVersion = '区间规则1.0';
  if (isVideoPage()) {
    // 层级：主要为“可能存在广告”，次要为来源和命中内容，关闭为低强调操作。
    // 沿用站点背景/文字Token、B站粉色、10px圆角和180ms ease-out；不改变播放器尺寸。
    const noticeHost = document.createElement('div');
    noticeHost.id = 'baf-video-notice';
    noticeHost.style.cssText = 'position:absolute;left:12px;top:12px;z-index:80;max-width:calc(100% - 24px);pointer-events:none;';
    const ui = noticeHost.attachShadow({ mode: 'open' });
    // 图标采用 MingCute @mingcute/svg 3.0.2 的 alert/close，保留原始路径，许可见 vendor/mingcute。
    ui.innerHTML = `<style>
      :host{font:13px/1.6 sans-serif;color:var(--text1,#18191c)}
      *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:0;color:inherit;background:transparent;padding:0}
      .notice{display:flex;flex-direction:column;width:320px;max-width:100%;max-height:var(--baf-video-max-height,240px);padding:10px;background:var(--bg1,#fff);border:1px solid var(--line_regular,#e3e5e7);border-radius:10px;box-shadow:0 4px 16px #0003;overflow:hidden;pointer-events:auto;transition:width 180ms ease-out,padding 180ms ease-out,border-radius 180ms ease-out}
      .header{display:flex;flex:none;align-items:center;gap:8px;transition:gap 180ms ease-out}
      .toggle{width:24px;height:24px;flex:none;color:#fb7299;display:grid;place-items:center;border-radius:6px}
      svg{width:20px;height:20px;fill:currentColor;pointer-events:none}
      .title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;max-width:260px;opacity:1;transition:max-width 180ms ease-out,opacity 180ms ease-out}
      .close{width:24px;height:24px;flex:none;border-radius:6px;display:grid;place-items:center;color:var(--text2,#61666d);transition:width 180ms ease-out,opacity 180ms ease-out}
      button:hover{background:var(--bg2,#f1f2f3)}button:focus-visible{outline:2px solid #00aeec;outline-offset:1px}
      .details{margin-top:8px;min-height:0;max-height:132px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-width:none;opacity:1;transition:max-height 180ms ease-out,margin-top 180ms ease-out,opacity 180ms ease-out}
      .details::-webkit-scrollbar{display:none}.details p{margin:0 0 6px}.details p:last-child{margin-bottom:0}
      .source{font-weight:600}.evidence{font-size:12px;color:var(--text2,#61666d)}
      .notice[data-expanded="false"]{width:34px;padding:4px;border-radius:999px}
      .notice[data-expanded="false"] .header{gap:0}
      .notice[data-expanded="false"] .title{max-width:0;flex:0;opacity:0;visibility:hidden}
      .notice[data-expanded="false"] .close{width:0;opacity:0;visibility:hidden}
      .notice[data-expanded="false"] .details{max-height:0;margin-top:0;opacity:0;visibility:hidden}
      @media(prefers-reduced-motion:reduce){*{transition:none!important}}
    </style><section class="notice" data-expanded="true" aria-label="视频广告提示"><div class="header"><button class="toggle" type="button" aria-label="展开广告提示" aria-expanded="true"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v4m0 3h.002m-8.636 3.353h17.268a.5.5 0 0 0 .433-.75L12.433 3.648a.5.5 0 0 0-.866 0L2.933 18.603a.5.5 0 0 0 .433.75"/></svg></button><strong class="title">此视频可能存在广告</strong><button class="close" type="button" aria-label="关闭本视频广告提示" title="关闭本视频广告提示"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="m5.636 5.637 12.728 12.728m-12.728 0L18.364 5.637"/></svg></button></div><div class="details" role="status" aria-live="polite"></div></section>`;
    const notice = ui.querySelector('.notice');
    const details = ui.querySelector('.details');
    const toggle = ui.querySelector('.toggle');
    const closedVideos = new Set();
    const announcedVideos = new Set();
    const sourceObservers = new Map();
    let videoKey = currentVideoKey();
    let previousSamples = new Map();
    let staleSamples = new Map();
    let collapseTimer;
    let scanTimer;
    let mountedPlayer = null;
    let restorePosition = null;
    let lastEvidence = '';
    let latestHits = [];
    let lastProbe = [];
    const preflightCache = new Map();
    let activePreflight = null;
    const preflightPolicy = { settle: 500, gap: 1000, total: 12000, request: 8000, limitCooldown: 60000, networkCooldown: 30000, cache: 300000 };
    const gateKey = 'videoApiScheduleV1';
    const gateLock = 'baf-video-api-v1';
    let routeEpoch = 0;
    let routeStableAt = Date.now() + preflightPolicy.settle;
    let preflightWake = null;
    let preflightWakeAt = 0;
    let sourceCoverage = { description: false, comment: false };
    const naturalLoads = new Map();
    let activeNaturalLoad = null;
    function stopNaturalLoad(reason) {
      const record = activeNaturalLoad;
      if (!record) return;
      activeNaturalLoad = null;
      clearTimeout(record.timer);
      clearTimeout(record.followTimer);
      window.removeEventListener('scroll', record.onScroll);
      window.removeEventListener('resize', record.onResize);
      // 仅还原本次仍持有的属性，不覆盖加载期间站点新写入的其他样式。
      for (const [name, saved] of record.styles) {
        if (record.node.style.getPropertyValue(name) !== record.applied[name] || record.node.style.getPropertyPriority(name) !== 'important') continue;
        if (saved.value) record.node.style.setProperty(name, saved.value, saved.priority);
        else record.node.style.removeProperty(name);
      }
      if (!record.hadStyle && record.node.style.length === 0) record.node.removeAttribute('style');
      record.status = reason;
      record.node = null;
      record.styles = null;
      queueVideoScan();
    }
    function startNaturalLoad(key) {
      if (activeNaturalLoad?.key === key) return true;
      if (!key || key !== currentVideoKey() || document.hidden || document.fullscreenElement || closedVideos.has(key) || naturalLoads.has(key)) return false;
      if (Date.now() < routeStableAt) { wakePreflight(routeStableAt); return false; }
      const node = document.querySelector?.('#commentapp') || document.querySelector?.('#comment');
      if (!node?.getBoundingClientRect || !node.style) return false;
      const rect = node.getBoundingClientRect();
      // 只处理视口下方的评论区，避免改变用户正在阅读的区域或上方内容的锚定。
      if (rect.top < window.innerHeight || rect.width <= 0) return false;
      const computed = getComputedStyle(node).transform;
      const applied = {
        transition: 'none',
        opacity: '0',
        'pointer-events': 'none',
        'overflow-anchor': 'none',
        transform: `translateY(${window.innerHeight - 2 - rect.top}px)${computed && computed !== 'none' ? ' ' + computed : ''}`
      };
      const styles = new Map(Object.keys(applied).map(name => [name, { value: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) }]));
      const record = { key, node, styles, applied, baseTransform: computed && computed !== 'none' ? ' ' + computed : '', offset: window.innerHeight - 2 - rect.top, hadStyle: node.hasAttribute('style'), status: 'pending', x: window.scrollX, y: window.scrollY };
      record.onScroll = () => { if (window.scrollX !== record.x || window.scrollY !== record.y) stopNaturalLoad('scroll'); };
      record.onResize = () => stopNaturalLoad('resize');
      activeNaturalLoad = record;
      naturalLoads.set(key, record);
      if (naturalLoads.size > 20) naturalLoads.delete(naturalLoads.keys().next().value);
      window.addEventListener('scroll', record.onScroll, { passive: true });
      window.addEventListener('resize', record.onResize, { passive: true });
      for (const [name, value] of Object.entries(applied)) {
        node.style.setProperty(name, value, 'important');
        applied[name] = node.style.getPropertyValue(name);
      }
      // 由真实几何交集触发站点自己的懒加载，不改innerHeight、不伪造观察器回调。
      record.timer = setTimeout(() => stopNaturalLoad('timeout'), 8000);
      const followLayout = () => {
        if (activeNaturalLoad !== record) return;
        if (!node.isConnected) { stopNaturalLoad('replaced'); return; }
        if (window.scrollX !== record.x || window.scrollY !== record.y) { stopNaturalLoad('scroll'); return; }
        const delta = window.innerHeight - 2 - node.getBoundingClientRect().top;
        // 播放器、简介初始化可能继续改变评论位置，只在短窗口内修正实际交集。
        if (Math.abs(delta) > 0.5) {
          record.offset += delta;
          node.style.setProperty('transform', `translateY(${record.offset}px)${record.baseTransform}`, 'important');
          applied.transform = node.style.getPropertyValue('transform');
        }
        record.followTimer = setTimeout(followLayout, 100);
      };
      record.followTimer = setTimeout(followLayout, 100);
      return true;
    }
    function videoLocks() {
      // 部分油猴沙箱不提供Web Locks，或在访问该属性时抛出异常。
      try { return typeof navigator.locks?.request === 'function' ? navigator.locks : null; }
      catch { return null; }
    }
    function readPreflightGate() {
      const saved = GM_getValue(gateKey, {}) || {};
      const valid = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
      return { nextRequestAt: valid(saved.nextRequestAt), cooldownUntil: valid(saved.cooldownUntil) };
    }
    function wakePreflight(at) {
      if (document.hidden || closedVideos.has(videoKey)) return;
      if (preflightWake && preflightWakeAt <= at) return;
      clearTimeout(preflightWake);
      preflightWakeAt = at;
      preflightWake = setTimeout(() => { preflightWake = null; queueVideoScan(); }, Math.min(2147483647, Math.max(0, at - Date.now())));
    }
    function stopPreflight(reason) {
      const record = activePreflight;
      if (!record) return;
      activePreflight = null;
      record.status = reason === 'hidden' ? 'paused' : reason === 'covered' ? 'ready' : reason === 'closed' ? 'closed' : reason === 'deadline' ? 'failed' : 'cancelled';
      record.stopReason = reason;
      record.expires = Date.now() + preflightPolicy.cache;
      clearTimeout(record.deadlineTimer);
      if (reason === 'route') preflightCache.delete(record.key);
      record.controller.abort();
    }
    function preflightDiagnostic() {
      const key = currentVideoKey();
      const record = preflightCache.get(key);
      const gate = readPreflightGate();
      const coverage = key === videoKey ? sourceCoverage : { description: false, comment: false };
      const natural = naturalLoads.get(key);
      const naturalStates = { pending: '触发中（最多8秒）', loaded: '首评已加载，样式已恢复', timeout: '已超时并恢复样式', scroll: '用户滚动，已恢复样式', resize: '视口变化，已恢复样式', route: '视频切换，已恢复样式', hidden: '进入后台，已恢复样式', closed: '提示关闭，已恢复样式', replaced: '组件替换，已恢复样式' };
      const states = { pending: '进行中', ready: '已完成', paused: '后台暂停', closed: '手动关闭', failed: '失败，本轮不自动重试', cancelled: '已取消' };
      const failures = { limited: '接口限流或风控', network: '网络或HTTP错误', timeout: '请求或整轮超时', api: '接口业务错误或响应格式错误', cooldown: '共享冷却尚未结束', budget: '本轮请求次数已耗尽', covered: '页面内容已加载', cancelled: '任务已失效', capability: '浏览器能力或油猴沙箱调用异常' };
      let status = states[record?.status] || '等待启动';
      if (record?.status === 'failed' && record.comment) status = '首评已取得，补充简介失败';
      if (!key) status = '地址中没有有效视频编号';
      else if (typeof GM_xmlhttpRequest !== 'function') status = '油猴未提供GM_xmlhttpRequest，无法接口预检';
      else if (!videoLocks()) status = 'Web Locks不可用，已退回页面检测；不会提前请求首评';
      else if (closedVideos.has(key)) status = '本视频提示已手动关闭';
      else if (document.hidden) status = '页面在后台，已暂停接口预检';
      else if (coverage.description && coverage.comment) status = '简介和有效首评已由页面加载';
      else if (natural?.status === 'pending') status = '正在触发页面评论懒加载';
      const remaining = Math.ceil(Math.max(0, gate.cooldownUntil - Date.now()) / 1000);
      return [
        '脚本版本：1.3.7', `当前视频：${key || '无'}`, `评论预检：${status}`,
        `页面加载触发：${naturalStates[natural?.status] || '尚未触发或无需触发'}`,
        `页面首评：${coverage.comment ? '已有有效内容' : '未加载或仍为空白占位'}`,
        `接口首评：${record?.comment ? '已取得' : '未取得'}`,
        record?.aidSource ? `视频编号来源：${record.aidSource}` : '',
        `本轮请求次数：${record?.attempts || 0}/2`, `共享冷却剩余：${remaining}秒`,
        record?.lastPath ? `最近接口：${record.lastPath}` : '',
        Number.isFinite(record?.lastHttpStatus) ? `HTTP状态：${record.lastHttpStatus}` : '',
        Number.isFinite(record?.lastApiCode) ? `接口业务码：${record.lastApiCode}` : '',
        record?.lastFailure ? `最近结果：${failures[record.lastFailure] || '未分类错误'}` : '',
        '此菜单只查看本地状态，不会发起请求或清除冷却。'
      ].filter(Boolean).join('\n');
    }
    const playerSize = new ResizeObserver(records => {
      for (const record of records) noticeHost.style.setProperty('--baf-video-max-height', `${Math.max(34, record.target.clientHeight - 24)}px`);
    });
    function expandVideoNotice(expanded) {
      clearTimeout(collapseTimer);
      notice.dataset.expanded = String(expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? '收起广告提示' : '展开广告提示');
      details.setAttribute('aria-hidden', String(!expanded));
      if (expanded) collapseTimer = setTimeout(() => expandVideoNotice(false), 5000);
    }
    function videoEvidence(element) {
      const text = (element?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
      const links = Array.from(element?.querySelectorAll('a[href],a[data-goods-key]') || []).filter(a => {
        if (a.dataset.type === 'goods' || a.hasAttribute('data-goods-key')) return true;
        const raw = a.getAttribute('data-raw-url') || a.getAttribute('href') || '';
        if (/^(?:https?:)?\/\/b23\.tv\/mall-/i.test(raw)) return true;
        try {
          const url = new URL(raw, location.href);
          return /(^|\.)(taobao\.com|tmall\.com|jd\.com|yangkeduo\.com|pinduoduo\.com|mall\.bilibili\.com)$/.test(url.hostname) && /coupon|item|detail|product|^\/t(?:\/|$)/i.test(url.pathname);
        } catch { return false; }
      });
      const reasons = classify(text, false);
      if (links.length) reasons.unshift(...links.slice(0, 2).map(a => `商品链接：${a.textContent.trim().slice(0, 70) || '优惠或商品入口'}`));
      else if (/https?:\/\/b23\.tv\/mall-[^\s<>"']+/i.test(text)) reasons.unshift('商品链接：B站商品短链接');
      const declaration = text.match(/本(?:期|条|次)(?:视频|内容)?.{0,12}(?:由.{1,24}赞助|含.{0,4}(?:商业推广|付费推广))|商业推广|付费推广|品牌合作|赞助商|广告合作|合作推广/);
      if (declaration) reasons.push(`推广标识：${declaration[0]}`);
      if (!reasons.length && /领.{0,4}(?:券|优惠券)|【券\s*\d+/.test(text) && /大促|到手|划算|热销|囤货|抄底价/.test(text)) reasons.push('领券导购与促销文案同时出现');
      return { text, reasons: [...new Set(reasons)], signature: text + links.map(a => a.getAttribute('href')).join('|') };
    }
    function commentContentReady(element) {
      // 评论组件可能先建立空白#contents占位；节点存在不等于正文已经加载。
      const text = (element?.textContent || '').replace(/[\s\u200b-\u200d\ufeff]/g, '');
      return !!(text || element?.querySelector('img[src],video[src],audio[src],a[data-goods-key]'));
    }
    function preflightVideo(key) {
      // Web Locks提供同源标签页间的原子排队；缺失时只使用页面检测，不用非原子读写冒充互斥。
      const locks = videoLocks();
      if (typeof GM_xmlhttpRequest !== 'function' || !locks || !/^(?:BV[0-9A-Za-z]+|av\d+)$/.test(key)) return null;
      const cached = preflightCache.get(key);
      if (cached?.status === 'pending' || (cached && cached.status !== 'paused' && cached.expires > Date.now())) return cached;
      if (document.hidden || closedVideos.has(key) || key !== currentVideoKey() || activePreflight) return cached || null;
      const gate = readPreflightGate();
      const availableAt = Math.max(routeStableAt, gate.nextRequestAt, gate.cooldownUntil);
      if (availableAt > Date.now()) { wakePreflight(availableAt); return cached || null; }
      clearTimeout(preflightWake);
      preflightWake = null;
      const knownAid = pageVideoAid(key);
      const record = cached?.status === 'paused' && cached.expires > Date.now() ? cached : { key, description: null, comment: null, aid: knownAid, aidSource: knownAid ? '页面已有编号（已核对）' : '', attempts: 0, deadlineAt: Date.now() + preflightPolicy.total };
      if (!record.aid && knownAid) { record.aid = knownAid; record.aidSource = '页面已有编号（已核对）'; }
      // 后台暂停后恢复也沿用本轮预算，避免反复切换前后台扩大请求次数。
      if (record.attempts >= 2 || record.deadlineAt <= Date.now()) { record.status = 'failed'; return record; }
      Object.assign(record, { status: 'pending', epoch: routeEpoch, controller: new AbortController(), expires: Date.now() + preflightPolicy.cache, request: null, stopReason: '' });
      preflightCache.set(key, record);
      if (preflightCache.size > 20) preflightCache.delete(preflightCache.keys().next().value);
      activePreflight = record;
      const isCurrent = () => currentVideoKey() === key && record.epoch === routeEpoch && record.status === 'pending' && !record.controller.signal.aborted && !document.hidden && !closedVideos.has(key);
      const failure = (kind, response) => Object.assign(new Error(kind), { kind, response });
      const assertCurrent = () => {
        if (!isCurrent()) throw failure('cancelled');
        // 浏览器可能推迟定时器；响应处理仍按绝对截止时间校验。
        if (Date.now() >= record.deadlineAt) throw failure('timeout');
      };
      const signal = record.controller.signal;
      const wait = ms => new Promise((resolve, reject) => {
        if (signal.aborted) { reject(failure('cancelled')); return; }
        const done = () => { signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(done, ms);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(failure('cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
      });
      record.deadlineTimer = setTimeout(() => { if (activePreflight === record) stopPreflight('deadline'); }, record.deadlineAt - Date.now());
      const request = (path, params) => locks.request(gateLock, { signal }, async () => {
        assertCurrent();
        let shared = readPreflightGate();
        if (shared.cooldownUntil > Date.now()) throw failure('cooldown');
        if (shared.nextRequestAt > Date.now()) await wait(shared.nextRequestAt - Date.now());
        assertCurrent();
        // 等待间隔期间，正文可能已经由页面加载，不再发送多余请求。
        if (sourceCoverage.description && sourceCoverage.comment || path === '/x/v2/reply' && sourceCoverage.comment) throw failure('covered');
        shared = readPreflightGate();
        if (shared.cooldownUntil > Date.now()) throw failure('cooldown');
        if (record.attempts >= 2) throw failure('budget');
        record.attempts++;
        record.lastPath = path;
        record.lastHttpStatus = null;
        record.lastApiCode = null;
        record.lastFailure = '';
        GM_setValue(gateKey, { ...shared, nextRequestAt: Date.now() + preflightPolicy.gap });
        try {
          return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, data) => {
              if (settled) return;
              settled = true;
              record.request = null;
              signal.removeEventListener('abort', abort);
              if (error) reject(error); else resolve(data);
            };
            const abort = () => {
              const handle = record.request;
              finish(failure(record.stopReason === 'deadline' ? 'timeout' : 'cancelled'));
              try { handle?.abort(); } catch { /* 取消异常不影响状态失效。 */ }
            };
            signal.addEventListener('abort', abort, { once: true });
            let handle;
            try { handle = GM_xmlhttpRequest({
              method: 'GET',
              url: 'https://api.bilibili.com' + path + '?' + new URLSearchParams(params),
              anonymous: true,
              timeout: preflightPolicy.request,
              responseType: 'json',
              headers: { Accept: 'application/json', Referer: 'https://www.bilibili.com/' },
              onload(response) {
                try { assertCurrent(); } catch (error) { finish(error); return; }
                try {
                  record.lastHttpStatus = response.status;
                  if ([403, 412, 429, 503].includes(response.status)) throw failure('limited', response);
                  if (response.status !== 200) throw failure('network', response);
                  const raw = response.response;
                  const payload = raw && typeof raw === 'object' ? raw : JSON.parse(typeof raw === 'string' ? raw : response.responseText);
                  record.lastApiCode = payload?.code;
                  if ([-352, -412, -509].includes(payload?.code)) throw failure('limited', response);
                  if (payload?.code !== 0 || !payload.data) throw failure('api', response);
                  finish(null, payload.data);
                } catch (error) { finish(error.kind ? error : failure('api', response)); }
              },
              onerror: () => finish(failure('network')),
              ontimeout: () => finish(failure('timeout')),
              onabort: () => finish(failure('cancelled'))
            }); } catch { finish(failure('network')); }
            if (!settled) record.request = handle;
          });
        } catch (error) {
          if (['limited', 'network', 'timeout', 'api'].includes(error.kind)) {
            let cooldown = error.kind === 'limited' ? preflightPolicy.limitCooldown : preflightPolicy.networkCooldown;
            const retry = error.response?.responseHeaders?.match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
            if (retry) {
              const seconds = Number(retry);
              const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(retry) - Date.now();
              if (Number.isFinite(delay)) cooldown = Math.max(cooldown, delay);
            }
            const saved = readPreflightGate();
            GM_setValue(gateKey, { ...saved, cooldownUntil: Math.max(saved.cooldownUntil, Date.now() + cooldown) });
          }
          throw error;
        }
      });
      (async () => {
        try {
          // 每轮最多两个只读请求，不发送登录凭据、不追踪商品链接。
          const readDescription = async () => {
            const view = await request('/x/web-interface/view', key.startsWith('BV') ? { bvid: key } : { aid: key.slice(2) });
            assertCurrent();
            const aid = String(view.aid || '');
            if (!/^[1-9]\d*$/.test(aid) || record.aid && record.aid !== aid) throw failure('api');
            record.aid = aid;
            if (!record.aidSource) record.aidSource = '视频信息接口';
            const description = document.createElement('div');
            description.textContent = String(view.desc || '').slice(0, 20000);
            record.description = description;
            queueVideoScan();
          };
          if (!record.aid) await readDescription();
          if (!sourceCoverage.comment && !record.comment) {
            const reply = await request('/x/v2/reply', { type: '1', oid: record.aid, sort: '1', pn: '1', ps: '1' });
            assertCurrent();
            const top = [reply.top_replies?.[0], reply.upper?.top, reply.top?.upper, reply.top?.admin, reply.top?.vote].find(item => typeof item?.content?.message === 'string');
            const first = top || reply.replies?.[0];
            if (first?.content && typeof first.content.message === 'string') {
              const content = document.createElement('div');
              content.textContent = first.content.message.slice(0, 20000);
              // 响应文本不作为HTML执行；仅重建有限的链接元数据供现有规则读取。
              for (const [raw, meta] of Object.entries(first.content.jump_url || {}).slice(0, 24)) {
                if (!meta || typeof meta !== 'object') continue;
                let url;
                try { url = new URL(meta.pc_url || raw, 'https://www.bilibili.com/'); } catch { continue; }
                if (!/^https?:$/.test(url.protocol)) continue;
                const link = document.createElement('a');
                link.href = url.href;
                link.textContent = String(meta.title || '商品入口').slice(0, 100);
                link.dataset.rawUrl = raw;
                if (meta.extra?.goods_item_id) link.dataset.type = 'goods';
                content.append(document.createTextNode(' '), link);
              }
              record.comment = { name: top ? '首条评论（置顶·接口预检）' : '首条评论（接口预检）', element: content };
              queueVideoScan();
            }
          }
          // 首评不再依赖重复读取视频信息；只有简介缺失时才用剩余额度补充。
          if (!sourceCoverage.description && !record.description) await readDescription();
          record.status = 'ready';
        } catch (error) {
          // 包括接口限流、风控或权限不足：结束本轮，等待页面自然加载，不绕过验证。
          record.lastFailure = error.kind || 'capability';
          if (record.status === 'pending') {
            record.status = error.kind === 'covered' ? 'ready' : error.kind === 'cancelled' ? 'cancelled' : 'failed';
            if (error.kind === 'cancelled' && preflightCache.get(key) === record) preflightCache.delete(key);
          }
        } finally {
          clearTimeout(record.deadlineTimer);
          record.expires = Date.now() + preflightPolicy.cache;
          record.request = null;
          if (activePreflight === record) activePreflight = null;
          if (currentVideoKey() === key && record.epoch === routeEpoch) queueVideoScan();
        }
      })();
      return record;
    }
    function scanVideoNotice() {
      scanTimer = null;
      const nextKey = currentVideoKey();
      if (nextKey !== videoKey) {
        stopNaturalLoad('route');
        stopPreflight('route');
        clearTimeout(preflightWake);
        preflightWake = null;
        routeEpoch++;
        routeStableAt = Date.now() + preflightPolicy.settle;
        sourceCoverage = { description: false, comment: false };
        videoKey = nextKey;
        staleSamples = previousSamples;
        previousSamples = new Map();
        lastEvidence = '';
        latestHits = [];
        noticeHost.hidden = true;
        expandVideoNotice(false);
      }
      const watched = new Map();
      const watch = (node, subtree = true) => { if (node) watched.set(node, subtree); return node; };
      const sources = [];
      const desc = document.querySelector('#v_desc .desc-info-text,.video-desc-container .desc-info-text,.video-desc-container .basic-desc-info');
      watch(document.querySelector('#v_desc,.video-desc-container'));
      if (desc) sources.push({ name: '视频简介', element: desc });
      const comments = document.querySelector('#commentapp bili-comments,bili-comments');
      watch(comments, false);
      if (comments?.shadowRoot) {
        const root = watch(comments.shadowRoot, false);
        const feed = watch(root.querySelector('#feed'), false);
        const thread = feed?.querySelector('bili-comment-thread-renderer');
        const threadRoot = watch(thread?.shadowRoot, false);
        const first = threadRoot?.querySelector('bili-comment-renderer');
        const firstRoot = watch(first?.shadowRoot);
        const rich = firstRoot?.querySelector('#content bili-rich-text');
        const richRoot = watch(rich?.shadowRoot);
        const content = richRoot?.querySelector('#contents');
        if (commentContentReady(content)) sources.push({ name: firstRoot.querySelector('#top') ? '首条评论（置顶）' : '首条评论', element: content });
      } else {
        const list = watch(document.querySelector('#commentapp .reply-list,#comment .reply-list,.bb-comment .comment-list,.bb-comment .reply-list'));
        const first = list?.querySelector('.reply-item,.root-reply-container,.list-item');
        const content = first?.querySelector('.root-reply .reply-content,.reply-content,.con > .text');
        if (commentContentReady(content)) sources.push({ name: '首条评论', element: content });
      }
      for (const [node, observer] of sourceObservers) if (!watched.has(node)) { observer.disconnect(); sourceObservers.delete(node); }
      for (const [node, subtree] of watched) if (!sourceObservers.has(node)) {
        const observer = new MutationObserver(queueVideoScan);
        observer.observe(node, { childList: true, characterData: true, subtree, attributes: true, attributeFilter: ['href', 'data-type', 'data-goods-key', 'data-raw-url', 'data-params'] });
        sourceObservers.set(node, observer);
      }
      latestHits = [];
      const currentSources = new Set();
      // 无有效编号的列表过渡页不采用残留的简介或首评。
      for (const source of videoKey ? sources : []) {
        const sample = videoEvidence(source.element);
        const sourceKey = source.name.startsWith('首条评论') ? '首条评论' : source.name;
        previousSamples.set(sourceKey, { signature: sample.signature, element: source.element });
        // 视频站内切换时，旧简介/旧置顶评论尚未替换前不沿用其判定。
        const stale = staleSamples.get(sourceKey);
        if (stale?.signature === sample.signature && stale.element === source.element) continue;
        staleSamples.delete(sourceKey);
        currentSources.add(sourceKey);
        if (sample.reasons.length) latestHits.push({ ...source, reasons: sample.reasons });
      }
      sourceCoverage = { description: currentSources.has('视频简介'), comment: currentSources.has('首条评论') };
      if (activeNaturalLoad && !activeNaturalLoad.node.isConnected) stopNaturalLoad('replaced');
      if (sourceCoverage.comment) stopNaturalLoad('loaded');
      const naturalPending = !sourceCoverage.comment && !closedVideos.has(videoKey) && startNaturalLoad(videoKey);
      if (sourceCoverage.description && sourceCoverage.comment) stopPreflight('covered');
      if (!sourceCoverage.comment || !sourceCoverage.description) {
        const preflight = closedVideos.has(videoKey) || naturalPending ? preflightCache.get(videoKey) : preflightVideo(videoKey);
        const fallbackSources = [];
        if (!currentSources.has('视频简介') && preflight?.description) fallbackSources.push({ name: '视频简介（接口预检）', element: preflight.description });
        if (!currentSources.has('首条评论') && preflight?.comment) fallbackSources.push(preflight.comment);
        for (const source of fallbackSources) {
          const sample = videoEvidence(source.element);
          if (sample.reasons.length) latestHits.push({ ...source, reasons: sample.reasons });
        }
      }
      const player = document.querySelector('.bpx-player-video-area') || document.querySelector('.bpx-player-container') || document.querySelector('#playerWrap');
      const commentsRoot = comments?.shadowRoot;
      const probeThread = commentsRoot?.querySelector('#feed bili-comment-thread-renderer')?.shadowRoot;
      const probeComment = probeThread?.querySelector('bili-comment-renderer')?.shadowRoot;
      lastProbe = [player, desc, commentsRoot, probeThread, probeComment, probeComment?.querySelector('bili-rich-text')?.shadowRoot];
      if (!videoKey || !latestHits.length || !player || closedVideos.has(videoKey)) {
        noticeHost.hidden = true;
        expandVideoNotice(false);
        return;
      }
      if (mountedPlayer !== player || !noticeHost.isConnected) {
        restorePosition?.();
        restorePosition = null;
        if (getComputedStyle(player).position === 'static') {
          const old = player.style.position;
          player.style.position = 'relative';
          restorePosition = () => { player.style.position = old; };
        }
        player.append(noticeHost);
        mountedPlayer = player;
        noticeHost.style.setProperty('--baf-video-max-height', `${Math.max(34, player.clientHeight - 24)}px`);
        playerSize.disconnect();
        playerSize.observe(player);
      }
      const evidence = JSON.stringify(latestHits.map(hit => [hit.name, hit.reasons]));
      if (evidence !== lastEvidence) {
        details.replaceChildren();
        for (const hit of latestHits) {
          const p = document.createElement('p');
          const source = document.createElement('span');
          source.className = 'source';
          source.textContent = hit.name + '\n';
          const evidenceText = document.createElement('span');
          evidenceText.className = 'evidence';
          evidenceText.textContent = hit.reasons.slice(0, 3).join('\n');
          p.append(source, evidenceText);
          details.append(p);
        }
        lastEvidence = evidence;
      }
      noticeHost.hidden = false;
      if (!announcedVideos.has(videoKey)) {
        announcedVideos.add(videoKey);
        expandVideoNotice(true);
      }
    }
    function queueVideoScan() {
      if (!scanTimer) scanTimer = setTimeout(scanVideoNotice, 180);
    }
    toggle.addEventListener('click', () => expandVideoNotice(notice.dataset.expanded !== 'true'));
    ui.querySelector('.close').addEventListener('click', () => {
      closedVideos.add(videoKey);
      stopNaturalLoad('closed');
      clearTimeout(preflightWake);
      preflightWake = null;
      stopPreflight('closed');
      noticeHost.hidden = true;
      clearTimeout(collapseTimer);
    });
    for (const name of ['click', 'dblclick', 'pointerdown', 'keydown']) noticeHost.addEventListener(name, event => event.stopPropagation());
    const discoverSelector = '#v_desc,.video-desc-container,#commentapp,bili-comments,.reply-list,.bpx-player-video-area,.bpx-player-container,#playerWrap';
    new MutationObserver(records => {
      const changed = records.some(record => {
        if (noticeHost.contains(record.target)) return false;
        if (record.target.closest?.('#v_desc,.video-desc-container,#commentapp')) return true;
        return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && node !== noticeHost && (node.matches(discoverSelector) || node.querySelector(discoverSelector)));
      });
      if (changed) queueVideoScan();
    }).observe(document.body, { childList: true, subtree: true });
    // 只检查URL和尚未建立的组件入口，正常播放时不轮询简介全文或遍历评论。
    setInterval(() => {
      const key = currentVideoKey();
      const root = document.querySelector('#commentapp bili-comments,bili-comments')?.shadowRoot;
      const thread = root?.querySelector('#feed bili-comment-thread-renderer')?.shadowRoot;
      const comment = thread?.querySelector('bili-comment-renderer')?.shadowRoot;
      const probe = [document.querySelector('.bpx-player-video-area') || document.querySelector('.bpx-player-container') || document.querySelector('#playerWrap'), document.querySelector('#v_desc .desc-info-text,.video-desc-container .desc-info-text,.video-desc-container .basic-desc-info'), root, thread, comment, comment?.querySelector('bili-rich-text')?.shadowRoot];
      if (key !== videoKey || probe.some((node, i) => node !== lastProbe[i])) queueVideoScan();
    }, 1000);
    // 前进后退立即补检测；站点自己的pushState仍由上面的轻量入口检查覆盖。
    window.addEventListener('popstate', queueVideoScan);
    document.addEventListener('visibilitychange', () => {
      clearTimeout(preflightWake);
      preflightWake = null;
      if (document.hidden) { stopNaturalLoad('hidden'); stopPreflight('hidden'); }
      else { routeStableAt = Date.now() + preflightPolicy.settle; queueVideoScan(); }
    });
    window.addEventListener('pagehide', () => { clearTimeout(preflightWake); preflightWake = null; stopNaturalLoad('hidden'); stopPreflight('hidden'); });
    window.addEventListener('pageshow', () => { routeStableAt = Date.now() + preflightPolicy.settle; queueVideoScan(); });
    GM_registerMenuCommand('重新显示本视频广告提示', () => {
      closedVideos.delete(videoKey);
      announcedVideos.delete(videoKey);
      if (preflightCache.get(videoKey)?.status === 'closed') preflightCache.get(videoKey).status = 'paused';
      queueVideoScan();
    });
    GM_registerMenuCommand('查看评论预检状态', () => window.alert(preflightDiagnostic()));
    startVideoSegments();
    scanVideoNotice();
    return;
  }
  // 区间规则与展示分离，简介、首评不参与时间边界推断。
  function validSegment(start, end, duration) {
    return [start, end, duration].every(value => typeof value === 'number' && Number.isFinite(value)) && duration > 0 && start >= 0 && end > start && end <= duration;
  }
  function communitySegments(payload, identity, rejected = {}) {
    if (!Array.isArray(payload)) throw new Error('社区响应格式错误');
    const rows = payload.find(row => row?.videoID === identity.bvid)?.segments || [];
    if (!Array.isArray(rows)) throw new Error('社区片段格式错误');
    return rows.slice(0, 500).filter(row => {
      const reason = !row || typeof row !== 'object' ? '结构无效' : String(row.cid) !== identity.cid ? '其他CID' : !['sponsor', 'selfpromo'].includes(row.category) || row.actionType !== 'skip' ? '非推广区间类别' : typeof row.videoDuration !== 'number' || !(row.videoDuration > 0) || Math.abs(row.videoDuration - identity.duration) > 2 ? '时长失配或未知' : !Array.isArray(row.segment) || row.segment.length !== 2 || !validSegment(row.segment[0], row.segment[1], identity.duration) ? '时间边界无效' : '';
      if (reason) rejected[reason] = (rejected[reason] || 0) + 1;
      return !reason;
    }).map(row => ({
      start: row.segment[0], end: row.segment[1], source: 'community', boundary: '社区原始边界',
      evidence: { id: String(row.UUID || '').slice(0, 128), category: row.category, duration: row.videoDuration }, version: '小电视空降助手API-2026-10'
    }));
  }
  function subtitleSegments(body, duration, customWords = []) {
    if (!Array.isArray(body) || body.length > 20000) throw new Error('字幕正文格式或行数超限');
    const lines = body.filter(line => validSegment(line.from, line.to, duration) && typeof line.content === 'string').map(line => ({ from: line.from, to: line.to, content: line.content.slice(0, 1000) })).sort((a, b) => a.from - b.from);
    const explicit = /本期.{0,12}(?:推广|甲方|赞助)|推广位|商业合作/;
    const ending = /回到(?:内容|正题)|继续(?:今天的|本期的)(?:内容|话题)/;
    const product = /沐浴露|洗发水|精华|套装|养成游戏|这款游戏|手游|这款产品|按摩仪|剃须刀|电动牙刷/;
    const cta = /评论区.{0,10}(?:领券|链接|下单)|置顶链接|现在下载|点击.{0,10}(?:下载|购买|领取)|购买链接|优惠码|兑换码/;
    const benefit = /优惠|领券|性价比|划算|福利|礼包|首日.{0,12}抽|免费|回购|好评|到手价/;
    const skeptical = /不是广告|没有赞助|拒绝.{0,6}(?:推广|合作)|虚假宣传|智商税|广告里说|广告声称|不要购买|不推荐/;
    const ranges = [];
    const add = (start, end, evidence, rule) => {
      if (validSegment(start, end, duration)) ranges.push({ start, end, source: 'subtitle', boundary: '字幕推断边界', version: segmentRulesVersion, evidence: { rule, lines: evidence.map(l => ({ from: l.from, to: l.to, text: l.content })) } });
    };
    for (let i = 0; i < lines.length && ranges.length < 100; i++) {
      const first = lines[i];
      if (!explicit.test(first.content) || skeptical.test(first.content)) continue;
      let end;
      for (let j = i + 1; j < lines.length && lines[j].from - first.from <= 360; j++) if (ending.test(lines[j].content)) { end = lines[j]; break; }
      if (end) add(first.from, end.from, lines.filter(l => l.from >= first.from && l.to <= end.to), '明确引入与返回正文');
    }
    const hits = lines.map(l => ({ ...l, p: product.test(l.content) || customWords.some(word => l.content.toLocaleLowerCase().includes(word.toLocaleLowerCase())), c: cta.test(l.content), b: benefit.test(l.content), negative: skeptical.test(l.content) })).filter(l => l.p || l.c || l.b || l.negative);
    const clusters = [];
    const turns = lines.filter(l => ending.test(l.content));
    for (const hit of hits) {
      const previous = clusters.at(-1);
      // 限制连续窗口，避免常见词把长视频串成一个宽区间。
      if (previous && hit.from - previous.at(-1).to <= 30 && hit.to - previous[0].from <= 120 && !turns.some(l => l.from >= previous.at(-1).to && l.to <= hit.from)) previous.push(hit);
      else clusters.push([hit]);
    }
    for (const cluster of clusters) {
      const direct = cluster.filter(l => l.c && !l.negative);
      const negative = cluster.filter(l => l.negative).length;
      if (!cluster.some(l => l.p) || !cluster.some(l => l.b) || !direct.length || negative && direct.length < 2) continue;
      const first = cluster.find(l => l.p);
      const last = cluster.at(-1);
      if (!ranges.some(r => r.start <= first.from && r.end >= last.to)) add(first.from, last.to, cluster, '商品、购买引导与利益点组合');
    }
    const coverage = [];
    for (const line of lines) {
      const previous = coverage.at(-1);
      if (previous && line.from <= previous[1]) previous[1] = Math.max(previous[1], line.to);
      else coverage.push([line.from, line.to]);
    }
    return { records: ranges.slice(0, 100), coverage, language: '', lines: lines.length };
  }
  function segmentGroups(records) {
    const community = records.filter(r => r.source === 'community');
    // 社区已有边界时，重叠字幕仅补证据；不默认向外扩大。
    const selected = [...community, ...records.filter(r => r.source !== 'community' && !community.some(c => r.start < c.end && r.end > c.start))].sort((a, b) => a.start - b.start);
    const groups = [];
    for (const row of selected) {
      const previous = groups.at(-1);
      if (previous && row.start <= previous.end) { previous.end = Math.max(previous.end, row.end); previous.records.push(row); }
      else groups.push({ start: row.start, end: row.end, records: [row] });
    }
    for (const group of groups) group.evidence = records.filter(r => r.start < group.end && r.end > group.start);
    return groups;
  }
  function segmentLabel(group) {
    const end = Math.ceil(group.end), start = Math.floor(group.start), hours = end >= 3600;
    const format = seconds => (hours ? [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60] : [Math.floor(seconds / 60), seconds % 60]).map(n => String(n).padStart(2, '0')).join(':');
    return `疑似推广 · ${format(start)}–${format(end)}`;
  }
  function startVideoSegments() {
    // 函数声明可提前调用；规则版本已在视频分支前初始化。
    const version = segmentRulesVersion;
    const settingKey = 'videoSegmentSettingsV1';
    let settings = { marks: true, community: true, subtitle: true, auto: true, ...GM_getValue(settingKey, {}) };
    let task = null, epoch = 0, layer = null, anchor = null, playerRoot = null, nativeArea = null;
    let hover = null, pointer = null, frame = 0, dragging = false, autoGroup = null, autoUntil = 0, drawKey = '';
    let geometryTimer = null, discoveryTimer = null, alive = true;
    const disposers = [], sessions = new Map();
    const cacheKey = 'videoSegmentCacheV1';
    const statusNode = document.createElement('meta'); statusNode.id = 'baf-segment-status'; document.head.append(statusNode);
    const diagnostic = () => task ? { bvid: task.bvid, cid: task.cid, part: task.part, duration: task.duration, epoch: task.epoch, elapsedMs: Date.now() - task.started, firstResultMs: task.firstResultMs, firstDrawMs: task.firstDrawMs, sources: task.sources, records: task.records, groups: task.groups.map(g => ({ start: g.start, end: g.end })), display: { enabled: settings.marks, mounted: !!layer?.isConnected, visible: !!layer && !layer.hidden }, enhanced: '音频转写与OCR尚未交付；未执行' } : { status: '等待地址、播放器素材和有限时长一致' };
    function identity() {
      try {
        const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
        const input = page.player?.__getUserParams?.().input;
        const video = document.querySelector('.bpx-player-video-wrap video,video');
        const key = currentVideoKey();
        const bvid = String(input?.bvid || ''), cid = String(input?.cid || ''), aid = String(input?.aid || ''), part = Number(input?.p || 1);
        const duration = video?.duration;
        if (!/^BV[\da-zA-Z]+$/.test(bvid) || !/^[1-9]\d*$/.test(cid) || !/^[1-9]\d*$/.test(aid) || !Number.isFinite(part) || part < 1 || !(duration > 0 && Number.isFinite(duration))) return null;
        if (key !== bvid && key !== `av${aid}`) return null;
        const requestedPart = Number(new URLSearchParams(location.search).get('p') || part);
        if (requestedPart !== part) return null;
        const vd = page.__INITIAL_STATE__?.videoData;
        const matchedPage = vd?.bvid === bvid ? vd.pages?.find(p => String(p.cid) === cid) : null;
        if (matchedPage && Math.abs(matchedPage.duration - duration) > 2) return null;
        const content = vd?.bvid === bvid ? String(vd.pubdate || '') + ':' + (vd.subtitle?.list || []).map(s => s.id_str || s.id).join(',') : '';
        return { bvid, cid, aid, part, duration, video, content, key: `${bvid}:${cid}:${part}`, stamp: `${version}:${JSON.stringify(keywords)}:${content}` };
      } catch { return null; }
    }
    function current(t, allowBudgetEnd = false) {
      const now = identity();
      return alive && task === t && (!t.controller.signal.aborted || allowBudgetEnd && t.timedOut) && now?.key === t.key && now.video === t.video && Math.abs(now.duration - t.duration) < 0.1;
    }
    function check(t) { if (!current(t)) throw new Error('任务已取消'); if (Date.now() >= t.deadline) throw new Error('轻分析预算已耗尽'); }
    function wait(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('任务已取消')); return; }
        const abort = () => { clearTimeout(timer); reject(new Error('任务已取消')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    function readCache(t, source) {
      const entry = GM_getValue(cacheKey, {})?.[`${t.bvid}:${t.cid}:${source}`];
      if (!entry || entry.expires <= Date.now() || entry.stamp !== t.stamp || Math.abs(entry.duration - t.duration) > 0.1 || !Array.isArray(entry.records) || !entry.records.every(r => r.source === source && validSegment(r.start, r.end, t.duration))) return null;
      return entry;
    }
    async function saveCache(t, source, result) {
      if (!current(t, true)) return;
      const locks = navigator.locks;
      await locks.request('baf-segment-cache-v1', t.timedOut ? {} : { signal: t.controller.signal }, () => {
        if (!current(t, true)) return;
        const all = GM_getValue(cacheKey, {}) || {};
        const ttl = result.state === '失败' ? 300000 : result.records.length ? 21600000 : 600000;
        all[`${t.bvid}:${t.cid}:${source}`] = { ...result, duration: t.duration, stamp: t.stamp, expires: Date.now() + ttl, savedAt: Date.now() };
        const kept = Object.entries(all).filter(([, v]) => v.expires > Date.now()).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 32);
        GM_setValue(cacheKey, Object.fromEntries(kept));
      });
    }
    async function request(t, url, mode) {
      const u = new URL(url), api = u.hostname === 'api.bilibili.com';
      const gateName = api ? 'videoApiScheduleV1' : `segmentHostGate:${u.hostname}`;
      const lockName = api ? 'baf-video-api-v1' : `baf-segment-host:${u.hostname}`;
      return navigator.locks.request(lockName, { signal: t.controller.signal }, async () => {
        check(t);
        const gate = () => GM_getValue(gateName, {}) || {};
        let saved = gate();
        if (Number(saved.cooldownUntil) > Date.now()) throw new Error('服务共享冷却中');
        await wait(Math.max(0, Number(saved.nextRequestAt || 0) - Date.now()), t.controller.signal);
        check(t); saved = gate();
        if (Number(saved.cooldownUntil) > Date.now()) throw new Error('服务共享冷却中');
        GM_setValue(gateName, { ...saved, nextRequestAt: Date.now() + 1000 });
        let status = 0, retry = '';
        try {
          const response = await new Promise((resolve, reject) => {
            let handle;
            const abort = () => { try { handle?.abort(); } catch { /* 迟到结果仍会校验代次。 */ } reject(new Error('任务已取消')); };
            t.controller.signal.addEventListener('abort', abort, { once: true });
            const finish = (fn, value) => { t.controller.signal.removeEventListener('abort', abort); fn(value); };
            handle = GM_xmlhttpRequest({ method: 'GET', url, anonymous: mode !== 'metadata', responseType: 'arraybuffer', timeout: Math.max(1, t.deadline - Date.now()),
              headers: { Accept: 'application/json', ...(mode === 'community' ? { Origin: 'https://www.bilibili.com', 'X-Ext-Version': 'bilibili-ad-fold/1.4.3' } : { Referer: 'https://www.bilibili.com/' }) },
              onprogress: e => { if (e.loaded > 2 * 1024 * 1024) { handle?.abort(); finish(reject, new Error('响应超过2MB预算')); } },
              onload: r => finish(resolve, r), onerror: () => finish(reject, new Error('网络请求失败')), ontimeout: () => finish(reject, new Error('请求超时')), onabort: () => finish(reject, new Error('请求已取消')) });
          });
          check(t); status = response.status;
          retry = response.responseHeaders?.match(/^retry-after:\s*(.+)$/im)?.[1] || '';
          if (mode === 'community' && status === 404) return [];
          if (status !== 200) throw new Error(`HTTP ${status}`);
          const buffer = response.response;
          if (!buffer || buffer.byteLength > 2 * 1024 * 1024) throw new Error('响应超过字节预算');
          const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
          if ([-352, -412, -509].includes(data?.code)) { status = 412; throw new Error('接口业务风控'); }
          return data;
        } catch (error) {
          if (!t.controller.signal.aborted) {
            const delay = /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            const cooldown = Math.max([403, 412, 429, 503].includes(status) ? 60000 : 30000, Number.isFinite(delay) ? delay : 0);
            GM_setValue(gateName, { ...gate(), cooldownUntil: Date.now() + cooldown });
          }
          throw error;
        }
      });
    }
    function publish(t, source, result) {
      if (!current(t)) return;
      t.sources[source] = { ...result, records: undefined };
      t.records = [...t.records.filter(r => r.source !== source), ...result.records.map(r => ({ ...r, bvid: t.bvid, cid: t.cid, epoch: t.epoch, ruleVersion: version }))];
      t.groups = segmentGroups(t.records);
      if (!t.firstResultMs && t.groups.length) t.firstResultMs = Date.now() - t.started;
      renderSoon();
    }
    async function analyze(t, source) {
      const enabled = settings[source];
      if (!enabled) { t.sources[source] = { state: '已关闭' }; return; }
      if (!navigator.locks?.request) { t.sources[source] = { state: '不可用', reason: '缺少跨标签互斥能力，保守停用网络获取' }; return; }
      t.sources[source] = { state: '等待' };
      try {
        await navigator.locks.request(`baf-segment-source:${t.bvid}:${t.cid}:${source}`, { signal: t.controller.signal }, async () => {
          check(t);
          const cached = readCache(t, source);
          if (cached) { publish(t, source, { ...cached, cache: true }); return; }
          t.sources[source] = { state: '获取中' };
          let result;
          if (source === 'community') {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.bvid));
            check(t);
            const prefix = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 4);
            const data = await request(t, `https://bsbsb.top/api/skipSegments/${prefix}?categories=${encodeURIComponent('["sponsor","selfpromo"]')}`, 'community');
            const rejected = {};
            result = { state: '完成', records: communitySegments(data, t, rejected), rejected, coverage: '仅社区已有标注，不代表检查全片' };
          } else {
            let entry;
            while (!entry && Date.now() < t.deadline - 400) {
              entry = performance.getEntriesByType('resource').slice().reverse().find(e => {
                try { const u = new URL(e.name); return u.protocol === 'https:' && u.hostname === 'api.bilibili.com' && u.pathname === '/x/player/wbi/v2' && u.searchParams.get('cid') === t.cid && (u.searchParams.get('bvid') === t.bvid || u.searchParams.get('aid') === t.aid); } catch { return false; }
              });
              if (!entry) await wait(100, t.controller.signal);
              check(t);
            }
            if (!entry) throw new Error('尚未观察到当前CID的原生WBI字幕请求');
            const meta = await request(t, entry.name, 'metadata');
            if (meta.code !== 0 || String(meta.data?.cid) !== t.cid || String(meta.data?.aid) !== t.aid) throw new Error('字幕元信息与当前素材不匹配');
            const tracks = meta.data?.subtitle?.subtitles || [];
            const track = tracks.find(s => /^(?:ai-)?zh/.test(s.lan)) || tracks[0];
            if (!track?.subtitle_url) result = { state: '不可用', records: [], reason: meta.data?.need_login_subtitle ? '当前会话需要登录才能取得字幕' : '当前素材未提供可用字幕', coverage: [] };
            else {
              const url = new URL(track.subtitle_url, 'https://www.bilibili.com');
              if (url.protocol !== 'https:' || url.hostname !== 'aisubtitle.hdslb.com') throw new Error('字幕资源不在已验证的主机白名单内');
              const data = await request(t, url.href, 'subtitle');
              t.sources[source] = { state: '分析中' };
              result = { state: '部分完成', ...subtitleSegments(data.body, t.duration, keywords), language: String(track.lan || '') };
            }
          }
          check(t); result.elapsedMs = Date.now() - t.started;
          publish(t, source, result);
          await saveCache(t, source, result);
        });
      } catch (error) {
        if (!current(t)) return;
        const result = { state: '失败', reason: error.message, records: [], coverage: [] };
        publish(t, source, result);
        try { await saveCache(t, source, result); } catch { /* 取消后不写入旧缓存。 */ }
      }
    }
    function listen(node, name, fn) {
      node.addEventListener(name, fn, { passive: true });
      disposers.push(() => node.removeEventListener(name, fn));
    }
    function detach() {
      disposers.splice(0).forEach(fn => fn());
      layer?.remove(); layer = anchor = playerRoot = nativeArea = null; pointer = hover = null; drawKey = '';
    }
    function cancel() {
      if (task) { clearTimeout(task.budgetTimer); task.controller.abort(); }
      task = null; dragging = false; autoGroup = null; autoUntil = 0;
      detach();
    }
    function poll() {
      if (!alive) return;
      const id = identity();
      if (!id || task && (task.key !== id.key || task.video !== id.video || Math.abs(task.duration - id.duration) > 0.1 || task.stamp !== id.stamp)) cancel();
      if (id && !task) {
        const controller = new AbortController();
        task = { ...id, epoch: ++epoch, controller, started: Date.now(), deadline: Date.now() + 4500, records: [], groups: [], sources: {}, firstResultMs: null };
        const t = task;
        if (!sessions.has(id.key)) sessions.set(id.key, []);
        if (sessions.size > 40) sessions.delete(sessions.keys().next().value);
        // 预算用独立标志中止请求；任务数据仍保留供展示和诊断。
        t.budgetTimer = setTimeout(() => {
          t.timedOut = true;
          for (const source of ['community', 'subtitle']) if (['等待', '获取中', '分析中'].includes(t.sources[source]?.state)) {
            const result = { state: '失败', reason: '4.5秒轻分析预算结束', records: [], coverage: [] };
            publish(t, source, result);
            void saveCache(t, source, result).catch(() => {});
          }
          t.controller.abort();
        }, 4500);
        void Promise.allSettled(['community', 'subtitle'].map(source => analyze(t, source))).then(() => clearTimeout(t.budgetTimer));
      }
      renderSoon();
      // 仅保存诊断摘要，不把字幕原文或带签名地址写入页面。
      const summary = diagnostic(); delete summary.records;
      statusNode.content = JSON.stringify(summary);
    }
    function visible(node) {
      if (!node?.isConnected || !node.getClientRects().length) return false;
      for (let el = node; el && el !== document.documentElement; el = el.parentElement) {
        const css = getComputedStyle(el);
        if (el.hidden || css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) < 0.02) return false;
      }
      return true;
    }
    function mount(track) {
      detach();
      anchor = track;
      playerRoot = track.closest('.bpx-player-container');
      nativeArea = track.closest('.bpx-player-progress-wrap') || track;
      if (!playerRoot || getComputedStyle(playerRoot).position === 'static') { detach(); return; }
      layer = document.createElement('div'); layer.id = 'baf-segments'; layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:absolute;inset:0;z-index:75;pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important;overflow:visible;';
      const shadow = layer.attachShadow({ mode: 'open' });
      // 深色轮廓保证亮色画面上的对比；只放大装饰，不扩大原生交互区域。
      shadow.innerHTML = `<style>
        :host,:host *{pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}
        *{box-sizing:border-box}.ranges{position:absolute;height:4px}
        .range{position:absolute;top:50%;height:10px;transform:translateY(-50%);min-width:1px;background:rgba(255,159,28,.72);outline:1px solid #392306;box-shadow:0 1px 4px #0009}
        .handle{position:absolute;bottom:0;width:2px;height:30px;background:#FFB347;filter:drop-shadow(0 0 .6px #392306) drop-shadow(0 1px 1px #0006)}
        .handle:after{content:'';position:absolute;top:0;width:12px;height:20px;background:#FFB347}
        .in{left:0}.out{right:0}
        .in:after{right:0;clip-path:polygon(0 0,100% 0,100% 100%,0 55%)}
        .out:after{left:0;clip-path:polygon(0 0,100% 0,100% 55%,0 100%)}
        .tip{position:absolute;padding:6px 10px;border-radius:5px;background:#202024f5;color:#fff;font:600 13px/20px sans-serif;white-space:nowrap;opacity:0;transition:opacity 160ms ease-out}
        .tip[data-show=true]{opacity:1}@media(prefers-reduced-motion:reduce){.tip{transition:none}}
      </style><div class="ranges"></div><div class="tip" data-show="false"></div>`;
      playerRoot.append(layer);
      listen(nativeArea, 'pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; dragging = e.buttons === 1; renderSoon(); });
      listen(nativeArea, 'pointerleave', () => { pointer = hover = null; renderSoon(); });
      listen(nativeArea, 'pointerdown', () => { dragging = true; autoUntil = 0; });
      listen(window, 'pointerup', () => { dragging = false; renderSoon(); });
      listen(window, 'pointercancel', () => { dragging = false; pointer = null; renderSoon(); });
      listen(task.video, 'seeking', () => { autoUntil = 0; });
      listen(task.video, 'timeupdate', renderSoon);
      const resize = new ResizeObserver(renderSoon); resize.observe(track); resize.observe(playerRoot); disposers.push(() => resize.disconnect());
    }
    function renderSoon() { if (!frame && alive) frame = requestAnimationFrame(() => { frame = 0; render(); }); }
    function render() {
      if (!task || !settings.marks || !task.groups.length) { if (layer) detach(); return; }
      if (!current(task, true)) { detach(); return; }
      const track = document.querySelector('.bpx-player-progress-schedule-wrap');
      if (!track) { detach(); return; }
      if (track !== anchor || !layer?.isConnected) mount(track);
      if (!layer) return;
      const show = !document.hidden && visible(anchor) && visible(nativeArea);
      layer.hidden = !show;
      if (!show) { hover = null; pointer = null; return; }
      const rect = anchor.getBoundingClientRect(), root = playerRoot.getBoundingClientRect();
      if (rect.width <= 0 || root.width <= 0 || root.height <= 0) { layer.hidden = true; return; }
      // 使用布局尺寸换算比例，兼容播放器祖先的CSS缩放。
      const sx = playerRoot.clientWidth / root.width, sy = playerRoot.clientHeight / root.height;
      const rail = layer.shadowRoot.querySelector('.ranges');
      Object.assign(rail.style, { left: `${(rect.left - root.left) * sx}px`, top: `${(rect.top - root.top) * sy}px`, width: `${rect.width * sx}px`, height: `${Math.max(2, rect.height * sy)}px` });
      const key = task.groups.map(g => `${g.start}:${g.end}`).join('|');
      if (key !== drawKey) {
        rail.replaceChildren(); drawKey = key;
        for (const group of task.groups) {
          const range = document.createElement('div'); range.className = 'range';
          range.style.left = `${group.start / task.duration * 100}%`; range.style.width = `${(group.end - group.start) / task.duration * 100}%`;
          for (const side of ['in', 'out']) { const handle = document.createElement('i'); handle.className = `handle ${side}`; range.append(handle); }
          rail.append(range);
        }
        task.firstDrawMs ||= Date.now() - task.started;
      }
      const area = nativeArea.getBoundingClientRect();
      const time = pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= area.top && pointer.y <= area.bottom ? (pointer.x - rect.left) / rect.width * task.duration : -1;
      hover = task.groups.find(g => time >= g.start && time <= g.end) || null;
      const video = task.video;
      if (settings.auto && !dragging && !video.seeking && !video.paused && !document.hidden) {
        const active = task.groups.find(g => video.currentTime >= g.start && video.currentTime < g.end);
        const seen = sessions.get(task.key);
        if (active && !seen.some(g => active.start < g.end && active.end > g.start)) { seen.push({ start: active.start, end: active.end }); autoGroup = active; autoUntil = Date.now() + 3000; }
      }
      const group = hover || (settings.auto && !dragging && Date.now() < autoUntil ? autoGroup : null);
      const tip = layer.shadowRoot.querySelector('.tip');
      tip.dataset.show = String(!!group);
      if (!group) return;
      tip.textContent = segmentLabel(group);
      const center = (rect.left - root.left + (group.start + group.end) / 2 / task.duration * rect.width) * sx;
      const width = tip.offsetWidth;
      let top = (rect.top - root.top) * sy - 62;
      // 原生预览出现时移到其上方，不覆盖预览时间和缩略图。
      for (const popup of playerRoot.querySelectorAll('.bpx-player-progress-popup,.bpx-player-progress-preview,.bpx-player-contextmenu')) {
        if (!visible(popup)) continue;
        const r = popup.getBoundingClientRect();
        if (r.width && r.height && r.right > root.left + (center - width / 2) / sx && r.left < root.left + (center + width / 2) / sx) top = Math.min(top, (r.top - root.top) * sy - tip.offsetHeight - 8);
      }
      tip.style.left = `${Math.max(4, Math.min(playerRoot.clientWidth - width - 4, center - width / 2))}px`;
      tip.style.top = `${Math.max(4, top)}px`;
    }
    for (const [name, label] of [['marks', '区间标记显示'], ['community', '社区查询（第三方接收BVID哈希前缀和网络信息）'], ['subtitle', '字幕规则分析'], ['auto', '区间自动短提示']]) {
      GM_registerMenuCommand(`${label}：${settings[name] ? '开' : '关'}（切换）`, () => {
        settings[name] = !settings[name]; GM_setValue(settingKey, settings);
        if (name === 'community' || name === 'subtitle') { cancel(); poll(); }
        else { autoUntil = 0; if (!settings.marks) detach(); renderSoon(); }
        window.alert(`${label}已${settings[name] ? '开启' : '关闭'}。菜单文字在刷新页面后更新。`);
      });
    }
    GM_registerMenuCommand('查看推广区间诊断', () => window.alert(JSON.stringify(diagnostic(), null, 2)));
    document.addEventListener('visibilitychange', () => { if (document.hidden) { if (layer) layer.hidden = true; } else { poll(); } });
    window.addEventListener('pagehide', () => { alive = false; cancel(); clearInterval(discoveryTimer); clearInterval(geometryTimer); cancelAnimationFrame(frame); frame = 0; });
    window.addEventListener('pageshow', () => { if (!alive) { alive = true; run(); } });
    function run() { discoveryTimer = setInterval(poll, 300); geometryTimer = setInterval(renderSoon, 100); poll(); }
    run();
  }
  // 元数据的尾部通配符可能匹配列表相似路径，这些主站页面不显示动态面板。
  if (location.hostname === 'www.bilibili.com') return;
  const style = document.createElement('style');
  style.textContent = `
    .baf-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 16px;color:var(--text2,#61666d);background:var(--bg1,#fff);font:13px/1.6 sans-serif;border-bottom:1px solid var(--line_regular,#eee)}
    .baf-bar button{border:1px solid #ccd0d7;border-radius:5px;padding:3px 9px;background:transparent;color:inherit;cursor:pointer;transition:background-color 160ms ease-out}
    .baf-bar button:hover{background:#e3f5fc;color:#008ac5}
    .baf-folded>.bili-dyn-item{display:none!important}
    .baf-folded{min-height:0!important}
    .baf-bar{animation:baf-in 160ms ease-out}
    #baf-widget{position:fixed;left:16px;bottom:16px;z-index:99999;font:13px/1.6 sans-serif;color:var(--text1,#18191c)}
    #baf-widget button,#baf-widget textarea{font:inherit;color:inherit}
    #baf-widget button{cursor:pointer;border:1px solid #ccd0d7;border-radius:6px;background:var(--bg1,#fff);padding:5px 10px;transition:background-color 160ms ease-out}
    #baf-panel{position:absolute;left:0;bottom:42px;width:340px;max-width:calc(100vw - 62px);min-height:min(252px,max(0px,calc(100vh - 114px)));max-height:calc(100vh - 86px);padding:14px;background:var(--bg1,#fff);border:1px solid #ccd0d7;border-radius:10px;box-shadow:0 6px 24px #0002;opacity:0;visibility:hidden;transform:translateY(6px);transition:opacity 160ms ease-out,transform 160ms ease-out,visibility 160ms ease-out}
    #baf-panel-body{margin-left:60px;max-height:calc(100vh - 114px);overflow-y:auto}
    #baf-loaded{float:right;color:var(--text2,#61666d);font-size:11px;line-height:21px}
    #baf-panel.baf-open{opacity:1;visibility:visible;transform:translateY(0)}
    #baf-list{max-height:240px;overflow:auto;margin:10px 0}
    #baf-list a,#baf-list button{display:block;padding:5px 2px;color:inherit;text-decoration:none;border:0;background:transparent;width:100%;text-align:left}
    #baf-list a:hover{color:#008ac5}
    #baf-settings{max-height:60vh;overflow:auto}
    #baf-settings[hidden]{display:none}
    #baf-settings textarea{box-sizing:border-box;width:100%;height:130px;background:var(--bg1,#fff);border:1px solid #ccd0d7;border-radius:5px;padding:6px}
    #baf-settings p{margin:8px 0}
    #baf-settings details{margin:8px 0;overflow-wrap:anywhere}
    #baf-rail{position:absolute;left:14px;top:14px;bottom:14px;width:44px;overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain;outline:none}
    #baf-widget #baf-rail,#baf-widget #baf-panel-body,#baf-widget #baf-list,#baf-widget #baf-settings,#baf-widget textarea{scrollbar-width:none!important;-ms-overflow-style:none}
    #baf-widget #baf-rail::-webkit-scrollbar,#baf-widget #baf-panel-body::-webkit-scrollbar,#baf-widget #baf-list::-webkit-scrollbar,#baf-widget #baf-settings::-webkit-scrollbar,#baf-widget textarea::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
    #baf-rail-track{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100%;box-sizing:border-box}
    #baf-rail.baf-overflow #baf-rail-track{justify-content:flex-start;padding-bottom:72px}
    #baf-rail .baf-rail-node{display:flex;align-items:center;justify-content:flex-start;flex:0 0 12px;width:40px;height:12px;min-height:12px;margin:0;padding:0 2px;border:0;border-radius:3px;background:transparent;color:var(--text1,#18191c);outline-offset:-2px}
    #baf-rail .baf-rail-node:hover{background:transparent}
    #baf-rail .baf-rail-node:focus-visible{outline:2px solid #00aeec}
    .baf-rail-tick{display:block;width:calc(36px * var(--baf-scale,.25));height:2px;flex:none;background:currentColor;border-radius:999px;transition:width 180ms cubic-bezier(.16,1,.3,1),height 180ms ease-out,opacity 180ms ease-out;pointer-events:none;opacity:.3}
    #baf-rail .baf-rail-ad{color:#fb7299!important}
    .baf-rail-ad .baf-rail-tick{height:4px;opacity:1}
    #baf-rail-preview{position:fixed;z-index:100000;width:260px;box-sizing:border-box;padding:12px 14px;border:1px solid var(--line_regular,#ddd);border-radius:10px;background:var(--bg1,#fff);color:var(--text1,#18191c);box-shadow:0 8px 28px #0002;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(4px);transition:top 180ms cubic-bezier(.16,1,.3,1),opacity 180ms ease-out,transform 180ms ease-out,visibility 180ms ease-out;overflow-wrap:anywhere;max-height:calc(100vh - 16px);overflow:hidden;font:13px/1.65 sans-serif}
    #baf-rail-preview.baf-visible{opacity:1;visibility:visible;transform:translateY(0)}
    #baf-rail-preview strong,#baf-rail-preview span{display:block;white-space:pre-wrap}
    #baf-rail-preview [hidden]{display:none!important}
    #baf-rail-preview .baf-preview-state{color:#fb7299;margin:3px 0}
    .bili-dyn-list__item.baf-anchor-flash{animation:baf-anchor 720ms ease-out}
    @keyframes baf-anchor{from{outline:2px solid #fb7299;outline-offset:4px}to{outline:2px solid transparent;outline-offset:8px}}
    @keyframes baf-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
    @media(prefers-reduced-motion:reduce){.baf-bar,.bili-dyn-list__item.baf-anchor-flash{animation:none}#baf-widget *,#baf-rail-preview{transition:none!important}}
  `;
  document.head.append(style);
  const widget = document.createElement('div');
  widget.id = 'baf-widget';
  // 固定静态模板；动态UP名和关键词均通过 textContent 写入。
  widget.innerHTML = `<button type="button" id="baf-open" aria-expanded="false">广告记录 0</button>
    <section id="baf-panel" aria-label="广告记录面板"><nav id="baf-rail" aria-label="已加载动态位置导航"><div id="baf-rail-track"></div></nav><div id="baf-panel-body"><span id="baf-loaded" aria-live="polite"></span><strong>当前页面判定为广告</strong><div id="baf-list"></div>
    <button type="button" id="baf-config">关键词设置</button>
    <div id="baf-settings" hidden><p>自定义关键词：每行一个，按原文包含匹配，忽略英文字母大小写。命中任意一个即折叠；留空仅使用内置规则。</p>
    <textarea aria-label="自定义屏蔽关键词" placeholder="例如：妙界R9&#10;小鹿泡芙被"></textarea>
    <button type="button" id="baf-save">保存并重新识别</button><span id="baf-saved" role="status"></span>
    <details><summary>查看内置商品词和组合规则</summary><p id="baf-defaults"></p><p>内置商品词不单独屏蔽。还需命中至少两组营销特征，其中包含领券导购、售后承诺或跨平台低价；商品卡片直接折叠。</p><div id="baf-rules"></div></details>
    <button type="button" id="baf-reset">重置放行UP列表</button></div></div></section><div id="baf-rail-preview" role="tooltip"><strong></strong><span class="baf-preview-state"></span><span class="baf-preview-reasons"></span></div>`;
  document.body.append(widget);
  const panel = widget.querySelector('#baf-panel');
  const opener = widget.querySelector('#baf-open');
  const editor = widget.querySelector('textarea');
  const rail = widget.querySelector('#baf-rail');
  const track = widget.querySelector('#baf-rail-track');
  const preview = widget.querySelector('#baf-rail-preview');
  const railNodes = new Map();
  let orderedCards = [];
  let highlighted = null;
  let scrollFrame = 0;
  let navigateFrame = 0;
  let anchorSerial = 0;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // 交互参考 beui.dev 的 Preview Rail：悬停阶梯伸缩和独立浮层，使用原生DOM实现。
  function railLayout() {
    // 绝对定位的轨道借用面板高度，节点数量不会参与面板高度计算。
    const overflow = orderedCards.length * 12 > rail.clientHeight;
    rail.classList.toggle('baf-overflow', overflow);
    if (!overflow) rail.scrollTop = 0;
  }
  function hidePreview() {
    highlighted = null;
    preview.classList.remove('baf-visible');
    for (const node of railNodes.values()) {
      node.firstElementChild.style.setProperty('--baf-scale', '.25');
      node.removeAttribute('aria-describedby');
    }
  }
  function showPreview(card) {
    const index = orderedCards.indexOf(card);
    const entry = entries.get(card);
    const node = railNodes.get(card);
    if (index < 0 || !entry || !node || !panel.classList.contains('baf-open')) return;
    highlighted = card;
    orderedCards.forEach((c, i) => {
      const distance = Math.abs(i - index);
      railNodes.get(c).firstElementChild.style.setProperty('--baf-scale', distance === 0 ? 1 : distance === 1 ? .68 : distance === 2 ? .44 : .25);
      railNodes.get(c).removeAttribute('aria-describedby');
    });
    node.setAttribute('aria-describedby', 'baf-rail-preview');
    preview.querySelector('strong').textContent = `${index + 1} / ${orderedCards.length} · ${entry.author}`;
    const ad = entry.reasons.length > 0;
    preview.querySelector('.baf-preview-state').hidden = !ad;
    preview.querySelector('.baf-preview-reasons').hidden = !ad;
    preview.querySelector('.baf-preview-state').textContent = ad ? `规则命中广告 · ${card.classList.contains('baf-folded') ? '当前已折叠' : '当前已展开'}` : '';
    preview.querySelector('.baf-preview-reasons').textContent = ad ? entry.details.join('\n') : '';
    const rect = node.getBoundingClientRect();
    const left = rail.getBoundingClientRect().right + 10;
    preview.style.left = `${Math.min(left, Math.max(8, window.innerWidth - 268))}px`;
    preview.style.width = `${Math.min(260, window.innerWidth - 16)}px`;
    preview.style.top = `${Math.max(8, Math.min(window.innerHeight - preview.offsetHeight - 8, rect.top + rect.height / 2 - preview.offsetHeight / 2))}px`;
    preview.classList.add('baf-visible');
  }
  function updateCurrent() {
    scrollFrame = 0;
    if (!panel.classList.contains('baf-open')) return;
    let current = null;
    let distance = Infinity;
    for (const card of orderedCards) {
      const d = Math.abs(card.getBoundingClientRect().top - 88);
      if (d < distance) { distance = d; current = card; }
    }
    for (const [card, node] of railNodes) {
      if (card === current) node.setAttribute('aria-current', 'location');
      else node.removeAttribute('aria-current');
    }
  }
  function goToCard(card) {
    if (!card.isConnected) { refreshRail(); return; }
    cancelAnimationFrame(navigateFrame);
    const start = window.scrollY;
    const target = Math.max(0, Math.min(document.documentElement.scrollHeight - window.innerHeight, start + card.getBoundingClientRect().top - 88));
    const startTime = performance.now();
    function step(time) {
      const progress = reduceMotion.matches ? 1 : Math.min(1, (time - startTime) / 360);
      window.scrollTo({ top: start + (target - start) * (1 - Math.pow(1 - progress, 3)), behavior: 'instant' });
      if (progress < 1) navigateFrame = requestAnimationFrame(step);
      else {
        // 图片加载等变化可能发生在滚动过程中，结束时以实际锚点再校准。
        if (card.isConnected) window.scrollTo({ top: Math.max(0, window.scrollY + card.getBoundingClientRect().top - 88), behavior: 'instant' });
        card.classList.remove('baf-anchor-flash');
        void card.offsetWidth;
        card.classList.add('baf-anchor-flash');
        setTimeout(() => card.classList.remove('baf-anchor-flash'), 750);
        navigateFrame = 0;
        updateCurrent();
      }
    }
    navigateFrame = requestAnimationFrame(step);
  }
  function refreshRail() {
    const next = Array.from(document.querySelectorAll(CARD)).filter(card => entries.has(card));
    for (const [card, node] of railNodes) {
      if (!next.includes(card)) { node.remove(); railNodes.delete(card); entries.delete(card); if (highlighted === card) hidePreview(); }
    }
    const orderChanged = next.length !== orderedCards.length || next.some((card, i) => orderedCards[i] !== card);
    orderedCards = next;
    next.forEach((card, index) => {
      const entry = entries.get(card);
      let node = railNodes.get(card);
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.className = 'baf-rail-node';
        node.dataset.anchor = `baf-dynamic-${++anchorSerial}`;
        const tick = document.createElement('span');
        tick.className = 'baf-rail-tick';
        tick.setAttribute('aria-hidden', 'true');
        node.append(tick);
        node.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') showPreview(card); });
        node.addEventListener('focus', () => showPreview(card));
        node.addEventListener('click', () => { showPreview(card); goToCard(card); });
        node.addEventListener('keydown', event => {
          const i = orderedCards.indexOf(card);
          let nextIndex;
          if (event.key === 'ArrowDown') nextIndex = Math.min(i + 1, orderedCards.length - 1);
          if (event.key === 'ArrowUp') nextIndex = Math.max(i - 1, 0);
          if (event.key === 'Home') nextIndex = 0;
          if (event.key === 'End') nextIndex = orderedCards.length - 1;
          if (nextIndex === undefined) return;
          event.preventDefault();
          const nextNode = railNodes.get(orderedCards[nextIndex]);
          nextNode.focus({ preventScroll: true });
          const y = nextNode.offsetTop;
          if (y < rail.scrollTop) rail.scrollTop = y;
          else if (y + 12 > rail.scrollTop + rail.clientHeight) rail.scrollTop = y + 12 - rail.clientHeight;
          showPreview(orderedCards[nextIndex]);
        });
        railNodes.set(card, node);
      }
      node.classList.toggle('baf-rail-ad', entry.reasons.length > 0);
      node.style.color = entry.textColor;
      node.setAttribute('aria-label', `第${index + 1}条，共${next.length}条，${entry.author}，${entry.reasons.length ? '规则命中广告' : '普通动态'}，点击定位`);
    });
    if (orderChanged) track.replaceChildren(...next.map(card => railNodes.get(card)));
    rail.setAttribute('aria-label', `已加载${next.length}条动态，位置导航`);
    widget.querySelector('#baf-loaded').textContent = `已加载 ${next.length} 条`;
    railLayout();
    updateCurrent();
    if (highlighted) showPreview(highlighted);
  }
  new ResizeObserver(() => { railLayout(); if (highlighted) showPreview(highlighted); }).observe(panel);
  rail.addEventListener('pointerleave', hidePreview);
  rail.addEventListener('focusout', event => { if (!rail.contains(event.relatedTarget)) hidePreview(); });
  rail.addEventListener('scroll', hidePreview, { passive: true });
  rail.addEventListener('wheel', event => {
    if (!rail.classList.contains('baf-overflow')) return;
    if (event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    rail.scrollTop += event.deltaY * (event.deltaMode === 1 ? 12 : event.deltaMode === 2 ? rail.clientHeight : 1);
  }, { passive: false });
  window.addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateCurrent); }, { passive: true });
  window.addEventListener('resize', () => { railLayout(); if (highlighted) showPreview(highlighted); });
  window.addEventListener('wheel', () => { cancelAnimationFrame(navigateFrame); navigateFrame = 0; }, { passive: true });
  window.addEventListener('touchstart', () => { cancelAnimationFrame(navigateFrame); navigateFrame = 0; }, { passive: true });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !panel.classList.contains('baf-open')) return;
    hidePreview();
    panel.classList.remove('baf-open');
    opener.setAttribute('aria-expanded', 'false');
    opener.focus();
  });
  function updateList() {
    const counts = new Map();
    for (const [card, state] of states) {
      if (!card.isConnected) { states.delete(card); continue; }
      // states 保存规则判定，baf-folded 仅表示展示状态，两者独立。
      const key = state.url || state.author;
      const row = counts.get(key) || { ...state, count: 0 };
      row.count++;
      counts.set(key, row);
    }
    const list = widget.querySelector('#baf-list');
    list.replaceChildren();
    let total = 0;
    for (const row of counts.values()) {
      const link = document.createElement(row.url ? 'a' : 'button');
      link.textContent = `${row.author} · ${row.count}`;
      if (row.url) { link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else { link.type = 'button'; link.addEventListener('click', () => row.profileNode.click()); }
      list.append(link);
      total += row.count;
    }
    if (!total) list.textContent = '暂无';
    opener.textContent = `广告记录 ${total}`;
    refreshRail();
  }
  opener.addEventListener('click', () => {
    const open = panel.classList.toggle('baf-open');
    opener.setAttribute('aria-expanded', String(open));
    if (open) updateList();
    else hidePreview();
  });
  function openSettings() {
    panel.classList.add('baf-open');
    opener.setAttribute('aria-expanded', 'true');
    widget.querySelector('#baf-settings').hidden = false;
    editor.value = keywords.join('\n');
  }
  widget.querySelector('#baf-config').addEventListener('click', openSettings);
  widget.querySelector('#baf-defaults').textContent = productWords.join('、');
  widget.querySelector('#baf-rules').textContent = GROUPS.map(([name, re]) => `${name}：${re.source}`).join('\n');
  widget.querySelector('#baf-rules').style.whiteSpace = 'pre-wrap';
  widget.querySelector('#baf-save').addEventListener('click', () => {
    keywords = [...new Set(editor.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    GM_setValue('customKeywords', keywords);
    editor.value = keywords.join('\n');
    document.querySelectorAll(CARD).forEach(scan);
    updateList();
    widget.querySelector('#baf-saved').textContent = ` 已保存 ${keywords.length} 个`;
  });
  function resetAllowed() {
    allowed = [];
    GM_setValue('allowedAuthors', allowed);
    document.querySelectorAll(CARD).forEach(scan);
    updateList();
  }
  widget.querySelector('#baf-reset').addEventListener('click', resetAllowed);
  function scan(card) {
    const body = card.querySelector('.bili-dyn-item__body');
    const item = card.querySelector('.bili-dyn-item');
    if (!body || !item || item.parentElement !== card) {
      states.get(card)?.bar.remove();
      states.delete(card);
      entries.delete(card);
      card.classList.remove('baf-folded');
      return;
    }
    const author = card.querySelector('.bili-dyn-title__text')?.textContent.trim() || '未知UP主';
    // 只使用页面实际提供的、经过域名和UID验证的主页地址。
    const profile = Array.from(card.querySelectorAll('.bili-dyn-item__header a[href],.bili-dyn-item__avatar a[href]')).map(a => a.href).find(href => /^https:\/\/space\.bilibili\.com\/\d+(?:[/?#]|$)/.test(href));
    const url = profile ? profile.match(/^https:\/\/space\.bilibili\.com\/\d+/)[0] : '';
    const text = Array.from(body.querySelectorAll(TEXT)).map(el => el.textContent).join('\n');
    const goods = !!body.querySelector(GOODS);
    const reasons = allowed.includes(author) ? [] : classify(text, goods);
    let state = states.get(card);
    if (state && state.author !== author) {
      state.bar.remove();
      states.delete(card);
      card.classList.remove('baf-folded');
      state = null;
    }
    const details = reasons.length ? matchDetails(text, goods) : [];
    const meta = { author, url, reasons, details, textColor: getComputedStyle(body.querySelector(TEXT) || body).color, profileNode: card.querySelector('.bili-dyn-title__text') || card.querySelector('.bili-dyn-item__avatar') };
    entries.set(card, meta);
    if (!reasons.length) {
      if (state) { state.bar.remove(); card.classList.remove('baf-folded'); states.delete(card); }
      return;
    }
    if (state) {
      Object.assign(state, meta);
      state.bar.querySelector('span').title = `命中特征：${reasons.join('、')}`;
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'baf-bar';
    const label = document.createElement('span');
    label.textContent = `疑似带货 · ${author}`;
    label.title = `命中特征：${reasons.join('、')}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = '展开';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      const folded = card.classList.toggle('baf-folded');
      toggle.textContent = folded ? '展开' : '重新折叠';
      toggle.setAttribute('aria-expanded', String(!folded));
      if (highlighted === card) showPreview(card);
    });
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.textContent = '放行此UP';
    allow.title = '此UP以后不自动折叠；可从油猴菜单重置';
    allow.addEventListener('click', event => {
      event.stopPropagation();
      allowed = [...new Set([...allowed, author])];
      GM_setValue('allowedAuthors', allowed);
      document.querySelectorAll(CARD).forEach(scan);
      updateList();
    });
    bar.append(label, toggle, allow);
    card.prepend(bar);
    card.classList.add('baf-folded');
    states.set(card, { bar, ...meta });
  }
  // 仅处理发生变化的卡片，避免每次滚动全页扫描。
  const pending = new Set();
  let timer;
  function schedule(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.closest('.baf-bar,#baf-widget')) return;
    const card = el.closest(CARD);
    if (card) pending.add(card);
    else el.querySelectorAll(CARD).forEach(c => pending.add(c));
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      pending.forEach(c => { if (c.isConnected) scan(c); });
      pending.clear();
      for (const c of states.keys()) if (!c.isConnected) states.delete(c);
      updateList();
    }, 150);
  }
  new MutationObserver(records => {
    records.forEach(r => {
      if (r.type === 'characterData') schedule(r.target);
      else { schedule(r.target); r.addedNodes.forEach(schedule); }
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.querySelectorAll(CARD).forEach(scan);
  updateList();
  GM_registerMenuCommand('关键词设置', openSettings);
  GM_registerMenuCommand('重置放行UP列表', resetAllowed);
})();
