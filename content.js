const WRAP_CLASS = 'author-btns-wrap';
const POST_SELECTOR = 'shreddit-post, .thing.link';
const BLOCKED_KEY = 'ivory_reddit_blocked_v1';
const STATUS_KEY = 'ivory_reddit_author_status_v5';
const QUOTA_KEY = 'ivory_reddit_ratelimit_v5';
const OLD_QUOTA_KEYS = ['ivory_reddit_ratelimit_v1', 'ivory_reddit_ratelimit_v2', 'ivory_reddit_ratelimit_v3', 'ivory_reddit_ratelimit_v4'];
const OLD_STATUS_KEYS = ['ivory_reddit_author_status_v1', 'ivory_reddit_author_status_v2', 'ivory_reddit_author_status_v3', 'ivory_reddit_author_status_v4', 'ivory_reddit_last_req_v1'];
const SKIP_AUTHORS = new Set(['automoderator', '[deleted]', '[removed]', 'reddit']);

const BASE_BTN_STYLE = 'position:relative;z-index:10;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;min-height:26px;max-height:26px;min-width:0;appearance:none;vertical-align:middle;gap:5px;margin:0;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;line-height:16px;text-decoration:none;white-space:nowrap;cursor:pointer;user-select:none;font-family:inherit;flex-shrink:0;transition:background 0.15s,border-color 0.15s,color 0.15s,opacity 0.15s;';
const NORMAL_THEME = { bg: '#272729', bgHover: '#343536', color: '#d7dadc', border: '#343536' };
const EMPTY_THEME = { bg: '#3b1d20', bgHover: '#4f262a', color: '#f5b7b1', border: '#6e2c33' };
const BLOCK_THEME = { bg: '#33241b', bgHover: '#473022', color: '#f5cba7', border: '#5c3d2e' };
const BLOCKED_THEME = { bg: '#1b2e22', bgHover: '#1b2e22', color: '#82e0aa', border: '#2e523b' };
const BADGE_STYLE = 'display:inline-block;padding:1px 5px;background:#6e2c33;color:#ffd7d5;border-radius:999px;font-size:10px;font-weight:700;line-height:13px;';

const WIN_SHORT_MS = 60_000, WIN_LONG_MS = 600_000, RATE_FLOOR_MS = 600_000;
const BG_MAX_MIN = 5, TOT_MAX_MIN = 7, BG_MAX_10M = 24, TOT_MAX_10M = 30;
const DWELL_MS = 850, HOVER_MS = 120, HOVER_GAP_MS = 1800, REQ_TIMEOUT_MS = 12_000;
const TTL_OK_MS = 86_400_000, TTL_EMPTY_MS = 14_400_000, FAIL_TTL_MS = 60_000, BLOCK_COOLDOWN_MS = 1500;

const authorCache = new Map(), inFlight = new Map(), retryAfter = new Map();
const partialTopEmpty = new Map(), partialHotOk = new Map();
const blockedAuthors = new Set(), pendingBlocks = new Set(), authorErrors = new Map();
const dwellTimers = new WeakMap(), hoverTimers = new WeakMap(), postToWrap = new WeakMap(), dimmedPosts = new WeakMap();
const fetchQueue = [];
let activeReqs = 0, reservingSlot = false, queueTimer = null, persistTimer = null;
let cachedModhash = '', modhashPromise = null, blockChain = Promise.resolve(), nextBlockAt = 0, seqCounter = 0, adaptiveScale = 1;

initStorage();

function readJson(key) {
  try { const raw = localStorage.getItem(key) || sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function writeJson(key, val) {
  const str = JSON.stringify(val);
  try { localStorage.setItem(key, str); } catch {}
  try { sessionStorage.setItem(key, str); } catch {}
}

function withQuotaLock(fn) {
  return navigator.locks?.request ? navigator.locks.request('ivory_reddit_quota_v5', fn) : Promise.resolve().then(fn);
}

function readQuotaState(now = Date.now()) {
  const d = readJson(QUOTA_KEY) || {};
  const recentTimestamps = (Array.isArray(d.recentTimestamps) ? d.recentTimestamps : [])
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t > now - WIN_LONG_MS)
    .sort((a, b) => a - b)
    .slice(-TOT_MAX_10M);
  return {
    rateLimitedUntil: Number(d.rateLimitedUntil) || 0,
    quotaPausedUntil: Number(d.quotaPausedUntil) || 0,
    nextRequestAt: Number(d.nextRequestAt) || 0,
    lastRequestAt: Number(d.lastRequestAt) || 0,
    recentTimestamps,
  };
}

function initStorage() {
  const now = Date.now(), cur = readQuotaState(now);
  let migrated = false;
  for (const k of OLD_QUOTA_KEYS) {
    const old = readJson(k);
    if (old && typeof old === 'object') {
      if (Number(old.rateLimitedUntil) > cur.rateLimitedUntil) cur.rateLimitedUntil = Number(old.rateLimitedUntil);
      const ts = old.recentTimestamps || old.recentBgTimestamps;
      if (Array.isArray(ts)) {
        cur.recentTimestamps = [...new Set([...cur.recentTimestamps, ...ts])].filter((t) => typeof t === 'number' && t > now - WIN_LONG_MS).sort((a, b) => a - b).slice(-TOT_MAX_10M);
      }
      migrated = true;
    }
    try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {}
  }
  if (migrated) writeJson(QUOTA_KEY, cur);
  for (const k of OLD_STATUS_KEYS) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} }
  const blk = readJson(BLOCKED_KEY);
  if (Array.isArray(blk)) blk.forEach((a) => blockedAuthors.add(String(a).toLowerCase()));
  hydrateAuthorCache();
}

function hydrateAuthorCache() {
  const data = readJson(STATUS_KEY);
  if (!data || typeof data !== 'object') return;
  const now = Date.now();
  for (const [k, v] of Object.entries(data)) {
    if (v && v.expiresAt > now && typeof v.hasHot === 'boolean' && typeof v.hasTop === 'boolean') {
      authorCache.set(k.toLowerCase(), { hasHot: v.hasHot, hasTop: v.hasTop, expiresAt: v.expiresAt });
    }
  }
}

function persistAuthorCacheNow() {
  if (persistTimer !== null) { clearTimeout(persistTimer); persistTimer = null; }
  hydrateAuthorCache();
  const now = Date.now(), out = {};
  for (const [k, v] of authorCache.entries()) {
    if (v.expiresAt <= now) authorCache.delete(k);
    else if (typeof v.hasHot === 'boolean' && typeof v.hasTop === 'boolean') out[k] = { hasHot: v.hasHot, hasTop: v.hasTop, expiresAt: v.expiresAt };
  }
  writeJson(STATUS_KEY, out);
}

function schedulePersistCache() {
  if (persistTimer === null) persistTimer = setTimeout(persistAuthorCacheNow, 500);
}

class RequestError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) { super(message); this.status = status; this.retryable = retryable; }
}

function parseHeaderNum(raw, mode = 'min') {
  if (raw === null || raw === undefined) return NaN;
  const nums = String(raw).split(',').map((s) => parseFloat(s.trim())).filter(Number.isFinite);
  return nums.length ? (mode === 'max' ? Math.max(...nums) : Math.min(...nums)) : NaN;
}

async function reserveSlot(isPriority) {
  return withQuotaLock(() => {
    const now = Date.now(), st = readQuotaState(now);
    const inShort = st.recentTimestamps.filter((t) => t > now - WIN_SHORT_MS);
    const hoverFloor = st.lastRequestAt ? st.lastRequestAt + HOVER_GAP_MS * adaptiveScale : 0;
    let blockedUntil = Math.max(st.rateLimitedUntil, isPriority ? 0 : st.quotaPausedUntil, isPriority ? hoverFloor : st.nextRequestAt);
    const maxMin = isPriority ? TOT_MAX_MIN : BG_MAX_MIN, max10m = isPriority ? TOT_MAX_10M : BG_MAX_10M;
    if (inShort.length >= maxMin) blockedUntil = Math.max(blockedUntil, inShort[inShort.length - maxMin] + WIN_SHORT_MS + 50);
    if (st.recentTimestamps.length >= max10m) blockedUntil = Math.max(blockedUntil, st.recentTimestamps[st.recentTimestamps.length - max10m] + WIN_LONG_MS + 50);
    if (blockedUntil > now) return { allowed: false, waitMs: blockedUntil - now };

    st.recentTimestamps.push(now);
    st.lastRequestAt = now;
    const bgStep = inShort.length < 2 ? 2600 : inShort.length < 4 ? 6500 : 11000;
    st.nextRequestAt = isPriority ? Math.max(st.nextRequestAt, now + HOVER_GAP_MS * adaptiveScale) : now + bgStep * adaptiveScale + Math.floor(Math.random() * 400);
    writeJson(QUOTA_KEY, st);
    return { allowed: true, waitMs: 0 };
  });
}

async function recordResponseHeaders(res, bodyText = '') {
  const now = Date.now(), is429 = res.status === 429;
  const rem = parseHeaderNum(res.headers.get('X-Ratelimit-Remaining'), 'min');
  const reset = parseHeaderNum(res.headers.get('X-Ratelimit-Reset'), 'max');
  if (!is429 && !(Number.isFinite(rem) && rem <= 20)) return;
  await withQuotaLock(() => {
    const st = readQuotaState(now);
    if (is429) {
      adaptiveScale = 2;
      const hSec = parseHeaderNum(res.headers.get('Retry-After'), 'max');
      const secM = bodyText.match(/(\d+(?:\.\d+)?)\s*seconds?/i), minM = bodyText.match(/(\d+(?:\.\d+)?)\s*minutes?/i);
      const bMs = secM ? Number(secM[1]) * 1000 : minM ? Number(minM[1]) * 60_000 : 0;
      st.rateLimitedUntil = Math.max(st.rateLimitedUntil, now + Math.max(Number.isFinite(hSec) ? hSec * 1000 : 0, bMs, RATE_FLOOR_MS));
    }
    if (Number.isFinite(rem) && rem <= 20) {
      st.quotaPausedUntil = Math.max(st.quotaPausedUntil, now + (Number.isFinite(reset) && reset > 0 ? Math.min(reset, 300) : 60) * 1000);
    }
    writeJson(QUOTA_KEY, st);
  });
}

async function fetchJsonDirect(url, options = {}) {
  if (readQuotaState().rateLimitedUntil > Date.now()) throw new RequestError('Rate limited', { status: 429, retryable: true });
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, credentials: 'same-origin', headers: { Accept: 'application/json', ...options.headers }, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    await recordResponseHeaders(res, res.status === 429 ? text : '');
    if (!res.ok) throw new RequestError(`HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    if (options.method === 'POST' && (res.status === 204 || !text.trim())) return {};
    const data = JSON.parse(text), errs = data?.json?.errors ?? data?.errors;
    if (Array.isArray(errs) && errs.length) {
      const lim = errs.some((e) => Array.isArray(e) && e[0] === 'RATELIMIT');
      if (lim) await recordResponseHeaders({ status: 429, headers: new Headers() }, text);
      throw new RequestError('Reddit API error', { status: lim ? 429 : 0, retryable: lim });
    }
    return data;
  } finally { clearTimeout(timer); }
}

function isAuthorVisible(authorKey) {
  for (const w of document.querySelectorAll(`.${WRAP_CLASS}`)) {
    if ((w.dataset.author || '').toLowerCase() === authorKey && w.dataset.nearby === 'true') return true;
  }
  return false;
}

async function processQueue() {
  if (queueTimer !== null) { clearTimeout(queueTimer); queueTimer = null; }
  if (document.visibilityState === 'hidden' || pendingBlocks.size > 0 || activeReqs >= 1 || reservingSlot) return;
  for (let i = fetchQueue.length - 1; i >= 0; i--) {
    const it = fetchQueue[i];
    if (blockedAuthors.has(it.authorKey) || (!it.priority && !isAuthorVisible(it.authorKey))) { fetchQueue.splice(i, 1); it.resolve(null); }
  }
  if (!fetchQueue.length) return;

  let bestIdx = 0;
  for (let i = 1; i < fetchQueue.length; i++) {
    if ((fetchQueue[i].priority ? 1e9 : 0) + fetchQueue[i].seq > (fetchQueue[bestIdx].priority ? 1e9 : 0) + fetchQueue[bestIdx].seq) bestIdx = i;
  }
  reservingSlot = true;
  let slot;
  try { slot = await reserveSlot(fetchQueue[bestIdx].priority); } finally { reservingSlot = false; }
  if (!slot.allowed) { queueTimer = setTimeout(processQueue, Math.min(slot.waitMs + 30, 60_000)); return; }
  if (!fetchQueue.length || activeReqs >= 1) return;

  const [entry] = fetchQueue.splice(bestIdx, 1);
  activeReqs++;
  Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => { activeReqs--; processQueue(); });
}

function isVisiblePost(child) {
  const d = child?.data;
  return Boolean(d && (!child.kind || child.kind === 't3') && !d.removed_by_category && !d.removed && !d.spam && !d.hidden && d.author !== '[deleted]');
}

async function fetchListing(url, authorKey, priority) {
  const data = await new Promise((resolve, reject) => {
    fetchQueue.push({ task: () => fetchJsonDirect(url), resolve, reject, authorKey, priority: Boolean(priority), seq: ++seqCounter });
    processQueue();
  });
  if (data === null) return null;
  const children = data?.data?.children;
  if (data?.kind !== 'Listing' || !Array.isArray(children)) throw new RequestError('Invalid listing', { retryable: true });
  return children.some(isVisiblePost);
}

function applyTheme(btn, theme) {
  btn.dataset.bg = theme.bg; btn.dataset.bgHover = theme.bgHover;
  btn.style.background = theme.bg; btn.style.color = theme.color; btn.style.border = `1px solid ${theme.border}`;
}

function renderListingBtn(btn, hasPosts, label, emptyLabel) {
  if (!btn) return;
  btn.dataset.postsState = hasPosts === null ? 'unknown' : hasPosts ? 'present' : 'empty';
  if (hasPosts === false) {
    applyTheme(btn, EMPTY_THEME); btn.textContent = '';
    const b = document.createElement('span'); b.style.cssText = BADGE_STYLE; b.textContent = '✕';
    const l = document.createElement('span'); l.textContent = emptyLabel;
    btn.append(b, l);
  } else { applyTheme(btn, NORMAL_THEME); btn.textContent = label; }
}

function syncAuthorButtons(author, status) {
  const key = author.toLowerCase();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((w) => {
    if ((w.dataset.author || '').toLowerCase() !== key) return;
    if ('hasHot' in status && status.hasHot !== undefined) renderListingBtn(w.querySelector('[data-role="posts"]'), status.hasHot, 'Posts', 'No posts');
    if ('hasTop' in status && status.hasTop !== undefined) renderListingBtn(w.querySelector('[data-role="top"]'), status.hasTop, 'Top posts', 'No top');
  });
}

function saveSettled(author, hasHot, hasTop) {
  const key = author.toLowerCase(), ttl = hasHot && hasTop ? TTL_OK_MS : TTL_EMPTY_MS;
  const rec = { hasHot: Boolean(hasHot), hasTop: Boolean(hasTop), expiresAt: Date.now() + ttl };
  authorCache.set(key, rec); partialTopEmpty.delete(key); partialHotOk.delete(key); retryAfter.delete(key);
  syncAuthorButtons(author, rec); schedulePersistCache();
  return rec;
}

function checkAuthorCascade(author, priority = false) {
  const key = author.toLowerCase();
  if (!key || SKIP_AUTHORS.has(key) || blockedAuthors.has(key)) return Promise.resolve(null);
  const now = Date.now(), cached = authorCache.get(key);
  if (cached && cached.expiresAt > now) { syncAuthorButtons(author, cached); return Promise.resolve(cached); }
  if (!priority && (retryAfter.get(key) || 0) > now) return Promise.resolve(null);
  if (inFlight.has(key)) {
    if (priority) { fetchQueue.forEach((it) => { if (it.authorKey === key) { it.priority = true; it.seq = ++seqCounter; } }); processQueue(); }
    return inFlight.get(key);
  }
  const enc = encodeURIComponent(author);
  const topUrl = `${location.origin}/user/${enc}/submitted.json?limit=10&sort=top&t=all&raw_json=1`;
  const hotUrl = `${location.origin}/user/${enc}/submitted.json?limit=10&sort=hot&raw_json=1`;

  const prom = (async () => {
    let topEmpty = (partialTopEmpty.get(key) || 0) > Date.now();
    try {
      if (!topEmpty) {
        const hasTop = await fetchListing(topUrl, key, priority);
        if (hasTop === null) return null;
        if (hasTop === true) return saveSettled(author, true, true);
        topEmpty = true; partialTopEmpty.set(key, Date.now() + 1_800_000); syncAuthorButtons(author, { hasTop: false });
      }
      if ((partialHotOk.get(key) || 0) > Date.now()) return saveSettled(author, true, false);
      const hasHot = await fetchListing(hotUrl, key, true);
      return hasHot === null ? null : saveSettled(author, Boolean(hasHot), false);
    } catch (err) {
      if (err instanceof RequestError && (err.status === 404 || err.status === 403)) return saveSettled(author, false, false);
      retryAfter.set(key, Math.max(Date.now() + FAIL_TTL_MS, readQuotaState().rateLimitedUntil));
      syncAuthorButtons(author, { hasHot: null, hasTop: topEmpty ? false : null });
      return null;
    } finally { inFlight.delete(key); }
  })();
  inFlight.set(key, prom);
  return prom;
}

function bindHoverStop(btn) {
  btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = btn.dataset.bgHover; });
  btn.addEventListener('mouseleave', () => { btn.style.background = btn.dataset.bg; });
  ['pointerdown', 'mousedown', 'mouseup'].forEach((ev) => btn.addEventListener(ev, (e) => e.stopPropagation()));
}

function createLinkBtn(text, url) {
  const fullUrl = new URL(url, location.origin).href, btn = document.createElement('a');
  btn.href = fullUrl; btn.target = '_blank'; btn.rel = 'noopener noreferrer'; btn.textContent = text; btn.style.cssText = BASE_BTN_STYLE;
  applyTheme(btn, NORMAL_THEME); bindHoverStop(btn);
  const onClick = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.stopPropagation(); e.stopImmediatePropagation();
    if (btn.dataset.postsState === 'empty') { e.preventDefault(); return; }
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && /^\/(?:user|u)\/[^/]+/i.test(location.pathname)) { e.preventDefault(); location.assign(fullUrl); }
  };
  btn.addEventListener('click', onClick); btn.addEventListener('auxclick', (e) => { if (e.button === 1) onClick(e); });
  return btn;
}

async function blockAccountRequest(author, authorId) {
  const cookieM = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/), app = document.querySelector('shreddit-app');
  const csrf = (cookieM ? decodeURIComponent(cookieM[1]) : '') || app?.csrfToken || app?.getAttribute('csrf-token') || '';
  let uh = document.querySelector('input[name="uh"]')?.value || cachedModhash;
  if (!uh && !modhashPromise) modhashPromise = fetchJsonDirect(`${location.origin}/api/me.json`).then((d) => (cachedModhash = d?.data?.modhash || '')).catch(() => '').finally(() => { modhashPromise = null; });
  if (!uh && modhashPromise) uh = await modhashPromise;
  if (!uh && !csrf) throw new RequestError('Not signed in');

  const sendPost = async (accId) => {
    const p = new URLSearchParams({ name: author, api_type: 'json' });
    if (uh) p.set('uh', uh); if (accId) p.set('account_id', accId);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (uh) headers['X-Modhash'] = uh; if (csrf) headers['X-CSRF-Token'] = csrf;
    await fetchJsonDirect(`${location.origin}/api/block_user`, { method: 'POST', headers, body: p.toString() });
  };
  const validId = /^t2_[a-z0-9]+$/i.test(authorId || '') ? authorId : '';
  try { await sendPost(validId); } catch (err) {
    if (err.status === 429 || validId) throw err;
    const prof = await fetchJsonDirect(`${location.origin}/user/${encodeURIComponent(author)}/about.json?raw_json=1`).catch(() => null);
    if (!prof?.data?.id) throw err;
    await sendPost(`t2_${prof.data.id}`);
  }
}

function updateBlockButtons(author) {
  const key = author.toLowerCase(), err = authorErrors.get(key);
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((w) => {
    if ((w.dataset.author || '').toLowerCase() !== key) return;
    const btn = w.querySelector('[data-role="block"]');
    if (btn) {
      if (blockedAuthors.has(key)) { applyTheme(btn, BLOCKED_THEME); btn.textContent = '✓ Blocked'; btn.disabled = true; }
      else if (pendingBlocks.has(key)) { applyTheme(btn, BLOCK_THEME); btn.textContent = '⋯ Blocking'; btn.disabled = true; }
      else if (err) { applyTheme(btn, EMPTY_THEME); btn.textContent = '✕ Retry block'; btn.title = err.message || ''; btn.disabled = false; }
      else { applyTheme(btn, BLOCK_THEME); btn.textContent = '⊘ Block'; btn.disabled = false; }
    }
    const post = w.closest(POST_SELECTOR);
    if (post && blockedAuthors.has(key)) { if (!dimmedPosts.has(post)) dimmedPosts.set(post, post.style.opacity); post.style.opacity = '0.35'; }
  });
}

function createBlockBtn(author, initialId) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.dataset.role = 'block'; btn.style.cssText = BASE_BTN_STYLE;
  bindHoverStop(btn); applyTheme(btn, BLOCK_THEME); btn.textContent = '⊘ Block';
  btn.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const wrap = btn.closest(`.${WRAP_CLASS}`), curAuthor = wrap?.dataset?.author || author, curId = wrap?.dataset?.authorId || initialId, key = curAuthor.toLowerCase();
    if (btn.disabled || pendingBlocks.has(key) || blockedAuthors.has(key)) return;
    authorErrors.delete(key); pendingBlocks.add(key); updateBlockButtons(curAuthor);
    try {
      const run = async () => {
        const wait = Math.max(nextBlockAt, readQuotaState().rateLimitedUntil) - Date.now();
        if (wait > 0 && readQuotaState().rateLimitedUntil <= Date.now()) await new Promise((r) => setTimeout(r, wait));
        try { return await blockAccountRequest(curAuthor, curId); } finally { nextBlockAt = Date.now() + BLOCK_COOLDOWN_MS; }
      };
      const p = blockChain.then(run, run); blockChain = p.catch(() => {}); await p;
      blockedAuthors.add(key); writeJson(BLOCKED_KEY, [...blockedAuthors]);
    } catch (err) { authorErrors.set(key, err); }
    finally { pendingBlocks.delete(key); updateBlockButtons(curAuthor); processQueue(); }
  });
  return btn;
}

function applyCacheToWrap(wrap, author) {
  const key = author.toLowerCase(), now = Date.now(), c = authorCache.get(key);
  if (c && c.expiresAt > now) {
    renderListingBtn(wrap.querySelector('[data-role="posts"]'), c.hasHot, 'Posts', 'No posts');
    renderListingBtn(wrap.querySelector('[data-role="top"]'), c.hasTop, 'Top posts', 'No top');
    return true;
  }
  if ((partialTopEmpty.get(key) || 0) > now) renderListingBtn(wrap.querySelector('[data-role="top"]'), false, 'Top posts', 'No top');
  if ((partialHotOk.get(key) || 0) > now) renderListingBtn(wrap.querySelector('[data-role="posts"]'), true, 'Posts', 'No posts');
  return false;
}

function clearTimers(wrap) {
  if (dwellTimers.has(wrap)) { clearTimeout(dwellTimers.get(wrap)); dwellTimers.delete(wrap); }
  if (hoverTimers.has(wrap)) { clearTimeout(hoverTimers.get(wrap)); hoverTimers.delete(wrap); }
}

const visibilityObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    const wrap = entry.target.classList?.contains(WRAP_CLASS) ? entry.target : postToWrap.get(entry.target);
    if (!wrap) return;
    wrap.dataset.nearby = String(entry.isIntersecting);
    if (!entry.isIntersecting) { clearTimers(wrap); return; }
    const author = wrap.dataset.author || '';
    if (!author || SKIP_AUTHORS.has(author.toLowerCase()) || blockedAuthors.has(author.toLowerCase()) || applyCacheToWrap(wrap, author)) return;
    if (!dwellTimers.has(wrap)) {
      dwellTimers.set(wrap, setTimeout(() => { dwellTimers.delete(wrap); if (wrap.isConnected && wrap.dataset.nearby === 'true') checkAuthorCascade(author, false); }, DWELL_MS));
    }
  });
  processQueue();
}, { rootMargin: '0px', threshold: 0.15 });

function normalizeAuthor(raw) { return (raw || '').trim().replace(/^(?:\/?(?:u|user)\/)/i, ''); }
function isNestedCrosspost(post) { return Boolean(post.parentElement?.closest(POST_SELECTOR)); }
function isProfilePage() { return /^\/(?:user|u)\/[^/]+/i.test(location.pathname); }

function seedProfileOwnerFromDom() {
  const m = location.pathname.match(/^\/(?:user|u)\/([^/?#]+)(?:\/(submitted))?\/?$/i);
  if (!m?.[2]) return;
  const owner = decodeURIComponent(m[1]).toLowerCase(), params = new URLSearchParams(location.search);
  const sort = (params.get('sort') || 'hot').toLowerCase(), t = (params.get('t') || '').toLowerCase();
  const hasOwn = [...document.querySelectorAll(POST_SELECTOR)].some((p) => !isNestedCrosspost(p) && normalizeAuthor(p.getAttribute('author') || p.getAttribute('data-author')).toLowerCase() === owner);
  if (!hasOwn) return;
  if (sort === 'top' && (t === 'all' || !t)) saveSettled(owner, true, true);
  else if (sort === 'hot') {
    const prev = authorCache.get(owner);
    if (prev && typeof prev.hasTop === 'boolean') saveSettled(owner, true, prev.hasTop);
    else { partialHotOk.set(owner, Date.now() + 1_800_000); syncAuthorButtons(owner, { hasHot: true }); }
  }
}

function processPost(post) {
  if (!post.isConnected) return;
  const modern = post.matches('shreddit-post');
  const bar = !modern ? post.querySelector('p.tagline') : [...post.querySelectorAll('[slot="credit-bar"], [data-testid="post-author-header"], [slot="authorName"]')].find((el) => el.closest(POST_SELECTOR) === post);
  let author = normalizeAuthor(post.getAttribute(modern ? 'author' : 'data-author'));
  if (!author && bar) {
    const link = [...bar.querySelectorAll('a[href*="/user/"], a[href*="/u/"]')].find((a) => !a.closest(`.${WRAP_CLASS}`) && a.closest(POST_SELECTOR) === post);
    const m = link?.getAttribute('href')?.match(/\/(?:user|u)\/([^/?#]+)/i);
    if (m?.[1]) author = normalizeAuthor(decodeURIComponent(m[1]));
  }
  const directId = post.getAttribute(modern ? 'author-id' : 'data-author-fullname') || '';
  const authorId = /^t2_[a-z0-9]+$/i.test(directId) ? directId : '';
  const existing = [...post.querySelectorAll(`.${WRAP_CLASS}`)].find((w) => w.closest(POST_SELECTOR) === post);
  if (existing) {
    if (existing.dataset.author === author) {
      if (authorId && existing.dataset.authorId !== authorId) existing.dataset.authorId = authorId;
      postToWrap.set(post, existing); applyCacheToWrap(existing, author); return;
    }
    clearTimers(existing); visibilityObserver.unobserve(post); existing.remove();
  }
  if (!author || SKIP_AUTHORS.has(author.toLowerCase()) || !bar) return;

  const enc = encodeURIComponent(author), wrap = document.createElement('span');
  wrap.className = WRAP_CLASS; wrap.dataset.author = author; wrap.dataset.authorId = authorId;
  wrap.style.cssText = 'position:relative;z-index:10;pointer-events:auto;display:inline-flex;align-items:center;flex-wrap:nowrap;gap:5px;margin-left:auto;margin-right:6px;flex-shrink:0;';
  const postsBtn = createLinkBtn('Posts', `/user/${enc}/submitted/?sort=hot`); postsBtn.dataset.role = 'posts';
  const topBtn = createLinkBtn('Top posts', `/user/${enc}/submitted/?sort=top&t=all`); topBtn.dataset.role = 'top';
  const blockBtn = createBlockBtn(author, authorId);
  wrap.append(postsBtn, topBtn, blockBtn);
  applyCacheToWrap(wrap, author); postToWrap.set(post, wrap);
  if (!isProfilePage() && !isNestedCrosspost(post)) { wrap.dataset.autoObserve = 'true'; visibilityObserver.observe(post); }

  const cancelHover = () => { if (hoverTimers.has(wrap)) { clearTimeout(hoverTimers.get(wrap)); hoverTimers.delete(wrap); } };
  const scheduleHover = () => {
    cancelHover(); if (applyCacheToWrap(wrap, author)) return;
    hoverTimers.set(wrap, setTimeout(() => { hoverTimers.delete(wrap); wrap.dataset.nearby = 'true'; checkAuthorCascade(author, true); }, HOVER_MS));
  };
  [postsBtn, topBtn].forEach((b) => { b.addEventListener('pointerenter', scheduleHover); b.addEventListener('focus', scheduleHover); b.addEventListener('pointerleave', cancelHover); b.addEventListener('blur', cancelHover); });

  if (modern) {
    post.style.isolation = 'isolate'; Object.assign(bar.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', rowGap: '4px', paddingTop: '6px' });
    if (bar.firstElementChild) { bar.firstElementChild.after(wrap); if (wrap.nextElementSibling) wrap.nextElementSibling.style.marginLeft = '0'; } else bar.appendChild(wrap);
  } else bar.appendChild(wrap);
  if (blockedAuthors.has(author.toLowerCase())) updateBlockButtons(author);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    hydrateAuthorCache();
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((w) => {
      const post = w.closest(POST_SELECTOR);
      if (post && w.dataset.autoObserve === 'true') { visibilityObserver.unobserve(post); visibilityObserver.observe(post); }
    });
    processQueue();
  } else { persistAuthorCacheNow(); document.querySelectorAll(`.${WRAP_CLASS}`).forEach(clearTimers); }
});

window.addEventListener('pagehide', persistAuthorCacheNow);
window.addEventListener('storage', (e) => {
  if (!e?.key || !e.newValue) return;
  if (e.key === STATUS_KEY) { hydrateAuthorCache(); document.querySelectorAll(`.${WRAP_CLASS}`).forEach((w) => applyCacheToWrap(w, w.dataset.author || '')); }
  else if (e.key === BLOCKED_KEY) { const list = readJson(BLOCKED_KEY); if (Array.isArray(list)) list.forEach((a) => { blockedAuthors.add(String(a).toLowerCase()); updateBlockButtons(String(a)); }); }
  else if (e.key === QUOTA_KEY) processQueue();
});

let rafPending = false;
const dirtyPosts = new Set();
function queueNodePosts(node) {
  if (node?.nodeType !== 1) return;
  if (node.matches(POST_SELECTOR)) dirtyPosts.add(node);
  if (node.closest(POST_SELECTOR)) dirtyPosts.add(node.closest(POST_SELECTOR));
  node.querySelectorAll(POST_SELECTOR).forEach((el) => dirtyPosts.add(el));
}

document.querySelectorAll(POST_SELECTOR).forEach(processPost);
seedProfileOwnerFromDom();
if (document.body) {
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target.nodeType === 1 && m.target.closest(`.${WRAP_CLASS}`)) continue;
      if (m.type === 'attributes') queueNodePosts(m.target);
      else { if (m.target.nodeType === 1 && m.target.closest(POST_SELECTOR)) dirtyPosts.add(m.target.closest(POST_SELECTOR)); m.addedNodes.forEach(queueNodePosts); }
    }
    if (rafPending || !dirtyPosts.size) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; const list = [...dirtyPosts]; dirtyPosts.clear(); list.forEach(processPost); seedProfileOwnerFromDom(); });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['author', 'author-id', 'data-author', 'data-author-fullname'] });
}
