(() => {
  'use strict';

  // ---- Layer 1: Config, State, and Storage ----
  const WRAP = 'author-btns-wrap', POST_SEL = 'shreddit-post, .thing.link';
  const AD_SEL = 'shreddit-ad-post, .promotedlink, .thing.link.promoted';
  const BAR_SEL = '[slot="credit-bar"],shreddit-post-credit-bar,[data-testid="post-author-header"],[slot="authorName"]';
  const SKIP_AUTHORS = new Set(['automoderator', '[deleted]', '[removed]', 'me', 'reddit']);
  const PFX = 'ivory_reddit_', K_STATUS = `${PFX}author_status_v5`, K_RATE = `${PFX}ratelimit_v5`, K_BLOCKED = `${PFX}blocked_v1`, K_MODHASH = `${PFX}modhash_v1`;
  const LEGACY_RATE = ['ratelimit_v1', 'ratelimit_v2', 'ratelimit_v3', 'ratelimit_v4', 'last_req_v1'].map((k) => PFX + k);
  const LEGACY_STATUS = ['author_status_v1', 'author_status_v2', 'author_status_v3', 'author_status_v4'].map((k) => PFX + k);

  // Smooth burst-free pacing with strictly hover-only priority reserve.
  const CFG = {
    timeoutMs: 15000, hoverGapMs: 1800, dwellMs: 850, hoverMs: 120, settleMs: 1500,
    ttlPresentMs: 24 * 3600000, ttlEmptyMs: 4 * 3600000, failTtlMs: 60000,
    fallback429Ms: 600000, slowAfter429Ms: 30 * 60000, reserveRem: 20,
    bgMaxPerMin: 5, totalMaxPerMin: 7, bgMaxPer10Min: 24, totalMaxPer10Min: 30,
    maxCache: 1000, blockCooldownMs: 1500, errorLockMs: 2000,
  };

  const extStore = typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null;
  const authorCache = new Map(), retryAfter = new Map(), blockErrors = new Map(), queue = new Map();
  const partialTopFalse = new Set(), partialHotTrue = new Set(), blocked = new Set(), pendingBlocks = new Set();
  const timers = new WeakMap(), postToWrap = new WeakMap(), tabReadyAt = Date.now() + CFG.settleMs;
  const rate = { limitedUntil: 0, pausedUntil: 0, slowUntil: 0, lastReqAt: 0, nextBgAt: 0, ts: [] };
  let activeKey = '', queueTimer = null, persistTimer = null, seq = 0, partialBroken = location.hostname === 'old.reddit.com';
  let cachedModhash = '', modhashPromise = null, blockChain = Promise.resolve(), nextBlockAt = 0, localLock = Promise.resolve();

  const safeDecode = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };
  const normAuthor = (raw) => safeDecode(raw).trim().replace(/^\/?(?:u|user)\//i, '');
  const readLs = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  const writeLs = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const storeGet = async (k) => { if (extStore) { try { const r = await extStore.get(k); return r && k in r ? r[k] : null; } catch {} } return readLs(k); };
  const storeSet = async (k, v) => { if (extStore) { try { await extStore.set({ [k]: v }); return; } catch {} } writeLs(k, v); };
  const withLock = (name, fn) => {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(name, fn);
    const p = localLock.then(fn, fn); localLock = p.catch(() => {}); return p;
  };
  const pruneTs = (arr, now) => (Array.isArray(arr) ? [...new Set(arr.filter((t) => Number.isFinite(t) && t > now - 600000))].sort((a, b) => a - b).slice(-CFG.totalMaxPer10Min - 10) : []);

  function mergeRate(d, now = Date.now()) {
    if (!d || typeof d !== 'object') return;
    const maxN = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);
    const lim = maxN(d.limitedUntil, d.rateLimitedUntil), pau = maxN(d.pausedUntil, d.quotaPausedUntil), slow = Number(d.slowUntil) || 0;
    if (lim > now) rate.limitedUntil = Math.max(rate.limitedUntil, lim);
    if (pau > now) rate.pausedUntil = Math.max(rate.pausedUntil, pau);
    if (slow > now) rate.slowUntil = Math.max(rate.slowUntil, slow);
    rate.lastReqAt = Math.max(rate.lastReqAt, maxN(d.lastReqAt, d.lastRequestAt));
    rate.nextBgAt = Math.max(rate.nextBgAt, maxN(d.nextBgAt, d.nextRequestAt));
    rate.ts = pruneTs([...rate.ts, ...(d.ts || []), ...(d.recentTimestamps || []), ...(d.recentBgTimestamps || [])], now);
  }
  const withRate = (fn) => withLock('irb_net_lock_v5', async () => { const now = Date.now(); mergeRate(await storeGet(K_RATE), now); const r = await fn(now); if (r?.dirty !== false) await storeSet(K_RATE, rate); return r; });
  function mergeStatus(obj, now = Date.now()) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || !(v.expiresAt > now) || typeof v.hasHot !== 'boolean' || typeof v.hasTop !== 'boolean') continue;
      const key = k.toLowerCase(); if (!authorCache.get(key) || v.expiresAt > authorCache.get(key).expiresAt) authorCache.set(key, { hasHot: v.hasHot, hasTop: v.hasTop, expiresAt: v.expiresAt });
    }
  }
  function buildStatusMap(now = Date.now()) {
    const entries = [];
    for (const [k, v] of authorCache) if (v.expiresAt > now) entries.push([k, v]); else authorCache.delete(k);
    if (entries.length > CFG.maxCache) { entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt); entries.splice(0, entries.length - CFG.maxCache).forEach(([k]) => authorCache.delete(k)); }
    return Object.fromEntries(entries);
  }
  function flushCache(syncOnly = false) {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (syncOnly && !extStore) { const now = Date.now(); mergeStatus(readLs(K_STATUS), now); writeLs(K_STATUS, buildStatusMap(now)); return; }
    return withLock('irb_cache_lock_v5', async () => { const now = Date.now(); mergeStatus(await storeGet(K_STATUS), now); await storeSet(K_STATUS, buildStatusMap(now)); }).catch(() => {});
  }
  const saveBlocked = () => withLock('irb_cache_lock_v5', async () => { const cur = await storeGet(K_BLOCKED); if (Array.isArray(cur)) cur.forEach((a) => blocked.add(String(a).toLowerCase())); await storeSet(K_BLOCKED, [...blocked]); });
  async function initStorage() {
    const now = Date.now(), allExt = extStore ? await extStore.get([...LEGACY_RATE, K_RATE, K_STATUS, K_BLOCKED]).catch(() => ({})) : {};
    let migrated = false;
    for (const k of LEGACY_RATE) {
      const vals = [readLs(k), allExt[k]]; try { const ss = sessionStorage.getItem(k); if (ss) vals.push(JSON.parse(ss)); } catch {}
      vals.filter(Boolean).forEach((v) => { mergeRate(v, now); migrated = true; });
    }
    mergeRate(allExt[K_RATE] || readLs(K_RATE), now);
    if (extStore && readLs(K_RATE)) { mergeRate(readLs(K_RATE), now); migrated = true; }
    if (migrated) await storeSet(K_RATE, rate);
    [readLs(LEGACY_STATUS[3]), allExt[K_STATUS], readLs(K_STATUS)].forEach((s) => mergeStatus(s, now));
    [allExt[K_BLOCKED], readLs(K_BLOCKED)].forEach((a) => { if (Array.isArray(a)) a.forEach((u) => blocked.add(String(u).toLowerCase())); });
    try { cachedModhash = sessionStorage.getItem(K_MODHASH) || ''; } catch {}
    const legacy = [...LEGACY_RATE, ...LEGACY_STATUS];
    legacy.forEach((k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} });
    if (extStore) await extStore.remove(legacy).catch(() => {});
    syncDom();
  }
  const ready = initStorage().catch(() => {});

  // ---- Layer 2: HTTP Transport (Shreddit Partial Primary + JSON Fallback) ----
  const parseHdr = (raw, mode = 'min') => {
    if (raw == null) return NaN;
    const n = String(raw).split(',').map((s) => parseFloat(s.trim())).filter(Number.isFinite);
    return n.length ? (mode === 'max' ? Math.max(...n) : Math.min(...n)) : NaN;
  };
  function waitMsFrom429(res, text) {
    const hSec = parseHdr(res.headers.get('Retry-After'), 'max'); let bodyMs = 0;
    try { const j = JSON.parse(text), r = Number(j?.json?.ratelimit ?? j?.ratelimit ?? j?.retry_after); if (Number.isFinite(r) && r > 0) bodyMs = Math.ceil(r * 1000); } catch {}
    if (!bodyMs) { const s = text.match(/(\d+(?:\.\d+)?)\s*seconds?/i), m = text.match(/(\d+(?:\.\d+)?)\s*minutes?/i); bodyMs = s ? Math.ceil(Number(s[1]) * 1000) : m ? Math.ceil(Number(m[1]) * 60000) : 0; }
    return Math.max(Number.isFinite(hSec) && hSec > 0 ? hSec * 1000 : 0, bodyMs, CFG.fallback429Ms);
  }
  const set429 = (waitMs, now) => { rate.limitedUntil = Math.max(rate.limitedUntil, now + Math.max(waitMs, CFG.fallback429Ms)); rate.slowUntil = Math.max(rate.slowUntil, rate.limitedUntil + CFG.slowAfter429Ms); };
  const assertNotLimited = (now) => { if (rate.limitedUntil > now) { const e = new Error(`Rate limit active (${Math.ceil((rate.limitedUntil - now) / 1000)}s)`); e.status = 429; throw e; } };

  async function fetchRaw(url, opts = {}, accept = 'application/json', countDirect = false) {
    await ready;
    if (countDirect) {
      await withRate((now) => {
        assertNotLimited(now); rate.ts.push(now); rate.lastReqAt = Math.max(rate.lastReqAt, now);
        rate.nextBgAt = Math.max(rate.nextBgAt, now + CFG.hoverGapMs * (rate.slowUntil > now ? 2 : 1));
      });
    } else { mergeRate(await storeGet(K_RATE)); assertNotLimited(Date.now()); }
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    try {
      const res = await fetch(url, { ...opts, credentials: 'same-origin', headers: { Accept: accept, ...opts.headers }, signal: ctrl.signal });
      const text = await res.text().catch(() => '');
      const rem = parseHdr(res.headers.get('X-Ratelimit-Remaining'), 'min'), reset = parseHdr(res.headers.get('X-Ratelimit-Reset'), 'max');
      const lowQuota = Number.isFinite(rem) && rem <= CFG.reserveRem;
      if (res.status === 429 || lowQuota) {
        await withRate((now) => {
          if (res.status === 429) set429(waitMsFrom429(res, text), now);
          if (lowQuota) rate.pausedUntil = Math.max(rate.pausedUntil, now + (Number.isFinite(reset) && reset > 0 ? Math.min(reset, 120) : 60) * 1000);
        });
      }
      if (!res.ok) { const e = new Error(`Reddit HTTP ${res.status}`); e.status = res.status; throw e; }
      if (res.redirected) {
        const o = new URL(url, location.origin), d = new URL(res.url, location.origin);
        if (o.origin !== d.origin || !/^\/(?:(?:user|u)\/[^/]+\/(?:submitted|about)\.json|api\/me\.json|svc\/shreddit\/profiles\/profile_posts-more-posts\/(?:top|hot)\/?)$/i.test(d.pathname)) throw new Error('Unexpected redirect');
      }
      return { res, text };
    } finally { clearTimeout(timer); }
  }
  async function fetchJson(url, opts = {}, countDirect = false) {
    const { res, text } = await fetchRaw(url, opts, 'application/json', countDirect);
    if (opts.method === 'POST' && (res.status === 204 || !text.trim())) return {};
    const data = JSON.parse(text), errs = data?.json?.errors ?? data?.errors;
    if (Array.isArray(errs) && errs.length) {
      const lim = errs.some((e) => Array.isArray(e) && e[0] === 'RATELIMIT');
      if (lim) await withRate((now) => { set429(waitMsFrom429(res, text), now); });
      const e = new Error(errs.map((x) => (Array.isArray(x) ? x.slice(0, 2).join(': ') : String(x))).join('; ')); e.status = lim ? 429 : 0; throw e;
    }
    if (data?.error || data?.success === false) throw new Error(String(data.message || data.error || 'Rejected'));
    return data;
  }

  const isVisibleSubmissionItem = (c) => Boolean(c?.data && (!c.kind || c.kind === 't3') && !c.data.removed_by_category && c.data.removed !== true && c.data.spam !== true && c.data.hidden !== true && c.data.author !== '[deleted]');
  const parseJsonListing = (d) => { if (d?.kind !== 'Listing' || !Array.isArray(d?.data?.children)) throw new Error('Invalid listing'); return d.data.children.some(isVisibleSubmissionItem); };
  const MISSING_USER_RE = /Sorry,\s+nobody on Reddit goes by that name\.|This account has been suspended/i;
  function hasVisiblePartialPost(html) {
    if (typeof DOMParser === 'undefined') return /<shreddit-post\b/i.test(html) && !/slot\s*=\s*["']post-removed-banner["']/i.test(html);
    return [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('shreddit-post')].some((p) => {
      const a = (p.getAttribute('author') || '').trim().toLowerCase();
      return !p.parentElement?.closest('shreddit-post') && !p.hasAttribute('is-promoted') && !p.querySelector('[slot="post-removed-banner"]')
        && !p.getAttribute('removed-by-category') && p.getAttribute('is-removed') !== 'true' && a !== '[deleted]' && a !== '[removed]';
    });
  }
  async function fetchListingHasPosts(author, sort) {
    const enc = encodeURIComponent(author), isTop = sort === 'top';
    const jsonUrl = `${location.origin}/user/${enc}/submitted.json?limit=10&sort=${isTop ? 'top&t=all' : 'hot'}&raw_json=1`;
    if (!partialBroken) {
      try {
        const pUrl = `${location.origin}/svc/shreddit/profiles/profile_posts-more-posts/${isTop ? 'top/?sort=top' : 'hot/?sort=hot'}&t=ALL&name=${enc}`;
        const { res, text } = await fetchRaw(pUrl, {}, 'text/vnd.reddit.partial+html, text/html;q=0.9');
        const ct = (res.headers.get('Content-Type') || '').toLowerCase(), isHtml = ct.includes('partial+html') || ct.includes('text/html');
        if (isHtml && MISSING_USER_RE.test(text)) { const e = new Error('User missing'); e.status = 404; e.settledEmpty = true; throw e; }
        const isShell = /<shreddit-app\b/i.test(text) && !/<faceplate-batch\b/i.test(text);
        if (isHtml && !isShell && (/<faceplate-batch\b|<shreddit-post\b/i.test(text) || !/^\s*(?:<!doctype|<html\b)/i.test(text))) return hasVisiblePartialPost(text);
        const e = new Error('Unexpected partial content'); e.status = 406; throw e;
      } catch (err) {
        if (err.status === 429 || err.settledEmpty) throw err;
        const has = parseJsonListing(await fetchJson(jsonUrl, {}, true));
        if (err.status === 404 || err.status === 406 || err.status === 403) partialBroken = true;
        return has;
      }
    }
    return parseJsonListing(await fetchJson(jsonUrl));
  }

  // ---- Layer 3: Scheduler & Non-Destructive Top -> Hot Cascade ----
  function blockedUntil(priority, now) {
    rate.ts = pruneTs(rate.ts, now);
    const slow = rate.slowUntil > now, scale = slow ? 2 : 1;
    let until = Math.max(rate.limitedUntil, priority ? (rate.lastReqAt ? rate.lastReqAt + CFG.hoverGapMs * scale : 0) : Math.max(rate.pausedUntil, tabReadyAt, rate.nextBgAt));
    const maxMin = priority ? (slow ? 4 : CFG.totalMaxPerMin) : (slow ? 3 : CFG.bgMaxPerMin);
    const max10m = priority ? (slow ? 16 : CFG.totalMaxPer10Min) : (slow ? 12 : CFG.bgMaxPer10Min);
    const inMin = rate.ts.filter((t) => t > now - 60000);
    if (inMin.length >= maxMin) until = Math.max(until, inMin[inMin.length - maxMin] + 60050);
    if (rate.ts.length >= max10m) until = Math.max(until, rate.ts[rate.ts.length - max10m] + 600050);
    return until;
  }
  function setStatus(key, hasHot, hasTop) {
    authorCache.set(key, { hasHot, hasTop, expiresAt: Date.now() + (hasHot && hasTop ? CFG.ttlPresentMs : CFG.ttlEmptyMs) });
    partialTopFalse.delete(key); partialHotTrue.delete(key); retryAfter.delete(key); syncDom(key);
    if (!persistTimer) persistTimer = setTimeout(() => flushCache(false), 500);
  }
  function enqueueAuthor(author, priority = false) {
    const key = author.toLowerCase(), now = Date.now();
    if (blocked.has(key)) return;
    if (authorCache.get(key)?.expiresAt > now) { syncDom(key); return; }
    if (!priority && (retryAfter.get(key) || 0) > now) return;
    queue.set(key, { author, priority: Boolean(priority || queue.get(key)?.priority), seq: ++seq });
    pumpQueue();
  }
  const isNearby = (key) => [...document.querySelectorAll(`.${WRAP}`)].some((w) => (w.dataset.author || '').toLowerCase() === key && w.dataset.nearby === 'true');
  const pruneQueue = (now) => { for (const [k, item] of queue) if (blocked.has(k) || authorCache.get(k)?.expiresAt > now || (!item.priority && !isNearby(k))) queue.delete(k); };

  function pumpQueue() {
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    if (document.visibilityState === 'hidden' || pendingBlocks.size > 0 || activeKey) return;
    pruneQueue(Date.now()); if (!queue.size) return;
    activeKey = '__lock__';
    (async () => {
      let slot;
      try {
        await ready;
        slot = await withRate((now) => {
          pruneQueue(now);
          let pickKey = '', best = -Infinity, minWait = Infinity;
          for (const [k, item] of queue) {
            const wait = blockedUntil(item.priority, now) - now;
            if (wait <= 0) { const sc = (item.priority ? 1e9 : 0) + item.seq; if (sc > best) { best = sc; pickKey = k; } }
            else if (wait < minWait) minWait = wait;
          }
          if (!pickKey) return { dirty: false, wait: minWait };
          const item = queue.get(pickKey), scale = rate.slowUntil > now ? 2 : 1;
          queue.delete(pickKey); rate.ts.push(now); rate.lastReqAt = Math.max(rate.lastReqAt, now);
          const u = rate.ts.length, bgGap = (u < 12 ? 9500 : u < 20 ? 14000 : 20000) * scale + Math.floor(Math.random() * 500);
          rate.nextBgAt = Math.max(rate.nextBgAt, now + (item.priority ? CFG.hoverGapMs * scale : bgGap));
          return { key: pickKey, item };
        });
      } catch { activeKey = ''; return; }
      if (!slot?.item) { activeKey = ''; if (Number.isFinite(slot?.wait) && slot.wait > 0) queueTimer = setTimeout(pumpQueue, Math.min(slot.wait + 25, 60000)); return; }
      const { key, item } = slot; activeKey = key;
      try {
        if (!partialTopFalse.has(key)) {
          if (await fetchListingHasPosts(item.author, 'top')) { setStatus(key, true, true); return; }
          if (partialHotTrue.has(key)) { setStatus(key, true, false); return; }
          partialTopFalse.add(key); syncDom(key);
          // Background Step-2 inherits item.priority so it never steals hover-only reserve.
          queue.set(key, { author: item.author, priority: item.priority, seq: ++seq });
        } else setStatus(key, Boolean(await fetchListingHasPosts(item.author, 'hot')), false);
      } catch (err) {
        if (err.status === 404 || err.status === 403) setStatus(key, false, false);
        else { retryAfter.set(key, Math.max(Date.now() + CFG.failTtlMs, rate.limitedUntil)); syncDom(key, err?.message || 'Error'); }
      } finally { activeKey = ''; pumpQueue(); }
    })();
  }

  // ---- Layer 4: 1-Click Block Protocol ----
  const clearModhash = () => { cachedModhash = ''; try { sessionStorage.removeItem(K_MODHASH); } catch {} };
  async function getAuthTokens(forceModhash = false) {
    const c = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/), app = document.querySelector('shreddit-app'), domUh = document.querySelector('input[name="uh"]')?.value || '';
    const csrf = c ? safeDecode(c[1]) : (domUh || app?.csrfToken || app?.getAttribute('csrf-token') || app?.getAttribute('spp') || '');
    let uh = domUh || cachedModhash;
    if (!uh && (!csrf || forceModhash)) {
      if (!modhashPromise) {
        modhashPromise = fetchJson(`${location.origin}/api/me.json`, {}, true)
          .then((d) => { const mh = d?.data?.modhash || ''; if (mh) { cachedModhash = mh; try { sessionStorage.setItem(K_MODHASH, mh); } catch {} } return mh; })
          .catch(() => '').finally(() => { modhashPromise = null; });
      }
      uh = await modhashPromise;
    }
    return { uh, csrf };
  }
  async function executeBlock(author, authorId) {
    let { uh, csrf } = await getAuthTokens(false);
    if (!uh && !csrf) throw new Error('No session token (sign in to Reddit).');
    const postBlock = (id) => fetchJson(`${location.origin}/api/block_user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(uh && { 'X-Modhash': uh }), ...(csrf && { 'X-CSRF-Token': csrf }) },
      body: new URLSearchParams({ name: author, api_type: 'json', ...(uh && { uh }), ...(id && { account_id: id }) }).toString(),
    }, true);
    const attempt = async (id) => {
      try { await postBlock(id); } catch (err) {
        if ((err.status === 401 || err.status === 403) && !uh) { clearModhash(); ({ uh, csrf } = await getAuthTokens(true)); if (!uh) throw err; await postBlock(id); return; }
        throw err;
      }
    };
    const validId = /^t2_[a-z0-9]+$/i.test(authorId || '') ? authorId : '';
    try { await attempt(validId); } catch (err) {
      if (err.status === 429 || validId) throw err;
      const prof = await fetchJson(`${location.origin}/user/${encodeURIComponent(author)}/about.json?raw_json=1`, {}, true).catch(() => null);
      const id = typeof prof?.data?.id === 'string' && /^[a-z0-9]+$/i.test(prof.data.id) ? `t2_${prof.data.id}` : '';
      if (!id) throw err;
      await attempt(id);
    }
  }
  async function onBlockClick(wrap, blockBtn, fallbackAuthor, fallbackId, e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const curAuthor = wrap.dataset.author || fallbackAuthor, curId = wrap.dataset.authorId || fallbackId, key = curAuthor.toLowerCase();
    if (blockBtn.disabled || pendingBlocks.has(key) || blocked.has(key)) return;
    blockErrors.delete(key); pendingBlocks.add(key); syncDom(key); pumpQueue();
    let fail = null;
    try {
      const run = async () => {
        const wait = nextBlockAt - Date.now();
        if (wait > 0 && rate.limitedUntil <= Date.now()) await new Promise((r) => setTimeout(r, wait));
        try { return await executeBlock(curAuthor, curId); } finally { nextBlockAt = Date.now() + CFG.blockCooldownMs; }
      };
      const p = blockChain.then(run, run); blockChain = p.catch(() => {}); await p;
      blocked.add(key); await saveBlocked();
    } catch (err) { fail = err; blockErrors.set(key, err); if (err.status === 401 || err.status === 403) clearModhash(); }
    finally {
      pendingBlocks.delete(key);
      if (fail) {
        const ms = fail.status === 429 ? Math.min(Math.max(rate.limitedUntil - Date.now(), CFG.errorLockMs), 15000) : CFG.errorLockMs;
        const setLock = (on) => document.querySelectorAll(`.${WRAP}`).forEach((w) => {
          if ((w.dataset.author || '').toLowerCase() === key) { const b = w.querySelector('[data-role="block"]'); if (b) on ? (b.dataset.locked = 'true') : delete b.dataset.locked; }
        });
        setLock(true); syncDom(key); setTimeout(() => { setLock(false); syncDom(key); }, ms);
      } else syncDom(key);
      pumpQueue();
    }
  }

  // ---- Layer 5: DOM Rendering, Passive Profile Seeding, and Observers ----
  function paintLink(btn, state, label, emptyLabel, errMsg) {
    if (!btn) return;
    btn.dataset.postsState = state === null ? 'unknown' : state ? 'present' : 'empty';
    btn.title = state === null && errMsg ? `Could not check posts: ${errMsg}` : '';
    btn.classList.toggle('irb-empty', state === false); btn.textContent = '';
    if (state === false) { const b = document.createElement('span'); b.className = 'irb-badge'; b.textContent = '✕'; const t = document.createElement('span'); t.textContent = emptyLabel; btn.append(b, t); }
    else btn.textContent = label;
  }
  function syncWrap(wrap, errMsg = '') {
    const key = (wrap.dataset.author || '').toLowerCase(), rec = authorCache.get(key), valid = Boolean(rec && rec.expiresAt > Date.now());
    paintLink(wrap.querySelector('[data-role="posts"]'), valid ? rec.hasHot : partialHotTrue.has(key) ? true : null, 'Posts', 'No posts', errMsg);
    paintLink(wrap.querySelector('[data-role="top"]'), valid ? rec.hasTop : partialTopFalse.has(key) ? false : null, 'Top posts', 'No top', errMsg);
    const btn = wrap.querySelector('[data-role="block"]');
    if (btn) {
      const err = blockErrors.get(key), locked = btn.dataset.locked === 'true';
      btn.className = 'irb-btn'; btn.title = '';
      if (blocked.has(key)) { btn.classList.add('irb-blocked'); btn.textContent = '✓ Blocked'; btn.disabled = true; }
      else if (pendingBlocks.has(key)) { btn.classList.add('irb-block', 'irb-wait'); btn.textContent = '⋯ Blocking'; btn.disabled = true; }
      else if (err) { btn.classList.add('irb-err'); if (locked) btn.classList.add('irb-locked'); btn.textContent = locked ? '✕ Wait...' : '✕ Retry block'; btn.title = err.message; btn.disabled = locked; }
      else { btn.classList.add('irb-block'); btn.textContent = '⊘ Block'; btn.disabled = false; }
    }
    wrap.closest(POST_SEL)?.classList.toggle('irb-dimmed', blocked.has(key));
  }
  const syncDom = (key = '', errMsg = '') => document.querySelectorAll(`.${WRAP}`).forEach((w) => { if (!key || (w.dataset.author || '').toLowerCase() === key) syncWrap(w, errMsg); });
  const clearTimers = (w) => { const t = timers.get(w); if (t) { clearTimeout(t.d); clearTimeout(t.h); timers.delete(w); } };
  const findOwnWrap = (post) => [...post.querySelectorAll(`.${WRAP}`)].find((w) => w.closest(POST_SEL) === post) || null;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      const w = postToWrap.get(e.target) || findOwnWrap(e.target);
      if (!w) return;
      w.dataset.nearby = String(e.isIntersecting);
      if (!e.isIntersecting) { clearTimers(w); return; }
      const author = w.dataset.author || '', key = author.toLowerCase();
      if (!author || blocked.has(key) || w.dataset.noAuto === 'true') return;
      if (authorCache.get(key)?.expiresAt > Date.now()) { syncWrap(w); return; }
      const slot = timers.get(w) || {};
      if (!slot.d && activeKey !== key && !queue.has(key)) {
        slot.d = setTimeout(() => { delete slot.d; if (w.isConnected && w.dataset.nearby === 'true') enqueueAuthor(author, false); }, CFG.dwellMs);
        timers.set(w, slot);
      }
    });
    pumpQueue();
  }, { rootMargin: '0px', threshold: 0.15 });

  function getProfileCtx() {
    const m = location.pathname.match(/^\/(?:user|u)\/([^/?#]+)\/submitted\/?$/i);
    if (!m) return null;
    const p = new URLSearchParams(location.search);
    return { owner: safeDecode(m[1]).toLowerCase(), sort: (p.get('sort') || 'hot').toLowerCase(), t: (p.get('t') || '').toLowerCase() };
  }
  function seedEmptyProfileIfReady() {
    const ctx = getProfileCtx();
    if (!ctx || authorCache.get(ctx.owner)?.expiresAt > Date.now()) return;
    if ([...document.querySelectorAll(POST_SEL)].some((p) => !p.matches(AD_SEL) && !p.hasAttribute('is-promoted') && !p.parentElement?.closest(POST_SEL) && normAuthor(p.getAttribute(p.matches('shreddit-post') ? 'author' : 'data-author') || '').toLowerCase() === ctx.owner)) return;
    const emptyEl = document.querySelector('p#noresults.error, [data-testid="empty-state"], shreddit-empty-state, faceplate-partial[name*="empty"]');
    const textEmpty = /hasn't posted yet|no posts yet|doesn't seem to be anything here|keeps their posts hidden|hidden their posts/.test((document.querySelector('main, [role="main"]')?.textContent || '').toLowerCase());
    if (!emptyEl && !textEmpty) return;
    if (ctx.sort === 'hot') setStatus(ctx.owner, false, false);
    else if (ctx.sort === 'top' && (!ctx.t || ctx.t === 'all')) { partialTopFalse.add(ctx.owner); syncDom(ctx.owner); }
  }
  function createWrap(author, authorId, noAuto) {
    const enc = encodeURIComponent(author), wrap = document.createElement('span');
    wrap.className = WRAP; wrap.dataset.author = author; wrap.dataset.authorId = authorId; wrap.dataset.noAuto = String(noAuto);
    const mkLink = (role, label, path) => {
      const a = document.createElement('a');
      a.className = 'irb-btn'; a.dataset.role = role; a.dataset.postsState = 'unknown';
      a.href = new URL(path, location.origin).href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label;
      const onNav = (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        e.stopPropagation(); e.stopImmediatePropagation();
        if (a.dataset.postsState === 'empty') { e.preventDefault(); return; }
        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && /^\/(?:user|u)\/[^/]+(?:\/|$)/i.test(location.pathname)) { e.preventDefault(); location.assign(a.href); }
      };
      a.addEventListener('click', onNav); a.addEventListener('auxclick', (e) => { if (e.button === 1) onNav(e); });
      return a;
    };
    const postsBtn = mkLink('posts', 'Posts', `/user/${enc}/submitted/?sort=hot`), topBtn = mkLink('top', 'Top posts', `/user/${enc}/submitted/?sort=top&t=all`);
    const blockBtn = document.createElement('button');
    blockBtn.type = 'button'; blockBtn.className = 'irb-btn irb-block'; blockBtn.dataset.role = 'block';
    blockBtn.addEventListener('click', (e) => onBlockClick(wrap, blockBtn, author, authorId, e));
    wrap.append(postsBtn, topBtn, blockBtn);
    ['pointerdown', 'mousedown', 'mouseup'].forEach((ev) => wrap.addEventListener(ev, (e) => e.stopPropagation()));
    const cancelHover = () => { const t = timers.get(wrap); if (t?.h) { clearTimeout(t.h); delete t.h; } };
    const startHover = () => {
      cancelHover();
      if (authorCache.get(author.toLowerCase())?.expiresAt > Date.now()) { syncWrap(wrap); return; }
      const slot = timers.get(wrap) || {};
      slot.h = setTimeout(() => { delete slot.h; if (!wrap.isConnected) return; wrap.dataset.nearby = 'true'; enqueueAuthor(author, true); }, CFG.hoverMs);
      timers.set(wrap, slot);
    };
    [postsBtn, topBtn].forEach((b) => { b.addEventListener('pointerenter', startHover); b.addEventListener('focus', startHover); b.addEventListener('pointerleave', cancelHover); b.addEventListener('blur', cancelHover); });
    syncWrap(wrap); return wrap;
  }
  function processPost(post) {
    if (!post.isConnected || post.matches(AD_SEL) || post.hasAttribute('is-promoted')) return;
    const modern = post.matches('shreddit-post'), isNested = Boolean(post.parentElement?.closest(POST_SEL));
    const bar = modern ? [...post.querySelectorAll(BAR_SEL)].find((el) => el.closest(POST_SEL) === post) : post.querySelector('p.tagline');
    const rawAuth = post.getAttribute(modern ? 'author' : 'data-author') || [...(bar || post).querySelectorAll('a[href*="/user/"],a[href*="/u/"]')].find((a) => !a.closest(`.${WRAP}`) && a.closest(POST_SEL) === post)?.getAttribute('href')?.match(/\/(?:user|u)\/([^/?#]+)/i)?.[1] || '';
    const author = normAuthor(rawAuth), key = author.toLowerCase(), directId = post.getAttribute(modern ? 'author-id' : 'data-author-fullname') || '';
    const authorId = /^t2_[a-z0-9]+$/i.test(directId) ? directId : [...post.querySelectorAll('[author-id],[data-author-fullname]')].map((el) => (el.closest(POST_SEL) === post ? el.getAttribute('author-id') || el.getAttribute('data-author-fullname') : '')).find((v) => /^t2_[a-z0-9]+$/i.test(v || '')) || '';
    const prof = !isNested ? getProfileCtx() : null, isOwnerSubmitted = Boolean(prof && prof.owner === key), noAuto = isNested || isOwnerSubmitted;
    const existing = findOwnWrap(post);
    if (existing) {
      if (existing.dataset.author === author) {
        if (authorId && existing.dataset.authorId !== authorId) existing.dataset.authorId = authorId;
        existing.dataset.noAuto = String(noAuto);
        if (!noAuto) { postToWrap.set(post, existing); observer.observe(post); }
        syncWrap(existing); return;
      }
      clearTimers(existing); observer.unobserve(post); postToWrap.delete(post); existing.remove();
    }
    if (!author || SKIP_AUTHORS.has(key) || !bar) return;
    if (isOwnerSubmitted) {
      if (prof.sort === 'top') setStatus(key, true, true);
      else if (prof.sort === 'hot') { const cur = authorCache.get(key); if (cur?.expiresAt > Date.now()) setStatus(key, true, cur.hasTop); else partialHotTrue.add(key); }
    }
    const wrap = createWrap(author, authorId, noAuto);
    if (modern) {
      post.style.isolation = 'isolate'; bar.classList.add('irb-bar');
      if (bar.firstElementChild) { bar.firstElementChild.after(wrap); if (wrap.nextElementSibling) wrap.nextElementSibling.style.marginLeft = '0'; }
      else bar.appendChild(wrap);
    } else bar.appendChild(wrap);
    if (!noAuto) { postToWrap.set(post, wrap); observer.observe(post); }
  }

  const applyExternal = (k, val) => {
    if (k === K_STATUS && val) { mergeStatus(val); syncDom(); }
    else if (k === K_BLOCKED && Array.isArray(val)) { val.forEach((a) => blocked.add(String(a).toLowerCase())); syncDom(); }
    else if (k === K_RATE && val) { mergeRate(val); pumpQueue(); }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ready.then(async () => {
        mergeRate(await storeGet(K_RATE)); mergeStatus(await storeGet(K_STATUS)); syncDom();
        document.querySelectorAll(`.${WRAP}`).forEach((w) => { const p = w.closest(POST_SEL); if (p && w.dataset.noAuto !== 'true') { observer.unobserve(p); observer.observe(p); } });
        pumpQueue();
      });
    } else { flushCache(true); document.querySelectorAll(`.${WRAP}`).forEach(clearTimers); }
  });
  window.addEventListener('pagehide', () => flushCache(true));
  if (typeof chrome !== 'undefined') chrome?.storage?.onChanged?.addListener((c, area) => { if (area === 'local') Object.entries(c).forEach(([k, ch]) => applyExternal(k, ch?.newValue)); });
  window.addEventListener('storage', (e) => { if (e.key && e.newValue) { try { applyExternal(e.key, JSON.parse(e.newValue)); } catch {} } });

  let raf = false;
  const pending = new Set();
  const collect = (n) => { if (n.nodeType !== 1) return; if (n.matches(POST_SEL)) pending.add(n); const p = n.closest(POST_SEL); if (p) pending.add(p); n.querySelectorAll(POST_SEL).forEach((el) => pending.add(el)); };
  const cleanupRemoved = (n) => {
    if (n.nodeType !== 1) return;
    (n.matches(`.${WRAP}`) ? [n] : [...n.querySelectorAll(`.${WRAP}`)]).forEach((w) => { clearTimers(w); w.dataset.nearby = 'false'; });
    (n.matches(POST_SEL) ? [n, ...n.querySelectorAll(POST_SEL)] : [...n.querySelectorAll(POST_SEL)]).forEach((p) => { observer.unobserve(p); postToWrap.delete(p); });
  };
  document.querySelectorAll(POST_SEL).forEach(processPost);
  setTimeout(() => ready.then(seedEmptyProfileIfReady), CFG.settleMs);
  if (document.body) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target.nodeType === 1 && m.target.closest(`.${WRAP}`)) continue;
        if (m.type === 'attributes') { collect(m.target); continue; }
        if (m.target.nodeType === 1) { const p = m.target.closest(POST_SEL); if (p) pending.add(p); }
        m.removedNodes?.forEach(cleanupRemoved); m.addedNodes?.forEach(collect);
      }
      if (raf || !pending.size) return;
      raf = true;
      requestAnimationFrame(() => { raf = false; const list = [...pending]; pending.clear(); list.forEach(processPost); seedEmptyProfileIfReady(); });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['author', 'author-id', 'data-author', 'data-author-fullname'] });
  }
})();
