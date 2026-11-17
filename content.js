const WRAP_CLASS = 'author-btns-wrap';
const POST_SELECTOR = 'shreddit-post, .thing.link';
const BLOCKED_STORAGE_KEY = 'ivory_reddit_blocked_v1';
const STATUS_STORAGE_KEY = 'ivory_reddit_author_status_v4';
const RATELIMIT_STORAGE_KEY = 'ivory_reddit_ratelimit_v4';
const LEGACY_STORAGE_KEYS = [
  'ivory_reddit_author_status_v1',
  'ivory_reddit_author_status_v2',
  'ivory_reddit_author_status_v3',
  'ivory_reddit_ratelimit_v1',
  'ivory_reddit_ratelimit_v2',
  'ivory_reddit_ratelimit_v3',
  'ivory_reddit_last_req_v1',
];

const BASE_BTN_STYLE =
  'position:relative;z-index:10;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;min-height:26px;max-height:26px;min-width:0;appearance:none;vertical-align:middle;gap:5px;margin:0;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;line-height:16px;text-decoration:none;white-space:nowrap;cursor:pointer;user-select:none;font-family:inherit;flex-shrink:0;transition:background 0.15s,border-color 0.15s,color 0.15s,opacity 0.15s;';
const NORMAL_THEME = { bg: '#272729', bgHover: '#343536', color: '#d7dadc', border: '#343536' };
const EMPTY_THEME = { bg: '#3b1d20', bgHover: '#4f262a', color: '#f5b7b1', border: '#6e2c33' };
const BLOCK_THEME = { bg: '#33241b', bgHover: '#473022', color: '#f5cba7', border: '#5c3d2e' };
const BLOCKED_THEME = { bg: '#1b2e22', bgHover: '#1b2e22', color: '#82e0aa', border: '#2e523b' };
const BADGE_STYLE =
  'display:inline-block;padding:1px 5px;background:#6e2c33;color:#ffd7d5;border-radius:999px;font-size:10px;font-weight:700;line-height:13px;';

const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 2400;
const VIEWPORT_DWELL_MS = 900;
const HOVER_DEBOUNCE_MS = 180;
const PREFETCH_MARGIN_PX = 200;
const STATUS_TTL_MS = 2 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;
const BLOCK_COOLDOWN_MS = 1500;
const ERROR_LOCK_MS = 2000;
const RATELIMIT_RESERVE = 20;
const WINDOW_SHORT_MS = 60 * 1000;
const MAX_PER_MIN = 7;
const WINDOW_LONG_MS = 10 * 60 * 1000;
const MAX_PER_10MIN = 28;

const authorCache = new Map();
const inFlightChecks = new Map();
const retryAfterMap = new Map();
const blockedAuthors = new Set();
const pendingBlocks = new Set();
const authorErrors = new Map();
const dwellTimers = new WeakMap();
const hoverTimers = new WeakMap();
const postToWrapMap = new WeakMap();
const dimmedPosts = new WeakMap();
const fetchQueue = [];

let activeRequests = 0;
let nextRequestAt = 0;
let rateLimitedUntil = 0;
let quotaPausedUntil = 0;
let recentTimestamps = [];
let nextBlockAllowedAt = 0;
let queueTimer = null;
let cachedModhash = '';
let modhashPromise = null;
let blockChain = Promise.resolve();
let seqCounter = 0;

initStorage();

function readStorage(key) {
  try {
    const val = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (val) return val;
  } catch {}
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, val) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
  } catch {}
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, val);
  } catch {}
}

function saveBlockedAuthors() {
  writeStorage(BLOCKED_STORAGE_KEY, JSON.stringify([...blockedAuthors]));
}

function initStorage() {
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
    } catch {}
  }
  try {
    const rawBlocked = readStorage(BLOCKED_STORAGE_KEY);
    if (rawBlocked) {
      JSON.parse(rawBlocked).forEach((a) => blockedAuthors.add(String(a).toLowerCase()));
    }
  } catch {}
  hydrateRateLimit();
  hydrateAuthorCache();
}

function pruneTimestamps(list, now = Date.now()) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t > now - WINDOW_LONG_MS)
    .sort((a, b) => a - b)
    .slice(-MAX_PER_10MIN);
}

function hydrateRateLimit() {
  try {
    const raw = readStorage(RATELIMIT_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const now = Date.now();
    if (typeof data.rateLimitedUntil === 'number' && data.rateLimitedUntil > now) {
      rateLimitedUntil = Math.max(rateLimitedUntil, data.rateLimitedUntil);
    }
    if (typeof data.nextRequestAt === 'number' && data.nextRequestAt > now) {
      nextRequestAt = Math.max(nextRequestAt, data.nextRequestAt);
    }
    if (Array.isArray(data.recentTimestamps)) {
      const merged = [...new Set([...recentTimestamps, ...data.recentTimestamps])];
      recentTimestamps = pruneTimestamps(merged, now);
    }
  } catch {}
}

function persistRateLimit() {
  const now = Date.now();
  recentTimestamps = pruneTimestamps(recentTimestamps, now);
  writeStorage(
    RATELIMIT_STORAGE_KEY,
    JSON.stringify({ rateLimitedUntil, nextRequestAt, recentTimestamps })
  );
}

function hydrateAuthorCache() {
  try {
    const raw = readStorage(STATUS_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (v && v.expiresAt > now && typeof v.hasHot === 'boolean' && typeof v.hasTop === 'boolean') {
        authorCache.set(k.toLowerCase(), {
          hasHot: v.hasHot,
          hasTop: v.hasTop,
          expiresAt: v.expiresAt,
        });
      }
    }
  } catch {}
}

function persistAuthorCache() {
  const now = Date.now();
  const out = {};
  for (const [k, v] of authorCache.entries()) {
    if (v.expiresAt <= now) {
      authorCache.delete(k);
    } else if (typeof v.hasHot === 'boolean' && typeof v.hasTop === 'boolean') {
      if (authorCache.size > MAX_CACHE_SIZE) {
        authorCache.delete(k);
        continue;
      }
      out[k] = { hasHot: v.hasHot, hasTop: v.hasTop, expiresAt: v.expiresAt };
    }
  }
  writeStorage(STATUS_STORAGE_KEY, JSON.stringify(out));
}

class RequestError extends Error {
  constructor(message, { status = 0, retryable = false, uncertain = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

function parseHeaderNumber(raw, mode = 'min') {
  if (raw === null || raw === undefined) return NaN;
  const nums = String(raw)
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return NaN;
  return mode === 'max' ? Math.max(...nums) : Math.min(...nums);
}

function getBudgetBlockedUntil(now = Date.now()) {
  recentTimestamps = pruneTimestamps(recentTimestamps, now);
  let blockedUntil = Math.max(nextRequestAt, rateLimitedUntil, quotaPausedUntil);
  const shortCut = now - WINDOW_SHORT_MS;
  const inShort = recentTimestamps.filter((t) => t > shortCut);
  if (inShort.length >= MAX_PER_MIN) {
    blockedUntil = Math.max(
      blockedUntil,
      inShort[inShort.length - MAX_PER_MIN] + WINDOW_SHORT_MS + 50
    );
  }
  if (recentTimestamps.length >= MAX_PER_10MIN) {
    blockedUntil = Math.max(
      blockedUntil,
      recentTimestamps[recentTimestamps.length - MAX_PER_10MIN] + WINDOW_LONG_MS + 50
    );
  }
  return blockedUntil;
}

function respectRateLimit(res, bodyText = '') {
  const now = Date.now();
  if (res.status === 429) {
    const headerSec = parseHeaderNumber(res.headers.get('Retry-After'), 'max');
    const secMatch = bodyText.match(/(\d+(?:\.\d+)?)\s*seconds?/i);
    const minMatch = bodyText.match(/(\d+(?:\.\d+)?)\s*minutes?/i);
    const bodyMs = secMatch
      ? Number(secMatch[1]) * 1000
      : minMatch
        ? Number(minMatch[1]) * 60000
        : 0;
    const waitMs =
      Number.isFinite(headerSec) && headerSec > 0
        ? headerSec * 1000
        : bodyMs > 0
          ? bodyMs
          : RATE_LIMIT_FALLBACK_MS;
    rateLimitedUntil = Math.max(rateLimitedUntil, now + waitMs);
  }
  const rem = parseHeaderNumber(res.headers.get('X-Ratelimit-Remaining'), 'min');
  const reset = parseHeaderNumber(res.headers.get('X-Ratelimit-Reset'), 'max');
  if (Number.isFinite(rem) && rem <= RATELIMIT_RESERVE) {
    const pauseMs = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 60) * 1000 : 30000;
    quotaPausedUntil = Math.max(quotaPausedUntil, now + pauseMs);
  }
  persistRateLimit();
}

function isAllowedListingRedirect(origUrl, finalUrl) {
  try {
    const o = new URL(origUrl, location.origin);
    const d = new URL(finalUrl, location.origin);
    return (
      o.origin === d.origin &&
      /^\/(?:user|u)\/[^/]+\/submitted\.json$/i.test(o.pathname) &&
      /^\/(?:user|u)\/[^/]+\/submitted\.json$/i.test(d.pathname)
    );
  } catch {
    return false;
  }
}

async function fetchJsonDirect(url, options = {}) {
  hydrateRateLimit();
  if (rateLimitedUntil > Date.now()) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    throw new RequestError(`Reddit rate limit active (${waitSec}s).`, {
      status: 429,
      retryable: true,
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...options.headers },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    respectRateLimit(res, res.status === 429 ? text : '');
    if (!res.ok) {
      throw new RequestError(`Reddit HTTP ${res.status}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        uncertain: res.status >= 500,
      });
    }
    if (res.redirected && !isAllowedListingRedirect(url, res.url)) {
      throw new RequestError('Unexpected redirect.', { retryable: true, uncertain: true });
    }
    if (options.method === 'POST' && (res.status === 204 || !text.trim())) return {};
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new RequestError('Unreadable response from Reddit.', { retryable: true, uncertain: true });
    }
    const errors = data?.json?.errors ?? data?.errors;
    if (Array.isArray(errors) && errors.length) {
      const limited = errors.some((e) => Array.isArray(e) && e[0] === 'RATELIMIT');
      if (limited) {
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + RATE_LIMIT_FALLBACK_MS);
        persistRateLimit();
      }
      throw new RequestError(
        errors.map((e) => (Array.isArray(e) ? e.slice(0, 2).join(': ') : String(e))).join('; '),
        { status: limited ? 429 : 0, retryable: limited }
      );
    }
    if (data?.error || data?.success === false) {
      throw new RequestError(String(data.message || data.error || 'Request rejected.'));
    }
    return data;
  } catch (err) {
    if (err instanceof RequestError) throw err;
    throw new RequestError(
      controller.signal.aborted ? 'Request timed out.' : 'Network error.',
      { retryable: true, uncertain: true }
    );
  } finally {
    clearTimeout(timeout);
  }
}

function enqueueListingRequest(task, authorKey, priority = false) {
  return new Promise((resolve, reject) => {
    fetchQueue.push({
      task,
      resolve,
      reject,
      authorKey,
      priority: Boolean(priority),
      seq: ++seqCounter,
    });
    processQueue();
  });
}

function isAuthorVisibleInDom(authorKey) {
  const wraps = document.querySelectorAll(`.${WRAP_CLASS}`);
  for (const w of wraps) {
    if ((w.dataset.author || '').toLowerCase() === authorKey && w.dataset.nearby === 'true') {
      return true;
    }
  }
  return false;
}

function processQueue() {
  if (queueTimer !== null) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  if (document.visibilityState === 'hidden' || pendingBlocks.size > 0) return;
  if (activeRequests >= 1 || fetchQueue.length === 0) return;

  for (let i = fetchQueue.length - 1; i >= 0; i--) {
    const item = fetchQueue[i];
    if (blockedAuthors.has(item.authorKey) || (!item.priority && !isAuthorVisibleInDom(item.authorKey))) {
      fetchQueue.splice(i, 1);
      item.resolve(null);
    }
  }
  if (fetchQueue.length === 0) return;

  hydrateRateLimit();
  const now = Date.now();
  const blockedUntil = getBudgetBlockedUntil(now);
  if (blockedUntil > now) {
    queueTimer = setTimeout(processQueue, Math.min(blockedUntil - now + 25, 60000));
    return;
  }

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < fetchQueue.length; i++) {
    const score = (fetchQueue[i].priority ? 1e9 : 0) + fetchQueue[i].seq;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const [entry] = fetchQueue.splice(bestIdx, 1);
  activeRequests++;
  const startedAt = Date.now();
  recentTimestamps.push(startedAt);
  nextRequestAt = startedAt + REQUEST_INTERVAL_MS;
  persistRateLimit();

  Promise.resolve()
    .then(entry.task)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      activeRequests--;
      processQueue();
    });
}

function isVisibleSubmissionItem(child) {
  const d = child?.data;
  if (!d || typeof d !== 'object') return false;
  if (child.kind && child.kind !== 't3') return false;
  if (d.removed_by_category || d.removed === true || d.spam === true || d.hidden === true) return false;
  if (d.author === '[deleted]') return false;
  return true;
}

async function fetchListingBool(url, authorKey, priority) {
  const data = await enqueueListingRequest(() => fetchJsonDirect(url), authorKey, priority);
  if (data === null) return null;
  const children = data?.data?.children;
  if (data?.kind !== 'Listing' || !Array.isArray(children)) {
    throw new RequestError('Invalid listing response', { retryable: true });
  }
  return children.some(isVisibleSubmissionItem);
}

function applyTheme(btn, theme) {
  btn.dataset.bg = theme.bg;
  btn.dataset.bgHover = theme.bgHover;
  btn.style.background = theme.bg;
  btn.style.color = theme.color;
  btn.style.border = `1px solid ${theme.border}`;
}

function bindHoverAndStopPropagation(btn) {
  btn.addEventListener('mouseenter', () => {
    if (!btn.disabled) btn.style.background = btn.dataset.bgHover;
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = btn.dataset.bg;
  });
  ['pointerdown', 'mousedown', 'mouseup'].forEach((evt) => {
    btn.addEventListener(evt, (e) => e.stopPropagation());
  });
}

function setEmptyState(btn, emptyText) {
  btn.dataset.postsState = 'empty';
  applyTheme(btn, EMPTY_THEME);
  btn.textContent = '';
  const badge = document.createElement('span');
  badge.style.cssText = BADGE_STYLE;
  badge.textContent = '✕';
  const label = document.createElement('span');
  label.textContent = emptyText;
  btn.appendChild(badge);
  btn.appendChild(label);
}

function renderListingState(btn, hasPosts, label, emptyLabel, error = '') {
  if (!btn) return;
  btn.dataset.postsState = hasPosts === null ? 'unknown' : hasPosts ? 'present' : 'empty';
  btn.title = hasPosts === null && error ? `Could not check posts: ${error}` : '';
  if (hasPosts === false) {
    setEmptyState(btn, emptyLabel);
  } else {
    applyTheme(btn, NORMAL_THEME);
    btn.textContent = label;
  }
}

function syncAuthorButtons(author, status) {
  if (!author || !status) return;
  const key = author.toLowerCase();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
    if ((wrap.dataset.author || '').toLowerCase() !== key) return;
    const postsBtn = wrap.querySelector('[data-role="posts"]');
    const topBtn = wrap.querySelector('[data-role="top"]');
    if ('hasHot' in status && status.hasHot !== undefined) {
      renderListingState(postsBtn, status.hasHot, 'Posts', 'No posts', status.error || '');
    }
    if ('hasTop' in status && status.hasTop !== undefined) {
      renderListingState(topBtn, status.hasTop, 'Top posts', 'No top', status.error || '');
    }
  });
}

function checkAuthorCascade(author, priority = false) {
  const key = author.toLowerCase();
  const now = Date.now();
  const cached = authorCache.get(key);
  if (cached && cached.expiresAt > now && typeof cached.hasHot === 'boolean') {
    syncAuthorButtons(author, cached);
    return Promise.resolve(cached);
  }
  if (!priority && (retryAfterMap.get(key) || 0) > now) {
    return Promise.resolve(null);
  }
  if (inFlightChecks.has(key)) {
    if (priority) {
      for (const item of fetchQueue) {
        if (item.authorKey === key) {
          item.priority = true;
          item.seq = ++seqCounter;
        }
      }
      processQueue();
    }
    return inFlightChecks.get(key);
  }

  const encoded = encodeURIComponent(author);
  const topUrl = `${location.origin}/user/${encoded}/submitted.json?limit=5&sort=top&t=all&raw_json=1`;
  const hotUrl = `${location.origin}/user/${encoded}/submitted.json?limit=5&sort=hot&raw_json=1`;

  const promise = (async () => {
    try {
      const hasTop = await fetchListingBool(topUrl, key, priority);
      if (hasTop === null) return null;
      if (hasTop === true) {
        const record = { hasHot: true, hasTop: true, expiresAt: Date.now() + STATUS_TTL_MS };
        authorCache.set(key, record);
        retryAfterMap.delete(key);
        syncAuthorButtons(author, record);
        persistAuthorCache();
        return record;
      }
      syncAuthorButtons(author, { hasTop: false });
      const hasHot = await fetchListingBool(hotUrl, key, priority);
      if (hasHot === null) return null;
      const record = {
        hasHot: Boolean(hasHot),
        hasTop: false,
        expiresAt: Date.now() + STATUS_TTL_MS,
      };
      authorCache.set(key, record);
      retryAfterMap.delete(key);
      syncAuthorButtons(author, record);
      persistAuthorCache();
      return record;
    } catch (err) {
      if (err instanceof RequestError && (err.status === 404 || err.status === 403)) {
        const record = { hasHot: false, hasTop: false, expiresAt: Date.now() + STATUS_TTL_MS };
        authorCache.set(key, record);
        retryAfterMap.delete(key);
        syncAuthorButtons(author, record);
        persistAuthorCache();
        return record;
      }
      retryAfterMap.set(key, Math.max(Date.now() + FAILURE_TTL_MS, rateLimitedUntil));
      syncAuthorButtons(author, { hasHot: null, hasTop: null, error: err?.message || 'Error' });
      return null;
    } finally {
      inFlightChecks.delete(key);
    }
  })();

  inFlightChecks.set(key, promise);
  return promise;
}

function createLinkBtn(text, url) {
  const fullUrl = new URL(url, location.origin).href;
  const btn = document.createElement('a');
  btn.href = fullUrl;
  btn.target = '_blank';
  btn.rel = 'noopener noreferrer';
  btn.textContent = text;
  btn.style.cssText = BASE_BTN_STYLE;
  applyTheme(btn, NORMAL_THEME);
  bindHoverAndStopPropagation(btn);
  btn.dataset.postsState = 'unknown';

  const activate = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (btn.dataset.postsState === 'empty') {
      e.preventDefault();
      return;
    }
    const useCurrentTab =
      e.button === 0 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      /^\/(?:user|u)\/[^/]+(?:\/|$)/i.test(location.pathname);
    if (useCurrentTab) {
      e.preventDefault();
      location.assign(fullUrl);
    } else if (e.defaultPrevented) {
      window.open(fullUrl, '_blank', 'noopener,noreferrer');
    }
  };
  btn.addEventListener('click', activate);
  btn.addEventListener('auxclick', (e) => {
    if (e.button === 1) activate(e);
  });
  return btn;
}

function getCsrfCookie() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function getDomToken() {
  const domUh = document.querySelector('input[name="uh"]')?.value;
  if (domUh) return domUh;
  const app = document.querySelector('shreddit-app');
  return app?.csrfToken || app?.getAttribute('csrf-token') || app?.getAttribute('spp') || '';
}

async function getModhash() {
  const domUh = document.querySelector('input[name="uh"]')?.value;
  if (domUh) return domUh;
  if (cachedModhash) return cachedModhash;
  if (!modhashPromise) {
    modhashPromise = fetchJsonDirect(`${location.origin}/api/me.json`)
      .then((d) => {
        const uh = d?.data?.modhash || '';
        if (uh) cachedModhash = uh;
        return uh;
      })
      .catch(() => '')
      .finally(() => {
        modhashPromise = null;
      });
  }
  return modhashPromise;
}

async function resolveAccountId(author, initialId) {
  if (/^t2_[a-z0-9]+$/i.test(initialId || '')) return initialId;
  try {
    const profile = await fetchJsonDirect(
      `${location.origin}/user/${encodeURIComponent(author)}/about.json?raw_json=1`
    );
    const id = profile?.data?.id;
    return typeof id === 'string' && /^[a-z0-9]+$/i.test(id) ? `t2_${id}` : '';
  } catch {
    return '';
  }
}

async function sendBlockPost(author, accountId, uh, csrfToken) {
  const params = new URLSearchParams();
  params.set('name', author);
  params.set('api_type', 'json');
  if (uh) params.set('uh', uh);
  if (accountId) params.set('account_id', accountId);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (uh) headers['X-Modhash'] = uh;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  await fetchJsonDirect(`${location.origin}/api/block_user`, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
}

async function blockAccountRequest(author, authorId) {
  const csrfToken = getCsrfCookie() || getDomToken();
  const validInitialId = /^t2_[a-z0-9]+$/i.test(authorId || '') ? authorId : '';
  const uh = await getModhash();
  if (!uh && !csrfToken) {
    throw new RequestError('No session token (check that you are signed in).');
  }
  try {
    await sendBlockPost(author, validInitialId, uh, csrfToken);
  } catch (firstErr) {
    if (firstErr.status === 429) throw firstErr;
    if (!validInitialId) {
      const resolvedId = await resolveAccountId(author, '');
      if (resolvedId) {
        await sendBlockPost(author, resolvedId, uh, csrfToken);
        return;
      }
    }
    throw firstErr;
  }
}

function enqueueBlockTask(fn) {
  const run = async () => {
    const waitMs = Math.max(nextBlockAllowedAt, rateLimitedUntil) - Date.now();
    if (waitMs > 0 && rateLimitedUntil <= Date.now()) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      return await fn();
    } finally {
      nextBlockAllowedAt = Date.now() + BLOCK_COOLDOWN_MS;
    }
  };
  const taskPromise = blockChain.then(run, run);
  blockChain = taskPromise.catch(() => {});
  return taskPromise;
}

function setBlockBtnContent(btn, iconText, labelText) {
  btn.textContent = '';
  const icon = document.createElement('span');
  icon.textContent = iconText;
  icon.style.cssText = 'font-size:12px;line-height:1;';
  const label = document.createElement('span');
  label.textContent = labelText;
  btn.appendChild(icon);
  btn.appendChild(label);
}

function renderBlockButton(btn, author, error = null) {
  const key = author.toLowerCase();
  const activeError = error || authorErrors.get(key) || null;
  btn.title = '';
  btn.removeAttribute('aria-label');

  if (blockedAuthors.has(key)) {
    applyTheme(btn, BLOCKED_THEME);
    btn.textContent = '✓ Blocked';
    btn.style.cursor = 'default';
    btn.disabled = true;
  } else if (pendingBlocks.has(key)) {
    applyTheme(btn, BLOCK_THEME);
    setBlockBtnContent(btn, '⋯', 'Blocking');
    btn.title = 'Waiting for Reddit to confirm the block.';
    btn.style.cursor = 'wait';
    btn.disabled = true;
  } else if (activeError) {
    const isLocked = btn.dataset.errorLocked === 'true';
    applyTheme(btn, EMPTY_THEME);
    setBlockBtnContent(btn, '✕', isLocked ? 'Wait...' : 'Retry block');
    btn.title = activeError.message;
    btn.setAttribute('aria-label', btn.title);
    btn.disabled = isLocked;
    btn.style.cursor = isLocked ? 'not-allowed' : 'pointer';
  } else {
    btn.disabled = false;
    btn.style.cursor = 'pointer';
    applyTheme(btn, BLOCK_THEME);
    setBlockBtnContent(btn, '⊘', 'Block');
  }
}

function updateBlockButtons(author, error = null) {
  const key = author.toLowerCase();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
    if ((wrap.dataset.author || '').toLowerCase() !== key) return;
    const blockBtn = wrap.querySelector('[data-role="block"]');
    if (blockBtn) renderBlockButton(blockBtn, author, error);
    const post = wrap.closest(POST_SELECTOR);
    if (post && blockedAuthors.has(key)) dimPost(post);
  });
}

function lockAuthorButtonsTemporarily(author, ms) {
  const key = author.toLowerCase();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
    if ((wrap.dataset.author || '').toLowerCase() !== key) return;
    const blockBtn = wrap.querySelector('[data-role="block"]');
    if (blockBtn) blockBtn.dataset.errorLocked = 'true';
  });
  updateBlockButtons(author);
  setTimeout(() => {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
      if ((wrap.dataset.author || '').toLowerCase() !== key) return;
      const blockBtn = wrap.querySelector('[data-role="block"]');
      if (blockBtn) delete blockBtn.dataset.errorLocked;
    });
    updateBlockButtons(author);
  }, ms);
}

function createBlockBtn(author, initialAuthorId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.role = 'block';
  btn.setAttribute('aria-live', 'polite');
  btn.style.cssText = BASE_BTN_STYLE;
  bindHoverAndStopPropagation(btn);
  renderBlockButton(btn, author);

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const wrap = btn.closest(`.${WRAP_CLASS}`);
    const currentAuthor = wrap?.dataset?.author || author;
    const currentAuthorId = wrap?.dataset?.authorId || initialAuthorId;
    const key = currentAuthor.toLowerCase();
    if (btn.disabled || pendingBlocks.has(key) || blockedAuthors.has(key)) return;

    authorErrors.delete(key);
    pendingBlocks.add(key);
    updateBlockButtons(currentAuthor);
    processQueue();

    let failure = null;
    try {
      await enqueueBlockTask(() => blockAccountRequest(currentAuthor, currentAuthorId));
      blockedAuthors.add(key);
      saveBlockedAuthors();
      updateBlockButtons(currentAuthor);
    } catch (err) {
      failure = err;
      authorErrors.set(key, err);
      if (err.status === 401 || err.status === 403) cachedModhash = '';
    } finally {
      pendingBlocks.delete(key);
      if (failure) {
        const lockMs =
          failure.status === 429
            ? Math.min(Math.max(rateLimitedUntil - Date.now(), ERROR_LOCK_MS), 15000)
            : ERROR_LOCK_MS;
        lockAuthorButtonsTemporarily(currentAuthor, lockMs);
      } else {
        updateBlockButtons(currentAuthor, null);
      }
      processQueue();
    }
  });
  return btn;
}

function clearWrapTimers(wrap) {
  const dTimer = dwellTimers.get(wrap);
  if (dTimer !== undefined) {
    clearTimeout(dTimer);
    dwellTimers.delete(wrap);
  }
  const hTimer = hoverTimers.get(wrap);
  if (hTimer !== undefined) {
    clearTimeout(hTimer);
    hoverTimers.delete(wrap);
  }
}

function applyCachedStatusToWrap(wrap, author) {
  const cached = authorCache.get(author.toLowerCase());
  if (!cached || cached.expiresAt <= Date.now()) return false;
  const postsBtn = wrap.querySelector('[data-role="posts"]');
  const topBtn = wrap.querySelector('[data-role="top"]');
  if (typeof cached.hasHot === 'boolean' && typeof cached.hasTop === 'boolean') {
    renderListingState(postsBtn, cached.hasHot, 'Posts', 'No posts', '');
    renderListingState(topBtn, cached.hasTop, 'Top posts', 'No top', '');
    return true;
  }
  return false;
}

function handleVisibilityChange(wrap, isIntersecting) {
  if (!wrap) return;
  wrap.dataset.nearby = String(isIntersecting);
  if (!isIntersecting) {
    clearWrapTimers(wrap);
    return;
  }
  const author = wrap.dataset.author || '';
  if (!author || blockedAuthors.has(author.toLowerCase())) return;
  if (applyCachedStatusToWrap(wrap, author)) return;

  if (!dwellTimers.has(wrap)) {
    const timer = setTimeout(() => {
      dwellTimers.delete(wrap);
      if (wrap.isConnected && wrap.dataset.nearby === 'true') {
        checkAuthorCascade(author, false);
      }
    }, VIEWPORT_DWELL_MS);
    dwellTimers.set(wrap, timer);
  }
}

const visibilityObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const target = entry.target;
      const wrap = target.classList?.contains(WRAP_CLASS)
        ? target
        : postToWrapMap.get(target) || findOwnWrap(target);
      if (wrap) handleVisibilityChange(wrap, entry.isIntersecting);
    });
    processQueue();
  },
  { rootMargin: `${PREFETCH_MARGIN_PX}px` }
);

function normalizeAuthor(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^(?:\/?(?:u|user)\/)/i, '');
}

function extractAuthorId(post, modern) {
  const direct = post.getAttribute(modern ? 'author-id' : 'data-author-fullname') || '';
  if (/^t2_[a-z0-9]+$/i.test(direct)) return direct;
  const candidates = post.querySelectorAll('[data-author-fullname], [author-id]');
  for (const el of candidates) {
    if (el.closest(POST_SELECTOR) !== post) continue;
    const nested = el.getAttribute('author-id') || el.getAttribute('data-author-fullname') || '';
    if (/^t2_[a-z0-9]+$/i.test(nested)) return nested;
  }
  return '';
}

function findCreditBar(post, modern) {
  if (!modern) return post.querySelector('p.tagline');
  const candidates = post.querySelectorAll(
    '[slot="credit-bar"], [data-testid="post-author-header"], [slot="authorName"]'
  );
  for (const el of candidates) {
    if (el.closest(POST_SELECTOR) === post) return el;
  }
  return null;
}

function extractAuthorFromBar(post, bar) {
  const scope = bar || post;
  const links = scope.querySelectorAll('a[href*="/user/"], a[href*="/u/"]');
  for (const link of links) {
    if (link.closest(`.${WRAP_CLASS}`)) continue;
    if (link.closest(POST_SELECTOR) !== post) continue;
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/(?:user|u)\/([^/?#]+)/i);
    if (match && match[1]) {
      const candidate = normalizeAuthor(decodeURIComponent(match[1]));
      if (candidate && candidate !== 'me') return candidate;
    }
  }
  return '';
}

function dimPost(post) {
  if (!dimmedPosts.has(post)) dimmedPosts.set(post, post.style.opacity);
  post.style.opacity = '0.35';
}

function findOwnWrap(post) {
  const wraps = post.querySelectorAll(`.${WRAP_CLASS}`);
  for (const wrap of wraps) {
    if (wrap.closest(POST_SELECTOR) === post) return wrap;
  }
  return null;
}

function createBtnGroup(author, authorId, post = null) {
  const encoded = encodeURIComponent(author);
  const wrap = document.createElement('span');
  wrap.className = WRAP_CLASS;
  wrap.dataset.author = author;
  wrap.dataset.authorId = authorId;
  wrap.style.cssText =
    'position:relative;z-index:10;pointer-events:auto;display:inline-flex;align-items:center;flex-wrap:nowrap;gap:5px;margin-left:auto;margin-right:6px;flex-shrink:0;';

  const postsBtn = createLinkBtn('Posts', `/user/${encoded}/submitted/?sort=hot`);
  postsBtn.dataset.role = 'posts';

  const topBtn = createLinkBtn('Top posts', `/user/${encoded}/submitted/?sort=top&t=all`);
  topBtn.dataset.role = 'top';

  const blockBtn = createBlockBtn(author, authorId);

  wrap.appendChild(postsBtn);
  wrap.appendChild(topBtn);
  wrap.appendChild(blockBtn);

  applyCachedStatusToWrap(wrap, author);
  const observeTarget = post || wrap;
  if (post) postToWrapMap.set(post, wrap);
  visibilityObserver.observe(observeTarget);

  const cancelHover = () => {
    const hTimer = hoverTimers.get(wrap);
    if (hTimer !== undefined) {
      clearTimeout(hTimer);
      hoverTimers.delete(wrap);
    }
  };

  const scheduleHover = () => {
    cancelHover();
    if (applyCachedStatusToWrap(wrap, author)) return;
    const timer = setTimeout(() => {
      hoverTimers.delete(wrap);
      wrap.dataset.nearby = 'true';
      checkAuthorCascade(author, true);
    }, HOVER_DEBOUNCE_MS);
    hoverTimers.set(wrap, timer);
  };

  [postsBtn, topBtn].forEach((btn) => {
    btn.addEventListener('pointerenter', scheduleHover);
    btn.addEventListener('focus', scheduleHover);
    btn.addEventListener('pointerleave', cancelHover);
    btn.addEventListener('blur', cancelHover);
    btn.addEventListener('pointerdown', cancelHover);
    btn.addEventListener('click', cancelHover);
    btn.addEventListener('auxclick', cancelHover);
  });

  return wrap;
}

function processPost(post) {
  if (!post.isConnected) return;
  const modern = post.matches('shreddit-post');
  const bar = findCreditBar(post, modern);
  const author =
    normalizeAuthor(post.getAttribute(modern ? 'author' : 'data-author')) ||
    extractAuthorFromBar(post, bar);
  const authorId = extractAuthorId(post, modern);

  if (dimmedPosts.has(post) && !blockedAuthors.has(author.toLowerCase())) {
    post.style.opacity = dimmedPosts.get(post);
    dimmedPosts.delete(post);
  }

  const existing = findOwnWrap(post);
  if (existing) {
    if (existing.dataset.author === author) {
      if (authorId && existing.dataset.authorId !== authorId) {
        existing.dataset.authorId = authorId;
      }
      postToWrapMap.set(post, existing);
      applyCachedStatusToWrap(existing, author);
      return;
    }
    clearWrapTimers(existing);
    visibilityObserver.unobserve(post);
    visibilityObserver.unobserve(existing);
    postToWrapMap.delete(post);
    existing.remove();
    processQueue();
  }

  if (!author || author === '[deleted]' || !bar) return;

  const wrap = createBtnGroup(author, authorId, post);
  if (modern) {
    post.style.isolation = 'isolate';
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.alignItems = 'center';
    bar.style.rowGap = '4px';
    bar.style.paddingTop = '6px';

    if (bar.firstElementChild) {
      bar.firstElementChild.after(wrap);
      if (wrap.nextElementSibling) wrap.nextElementSibling.style.marginLeft = '0';
    } else {
      bar.appendChild(wrap);
    }
  } else {
    bar.appendChild(wrap);
  }

  if (blockedAuthors.has(author.toLowerCase())) dimPost(post);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    hydrateRateLimit();
    hydrateAuthorCache();
    processQueue();
  } else {
    persistAuthorCache();
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach(clearWrapTimers);
  }
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => persistAuthorCache());
  window.addEventListener('storage', (e) => {
    if (!e || !e.key) return;
    if (e.key === STATUS_STORAGE_KEY && e.newValue) {
      hydrateAuthorCache();
      for (const [k, v] of authorCache.entries()) {
        syncAuthorButtons(k, v);
      }
    } else if (e.key === BLOCKED_STORAGE_KEY && e.newValue) {
      try {
        JSON.parse(e.newValue).forEach((a) => {
          const lower = String(a).toLowerCase();
          blockedAuthors.add(lower);
          updateBlockButtons(lower);
        });
      } catch {}
    } else if (e.key === RATELIMIT_STORAGE_KEY && e.newValue) {
      hydrateRateLimit();
      processQueue();
    }
  });
}

let rafScheduled = false;
const pendingPosts = new Set();

function collectPosts(node) {
  if (node.nodeType !== 1) return;
  if (node.matches(POST_SELECTOR)) pendingPosts.add(node);
  const parentPost = node.closest(POST_SELECTOR);
  if (parentPost) pendingPosts.add(parentPost);
  node.querySelectorAll(POST_SELECTOR).forEach((p) => pendingPosts.add(p));
}

function scheduleProcessPosts(mutations) {
  for (const m of mutations) {
    if (m.target.nodeType === 1 && m.target.closest(`.${WRAP_CLASS}`)) continue;
    if (m.type === 'attributes') {
      collectPosts(m.target);
      continue;
    }
    const parentPost = m.target.nodeType === 1 ? m.target.closest(POST_SELECTOR) : null;
    if (parentPost) pendingPosts.add(parentPost);
    m.addedNodes.forEach(collectPosts);
  }
  if (rafScheduled || pendingPosts.size === 0) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    const posts = [...pendingPosts];
    pendingPosts.clear();
    posts.forEach(processPost);
  });
}

document.querySelectorAll(POST_SELECTOR).forEach(processPost);
if (document.body) {
  new MutationObserver(scheduleProcessPosts).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['author', 'author-id', 'data-author', 'data-author-fullname'],
  });
}
