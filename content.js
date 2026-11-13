const WRAP_CLASS = 'author-btns-wrap';
const POST_SELECTOR = 'shreddit-post, .thing.link';
const BLOCKED_STORAGE_KEY = 'ivory_reddit_blocked_v1';
const STATUS_STORAGE_KEY = 'ivory_reddit_author_status_v1';
const RATELIMIT_STORAGE_KEY = 'ivory_reddit_ratelimit_v1';

const BASE_BTN_STYLE =
  'position:relative;z-index:10;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;min-height:26px;max-height:26px;min-width:0;appearance:none;vertical-align:middle;gap:5px;margin:0;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;line-height:16px;text-decoration:none;white-space:nowrap;cursor:pointer;user-select:none;font-family:inherit;flex-shrink:0;transition:background 0.15s,border-color 0.15s,color 0.15s,opacity 0.15s;';

const NORMAL_THEME = {
  bg: '#272729',
  bgHover: '#343536',
  color: '#d7dadc',
  border: '#343536',
};

const EMPTY_THEME = {
  bg: '#3b1d20',
  bgHover: '#4f262a',
  color: '#f5b7b1',
  border: '#6e2c33',
};

const BLOCK_THEME = {
  bg: '#33241b',
  bgHover: '#473022',
  color: '#f5cba7',
  border: '#5c3d2e',
};

const BLOCKED_THEME = {
  bg: '#1b2e22',
  bgHover: '#1b2e22',
  color: '#82e0aa',
  border: '#2e523b',
};

const BADGE_STYLE =
  'display:inline-block;padding:1px 5px;background:#6e2c33;color:#ffd7d5;border-radius:999px;font-size:10px;font-weight:700;line-height:13px;';

const MAX_CONCURRENT = 1;
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 800;
const VIEWPORT_DWELL_MS = 350;
const STATUS_TTL_MS = 30 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHE_SIZE = 500;
const PREFETCH_MARGIN_PX = 120;
const BLOCK_COOLDOWN_MS = 1500;
const ERROR_LOCK_MS = 2000;
const BG_RATELIMIT_RESERVE = 25;
const MIN_RATELIMIT_RESERVE = 5;
const PERSIST_DEBOUNCE_MS = 500;

const authorCache = new Map();
const blockedAuthors = loadBlockedAuthors();
const pendingBlocks = new Set();
const authorErrors = new Map();
const detachedWraps = new WeakSet();
const dwellTimers = new WeakMap();
const fetchQueue = [];

let activeRequests = 0;
let nextRequestAt = 0;
let rateLimitedUntil = 0;
let bgPausedUntil = 0;
let hoverPausedUntil = 0;
let lastRateLimitRemaining = null;
let nextBlockAllowedAt = 0;
let queueTimer = null;
let persistTimer = null;
let cachedModhash = '';
let modhashPromise = null;
let blockChain = Promise.resolve();

hydrateRateLimitFromStorage();
hydrateAuthorCacheFromSession();

function readStorageItem(key) {
  try {
    const localVal = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (localVal) return localVal;
  } catch {
    // Ignore localStorage access errors.
  }
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorageItem(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage quota or privacy errors.
  }
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value);
  } catch {
    // Ignore sessionStorage quota or privacy errors.
  }
}

function loadBlockedAuthors() {
  try {
    const raw = readStorageItem(BLOCKED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map((a) => String(a).toLowerCase())) : new Set();
  } catch {
    return new Set();
  }
}

function saveBlockedAuthors() {
  writeStorageItem(BLOCKED_STORAGE_KEY, JSON.stringify([...blockedAuthors]));
}

function hydrateRateLimitFromStorage() {
  try {
    const raw = readStorageItem(RATELIMIT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const now = Date.now();
    if (typeof parsed.rateLimitedUntil === 'number' && parsed.rateLimitedUntil > now) {
      rateLimitedUntil = Math.max(rateLimitedUntil, parsed.rateLimitedUntil);
    }
    if (typeof parsed.bgPausedUntil === 'number' && parsed.bgPausedUntil > now) {
      bgPausedUntil = Math.max(bgPausedUntil, parsed.bgPausedUntil);
    }
    if (typeof parsed.hoverPausedUntil === 'number' && parsed.hoverPausedUntil > now) {
      hoverPausedUntil = Math.max(hoverPausedUntil, parsed.hoverPausedUntil);
    }
  } catch {
    // Ignore malformed rate-limit state.
  }
}

function persistRateLimitToStorage() {
  writeStorageItem(
    RATELIMIT_STORAGE_KEY,
    JSON.stringify({
      rateLimitedUntil,
      bgPausedUntil,
      hoverPausedUntil,
    })
  );
}

function applyHydratedAuthorRecord(key, val, now) {
  if (!val || typeof val.expiresAt !== 'number' || val.expiresAt <= now) return;
  if (typeof val.hasHot === 'boolean' && typeof val.hasTop === 'boolean') {
    const status = {
      hasHot: val.hasHot,
      hotError: '',
      hasTop: val.hasTop,
      topError: '',
      retryable: false,
      retryAt: val.expiresAt,
    };
    const hotObj = { hasHot: val.hasHot, hotError: '', retryable: false };
    authorCache.set(key, {
      expiresAt: val.expiresAt,
      hotResult: hotObj,
      hotPromise: Promise.resolve(hotObj),
      promise: Promise.resolve(status),
      consumers: new Set(),
      unscoped: false,
      priority: false,
      settledStatus: status,
    });
  } else if (typeof val.hasHot === 'boolean') {
    const hotObj = { hasHot: val.hasHot, hotError: '', retryable: false };
    const existing = authorCache.get(key);
    if (!existing || !existing.settledStatus) {
      authorCache.set(key, {
        expiresAt: val.expiresAt,
        hotResult: hotObj,
        hotPromise: Promise.resolve(hotObj),
        promise: null,
        consumers: new Set(),
        unscoped: false,
        priority: false,
        settledStatus: null,
      });
    }
  }
}

function hydrateAuthorCacheFromSession() {
  for (const source of [
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem(STATUS_STORAGE_KEY) : null),
    () =>
      typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STATUS_STORAGE_KEY) : null,
  ]) {
    try {
      const raw = source();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const now = Date.now();
      for (const [key, val] of Object.entries(parsed)) {
        applyHydratedAuthorRecord(key.toLowerCase(), val, now);
      }
    } catch {
      // Ignore malformed cache source.
    }
  }
}

function persistAuthorCacheToSession() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const now = Date.now();
    const serializable = {};
    for (const [key, entry] of authorCache.entries()) {
      if (
        entry.expiresAt !== Infinity &&
        entry.expiresAt > now &&
        entry.settledStatus &&
        typeof entry.settledStatus.hasHot === 'boolean' &&
        typeof entry.settledStatus.hasTop === 'boolean'
      ) {
        serializable[key] = {
          hasHot: entry.settledStatus.hasHot,
          hasTop: entry.settledStatus.hasTop,
          expiresAt: entry.expiresAt,
        };
      } else if (
        entry.expiresAt !== Infinity &&
        entry.expiresAt > now &&
        entry.hotResult &&
        typeof entry.hotResult.hasHot === 'boolean'
      ) {
        serializable[key] = {
          hasHot: entry.hotResult.hasHot,
          expiresAt: entry.expiresAt,
        };
      }
    }
    writeStorageItem(STATUS_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Ignore storage quota errors.
  }
}

function schedulePersistAuthorCache() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistAuthorCacheToSession();
  }, PERSIST_DEBOUNCE_MS);
}

class RequestError extends Error {
  constructor(message, { status = 0, retryable = false, uncertain = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

class CancelledCheck extends Error {}

function getAdaptiveIntervalMs(isPriorityOrContinuation) {
  if (isPriorityOrContinuation) return Math.min(REQUEST_INTERVAL_MS, 400);
  if (lastRateLimitRemaining !== null && Number.isFinite(lastRateLimitRemaining)) {
    if (lastRateLimitRemaining <= BG_RATELIMIT_RESERVE + 10) return 1600;
    if (lastRateLimitRemaining <= BG_RATELIMIT_RESERVE + 25) return 1200;
  }
  return REQUEST_INTERVAL_MS;
}

function getEntryBlockedUntil(entry) {
  if (entry.continuation || entry.priority) {
    return Math.max(nextRequestAt, rateLimitedUntil, hoverPausedUntil);
  }
  return Math.max(nextRequestAt, rateLimitedUntil, bgPausedUntil);
}

function enqueueRequest(task, priority = false, isRelevant = () => true, meta = {}) {
  return new Promise((resolve, reject) => {
    const entry = {
      task,
      resolve,
      reject,
      isRelevant,
      priority: Boolean(priority),
      continuation: Boolean(meta.continuation),
      authorKey: meta.authorKey ? String(meta.authorKey).toLowerCase() : '',
    };
    if (entry.continuation || entry.priority) {
      fetchQueue.unshift(entry);
    } else {
      fetchQueue.push(entry);
    }
    processQueue();
  });
}

function promoteAuthorInQueue(authorKey) {
  const key = String(authorKey || '').toLowerCase();
  if (!key) return false;
  let promoted = false;
  for (let i = fetchQueue.length - 1; i >= 0; i--) {
    if (fetchQueue[i].authorKey === key) {
      const [entry] = fetchQueue.splice(i, 1);
      entry.priority = true;
      fetchQueue.unshift(entry);
      promoted = true;
    }
  }
  if (promoted) processQueue();
  return promoted;
}

function processQueue() {
  if (queueTimer !== null) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  for (let i = fetchQueue.length - 1; i >= 0; i--) {
    if (!fetchQueue[i].isRelevant()) {
      const [entry] = fetchQueue.splice(i, 1);
      entry.reject(new CancelledCheck());
    }
  }
  if (document.visibilityState === 'hidden' || pendingBlocks.size > 0) return;
  if (activeRequests >= MAX_CONCURRENT || fetchQueue.length === 0) return;

  const now = Date.now();
  let runnableIndex = -1;
  let minDelay = Infinity;

  for (let i = 0; i < fetchQueue.length; i++) {
    const delay = getEntryBlockedUntil(fetchQueue[i]) - now;
    if (delay <= 0) {
      runnableIndex = i;
      break;
    }
    if (delay < minDelay) minDelay = delay;
  }

  if (runnableIndex === -1) {
    if (Number.isFinite(minDelay) && minDelay > 0) {
      queueTimer = setTimeout(processQueue, Math.min(minDelay, 2147483647));
    }
    return;
  }

  const [entry] = fetchQueue.splice(runnableIndex, 1);
  activeRequests++;
  nextRequestAt = Date.now() + getAdaptiveIntervalMs(entry.priority || entry.continuation);
  Promise.resolve()
    .then(entry.task)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      activeRequests--;
      processQueue();
    });
  processQueue();
}

function respectRateLimit(res) {
  const now = Date.now();
  let changed = false;
  if (res.status === 429) {
    const value = res.headers.get('Retry-After');
    const seconds = value === null ? NaN : Number(value);
    const retryAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
    rateLimitedUntil = Math.max(
      rateLimitedUntil,
      Number.isFinite(retryAt) ? retryAt : now + FAILURE_TTL_MS
    );
    changed = true;
  }
  const remainingRaw = res.headers.get('X-Ratelimit-Remaining');
  const reset = Number(res.headers.get('X-Ratelimit-Reset'));
  if (remainingRaw !== null) {
    const remaining = Number(remainingRaw);
    if (Number.isFinite(remaining)) {
      lastRateLimitRemaining = remaining;
      if (Number.isFinite(reset) && reset > 0) {
        const resetAt = now + reset * 1000;
        if (remaining <= BG_RATELIMIT_RESERVE) {
          bgPausedUntil = Math.max(bgPausedUntil, resetAt);
          changed = true;
        }
        if (remaining <= MIN_RATELIMIT_RESERVE) {
          hoverPausedUntil = Math.max(hoverPausedUntil, resetAt);
          changed = true;
        }
      }
    }
  }
  if (changed) persistRateLimitToStorage();
}

function requestJson(url, options = {}, priority = false, isRelevant = () => true, queueMeta = {}) {
  const task = async () => {
    if (priority && rateLimitedUntil > Date.now()) {
      const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
      throw new RequestError(`Reddit rate limit active. Please wait ${waitSec}s.`, {
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
      respectRateLimit(res);
      if (!res.ok) {
        const message =
          res.status === 429
            ? 'Reddit rate limit. Please wait before retrying.'
            : res.status === 401 || res.status === 403
              ? `Reddit denied access (HTTP ${res.status}). Check that you are signed in.`
              : `Reddit returned HTTP ${res.status}.`;
        throw new RequestError(message, {
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
          uncertain: res.status >= 500,
        });
      }
      if (res.redirected) {
        throw new RequestError('Reddit redirected the request. Check your session.', {
          uncertain: true,
        });
      }
      if (options.method === 'POST' && res.status === 204) return {};
      let data;
      try {
        data = await res.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new RequestError('Reddit returned an unreadable response.', { uncertain: true });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new RequestError('Reddit returned an unexpected response.', { uncertain: true });
      }
      const errors = data.json?.errors ?? data.errors;
      if (Array.isArray(errors) && errors.length) {
        const details = errors
          .map((error) => (Array.isArray(error) ? error.slice(0, 2).join(': ') : String(error)))
          .join('; ');
        const limited = errors.some((error) => Array.isArray(error) && error[0] === 'RATELIMIT');
        if (limited) {
          const seconds = Number(data.json?.ratelimit);
          rateLimitedUntil = Math.max(
            rateLimitedUntil,
            Date.now() + (seconds > 0 ? seconds * 1000 : FAILURE_TTL_MS)
          );
          persistRateLimitToStorage();
        }
        throw new RequestError(details, { status: limited ? 429 : 0, retryable: limited });
      }
      if (data.error || data.success === false) {
        throw new RequestError(String(data.message || data.error || 'Reddit rejected the request.'));
      }
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(
        controller.signal.aborted ? 'Reddit request timed out.' : 'Network error contacting Reddit.',
        {
          retryable: true,
          uncertain: true,
        }
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  };
  if (!priority) {
    return enqueueRequest(task, Boolean(queueMeta.priorityQueue), isRelevant, queueMeta);
  }
  return task();
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
    btn.addEventListener(evt, (e) => {
      e.stopPropagation();
    });
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
    modhashPromise = requestJson(`${location.origin}/api/me.json`, {}, true)
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
    const profile = await requestJson(
      `${location.origin}/user/${encodeURIComponent(author)}/about.json?raw_json=1`,
      {},
      true
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

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (uh) headers['X-Modhash'] = uh;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  await requestJson(
    `${location.origin}/api/block_user`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: params.toString(),
    },
    true
  );
}

async function blockAccountRequest(author, authorId) {
  const csrfToken = getCsrfCookie() || getDomToken();
  const validInitialId = /^t2_[a-z0-9]+$/i.test(authorId || '') ? authorId : '';
  const uh = await getModhash();

  if (!uh && !csrfToken) {
    throw new RequestError('No modhash or session token (check that you are logged in).');
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

function markAuthorBlockedInDom(author) {
  blockedAuthors.add(author.toLowerCase());
  saveBlockedAuthors();
  updateBlockButtons(author);
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
    btn.title = `${activeError.message}${
      activeError.uncertain ? ' Check blocked accounts in Reddit settings before retrying.' : ''
    }`;
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
    if (post && blockedAuthors.has(key)) {
      dimPost(post);
    }
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

function createBlockBtn(author, authorId) {
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
    const key = author.toLowerCase();
    if (btn.disabled || pendingBlocks.has(key) || blockedAuthors.has(key)) return;

    authorErrors.delete(key);
    pendingBlocks.add(key);
    updateBlockButtons(author);
    processQueue();

    let failure = null;
    try {
      await enqueueBlockTask(() => blockAccountRequest(author, authorId));
      markAuthorBlockedInDom(author);
    } catch (error) {
      failure = error;
      authorErrors.set(key, error);
      if (error.status === 401 || error.status === 403) {
        cachedModhash = '';
      }
    } finally {
      pendingBlocks.delete(key);
      if (failure) {
        const lockMs =
          failure.status === 429
            ? Math.min(Math.max(rateLimitedUntil - Date.now(), ERROR_LOCK_MS), 15000)
            : ERROR_LOCK_MS;
        lockAuthorButtonsTemporarily(author, lockMs);
      } else {
        updateBlockButtons(author, null);
      }
      processQueue();
    }
  });

  return btn;
}

async function checkListingHasPosts(url, priority = false, isRelevant = () => true, queueMeta = {}) {
  const data = await requestJson(url, {}, false, isRelevant, {
    ...queueMeta,
    priorityQueue: Boolean(priority || queueMeta.priorityQueue),
  });
  const children = data?.data?.children;
  if (data?.kind !== 'Listing' || !Array.isArray(children)) {
    throw new RequestError('Reddit returned an invalid post listing.');
  }

  return children.length > 0;
}

function syncAuthorListingButtonsInDom(author, status) {
  if (!author || !status) return;
  const key = author.toLowerCase();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
    if ((wrap.dataset.author || '').toLowerCase() !== key) return;
    const postsBtn = wrap.querySelector('[data-role="posts"]');
    const topBtn = wrap.querySelector('[data-role="top"]');
    if ('hasHot' in status && status.hasHot !== undefined) {
      renderListingState(postsBtn, status.hasHot, 'Posts', 'No posts', status.hotError || '');
    }
    if ('hasTop' in status && status.hasTop !== undefined) {
      renderListingState(topBtn, status.hasTop, 'Top posts', 'No top', status.topError || '');
    }
    if (typeof status.hasHot === 'boolean' && typeof status.hasTop === 'boolean') {
      wrap.dataset.statusRequested = 'true';
    }
  });
}

function getAuthorStatus(author, onHot, isRelevant = null, priority = false) {
  const key = author.toLowerCase();
  const cached = authorCache.get(key);
  const now = Date.now();

  if (cached && cached.settledStatus && cached.expiresAt > now) {
    if (onHot) {
      Promise.resolve(cached.settledStatus).then((hot) => {
        if (!hot.cancelled) onHot(hot);
      });
    }
    return cached.promise;
  }

  if (cached && cached.expiresAt === Infinity && cached.promise) {
    if (isRelevant) cached.consumers.add(isRelevant);
    else cached.unscoped = true;
    if (priority && !cached.priority) {
      cached.priority = true;
      promoteAuthorInQueue(key);
    }
    if (onHot && cached.hotPromise) {
      cached.hotPromise.then((hot) => {
        if (!hot.cancelled) onHot(hot);
      });
    }
    return cached.promise;
  }

  if (cached && !cached.settledStatus && !cached.hotResult && cached.expiresAt > now && !priority) {
    if (onHot && cached.hotPromise) {
      cached.hotPromise.then((hot) => {
        if (!hot.cancelled) onHot(hot);
      });
    }
    if (cached.promise) return cached.promise;
  }

  const encoded = encodeURIComponent(author);
  const preservedHot =
    cached && cached.hotResult && typeof cached.hotResult.hasHot === 'boolean'
      ? cached.hotResult
      : null;

  const entry = {
    expiresAt: Infinity,
    hotResult: preservedHot,
    hotPromise: null,
    promise: null,
    consumers: new Set(isRelevant ? [isRelevant] : []),
    unscoped: !isRelevant,
    priority: Boolean(priority),
    settledStatus: null,
  };
  const needed = () =>
    !blockedAuthors.has(key) && (entry.unscoped || [...entry.consumers].some((check) => check()));

  if (preservedHot) {
    entry.hotPromise = Promise.resolve(preservedHot);
  } else {
    entry.hotPromise = checkListingHasPosts(
      `${location.origin}/user/${encoded}/submitted.json?limit=1&sort=hot&include_over_18=on&raw_json=1`,
      entry.priority,
      needed,
      { authorKey: key, priorityQueue: entry.priority }
    ).then(
      (value) => {
        const res = { hasHot: value, hotError: '', retryable: false };
        entry.hotResult = res;
        syncAuthorListingButtonsInDom(author, { hasHot: value, hotError: '' });
        return res;
      },
      (error) => {
        if (error instanceof CancelledCheck) return { cancelled: true };
        if (error instanceof RequestError && error.status === 404) {
          const res404 = { hasHot: false, hotError: '', retryable: false, emptyProfile: true };
          entry.hotResult = res404;
          syncAuthorListingButtonsInDom(author, { hasHot: false, hotError: '' });
          return res404;
        }
        return {
          hasHot: null,
          hotError: error.message,
          retryable: error.retryable,
        };
      }
    );
  }

  if (onHot) {
    entry.hotPromise.then((hot) => {
      if (!hot.cancelled) onHot(hot);
    });
  }

  entry.promise = entry.hotPromise
    .then(async (hot) => {
      if (hot.cancelled) return hot;
      let top;
      if (hot.hasHot === true) {
        // A visible submitted post also belongs to the all-time top listing.
        top = { hasTop: true, topError: '', retryable: false };
      } else if (hot.emptyProfile) {
        top = { hasTop: false, topError: '', retryable: false };
      } else if (hot.hasHot === null) {
        top = { hasTop: null, topError: hot.hotError, retryable: hot.retryable };
      } else {
        try {
          top = {
            hasTop: await checkListingHasPosts(
              `${location.origin}/user/${encoded}/submitted.json?limit=1&sort=top&t=all&include_over_18=on&raw_json=1`,
              true,
              needed,
              { authorKey: key, priorityQueue: true, continuation: true }
            ),
            topError: '',
            retryable: false,
          };
        } catch (error) {
          if (error instanceof CancelledCheck) {
            return { cancelled: true, hotPreserved: true, hasHot: hot.hasHot, hotError: '' };
          }
          if (error instanceof RequestError && error.status === 404) {
            top = { hasTop: false, topError: '', retryable: false };
          } else {
            top = { hasTop: null, topError: error.message, retryable: error.retryable };
          }
        }
      }
      const failed = hot.hasHot === null || top.hasTop === null;
      entry.expiresAt = Math.max(
        Date.now() + (failed ? FAILURE_TTL_MS : STATUS_TTL_MS),
        failed ? rateLimitedUntil : 0
      );
      for (const [oldKey, oldEntry] of authorCache) {
        if (authorCache.size <= MAX_CACHE_SIZE) break;
        if (oldEntry.expiresAt !== Infinity) authorCache.delete(oldKey);
      }
      const result = {
        hasHot: hot.hasHot,
        hotError: hot.hotError || '',
        hasTop: top.hasTop,
        topError: top.topError || '',
        retryable: Boolean(hot.retryable || top.retryable),
        retryAt: entry.expiresAt,
      };
      if (!failed) {
        entry.settledStatus = result;
        syncAuthorListingButtonsInDom(author, result);
        schedulePersistAuthorCache();
      } else if (typeof hot.hasHot === 'boolean') {
        syncAuthorListingButtonsInDom(author, { hasHot: hot.hasHot, hotError: '' });
        schedulePersistAuthorCache();
      }
      return result;
    })
    .then((status) => {
      entry.consumers.clear();
      if (status.cancelled) {
        if (entry.hotResult && typeof entry.hotResult.hasHot === 'boolean') {
          entry.expiresAt = Date.now() + STATUS_TTL_MS;
          entry.promise = null;
          schedulePersistAuthorCache();
        } else if (authorCache.get(key) === entry) {
          authorCache.delete(key);
        }
      }
      return status;
    });

  authorCache.set(key, entry);
  return entry.promise;
}

function renderListingState(btn, hasPosts, label, emptyLabel, error) {
  if (!btn) return;
  btn.dataset.postsState = hasPosts === null ? 'unknown' : hasPosts ? 'present' : 'empty';
  btn.title = hasPosts === null ? `Could not check posts: ${error}` : '';
  if (hasPosts === false) setEmptyState(btn, emptyLabel);
  else {
    applyTheme(btn, NORMAL_THEME);
    btn.textContent = label;
  }
}

async function updateAuthorStatus(wrap, canRetry = true, priority = false) {
  const author = wrap.dataset.author;
  if (!author || blockedAuthors.has(author.toLowerCase())) return;
  if (wrap.dataset.statusChecking === 'true') {
    if (priority) promoteAuthorInQueue(author.toLowerCase());
    return;
  }
  wrap.dataset.statusChecking = 'true';
  const postsBtn = wrap.querySelector('[data-role="posts"]');
  const topBtn = wrap.querySelector('[data-role="top"]');
  let cancelled = false;
  try {
    const status = await getAuthorStatus(
      author,
      (hot) => {
        if (wrap.isConnected && wrap.dataset.author === author) {
          renderListingState(postsBtn, hot.hasHot, 'Posts', 'No posts', hot.hotError);
        }
      },
      () => wrap.isConnected && wrap.dataset.author === author && wrap.dataset.nearby === 'true',
      priority
    );
    if (status.cancelled) {
      cancelled = true;
      if (typeof status.hasHot === 'boolean' && wrap.isConnected && wrap.dataset.author === author) {
        renderListingState(postsBtn, status.hasHot, 'Posts', 'No posts', status.hotError || '');
      }
      return;
    }
    if (!wrap.isConnected || wrap.dataset.author !== author) return;
    renderListingState(postsBtn, status.hasHot, 'Posts', 'No posts', status.hotError);
    renderListingState(topBtn, status.hasTop, 'Top posts', 'No top', status.topError);
    if (canRetry && status.retryable && wrap.dataset.statusRetry !== 'true') {
      wrap.dataset.statusRetry = 'true';
      setTimeout(() => {
        if (wrap.isConnected && wrap.dataset.author === author) {
          wrap.dataset.retryReady = 'true';
          requestVisibleStatus(wrap);
        }
      }, Math.min(Math.max(status.retryAt - Date.now(), 0) + 1, 2147483647));
    }
  } finally {
    wrap.dataset.statusChecking = 'false';
    if (cancelled) {
      wrap.dataset.statusRequested = 'false';
      requestVisibleStatus(wrap);
    }
  }
}

function requestVisibleStatus(wrap) {
  if (!wrap.isConnected || document.visibilityState === 'hidden' || wrap.dataset.nearby !== 'true')
    return;
  const key = (wrap.dataset.author || '').toLowerCase();
  if (!key || blockedAuthors.has(key)) return;
  if (wrap.dataset.statusChecking === 'true') return;
  const cached = authorCache.get(key);
  if (cached && cached.settledStatus && cached.expiresAt > Date.now()) {
    const postsBtn = wrap.querySelector('[data-role="posts"]');
    const topBtn = wrap.querySelector('[data-role="top"]');
    renderListingState(postsBtn, cached.settledStatus.hasHot, 'Posts', 'No posts', '');
    renderListingState(topBtn, cached.settledStatus.hasTop, 'Top posts', 'No top', '');
    wrap.dataset.statusRequested = 'true';
    return;
  }
  const hasIncompleteHot =
    cached && !cached.settledStatus && cached.hotResult && typeof cached.hotResult.hasHot === 'boolean';
  if (
    wrap.dataset.statusRequested === 'true' &&
    wrap.dataset.retryReady !== 'true' &&
    !hasIncompleteHot
  ) {
    return;
  }
  wrap.dataset.statusRequested = 'true';
  wrap.dataset.retryReady = 'false';
  updateAuthorStatus(wrap, wrap.dataset.statusRetry !== 'true', false);
}

function clearDwellTimer(wrap) {
  const timer = dwellTimers.get(wrap);
  if (timer !== undefined) {
    clearTimeout(timer);
    dwellTimers.delete(wrap);
  }
}

const visibilityObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const wrap = entry.target;
      wrap.dataset.nearby = String(entry.isIntersecting);
      clearDwellTimer(wrap);

      if (entry.isIntersecting) {
        const key = (wrap.dataset.author || '').toLowerCase();
        const cached = authorCache.get(key);
        if (
          cached &&
          cached.expiresAt > Date.now() &&
          cached.expiresAt !== Infinity &&
          (cached.settledStatus || cached.hotResult)
        ) {
          requestVisibleStatus(wrap);
        } else {
          const timer = setTimeout(() => {
            dwellTimers.delete(wrap);
            if (wrap.isConnected && wrap.dataset.nearby === 'true') {
              requestVisibleStatus(wrap);
            }
          }, VIEWPORT_DWELL_MS);
          dwellTimers.set(wrap, timer);
        }
      }
    });
    processQueue();
  },
  { rootMargin: `${PREFETCH_MARGIN_PX}px` }
);

function normalizeAuthor(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^u\//i, '');
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

function applyCachedAuthorStatusToWrap(wrap, author) {
  const cached = authorCache.get(author.toLowerCase());
  if (!cached || cached.expiresAt <= Date.now()) return;
  const postsBtn = wrap.querySelector('[data-role="posts"]');
  const topBtn = wrap.querySelector('[data-role="top"]');
  if (cached.settledStatus) {
    renderListingState(postsBtn, cached.settledStatus.hasHot, 'Posts', 'No posts', '');
    renderListingState(topBtn, cached.settledStatus.hasTop, 'Top posts', 'No top', '');
    wrap.dataset.statusRequested = 'true';
  } else if (cached.hotResult && typeof cached.hotResult.hasHot === 'boolean') {
    renderListingState(postsBtn, cached.hotResult.hasHot, 'Posts', 'No posts', '');
  }
}

function createBtnGroup(author, authorId) {
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

  // Immediately apply cached state if already known from storage or memory.
  applyCachedAuthorStatusToWrap(wrap, author);

  visibilityObserver.observe(wrap);

  const checkOnIntent = () => {
    clearDwellTimer(wrap);
    const key = author.toLowerCase();
    if (wrap.dataset.statusChecking === 'true') {
      promoteAuthorInQueue(key);
      return;
    }
    const entry = authorCache.get(key);
    if (
      wrap.dataset.statusRequested === 'true' &&
      entry &&
      entry.settledStatus &&
      entry.expiresAt > Date.now()
    ) {
      renderListingState(postsBtn, entry.settledStatus.hasHot, 'Posts', 'No posts', '');
      renderListingState(topBtn, entry.settledStatus.hasTop, 'Top posts', 'No top', '');
      return;
    }
    wrap.dataset.statusRequested = 'true';
    wrap.dataset.nearby = 'true';
    updateAuthorStatus(wrap, false, true);
  };
  [postsBtn, topBtn].forEach((btn) => {
    btn.addEventListener('pointerenter', checkOnIntent);
    btn.addEventListener('focus', checkOnIntent);
  });
  return wrap;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
      visibilityObserver.unobserve(wrap);
      visibilityObserver.observe(wrap);
    });
  } else {
    persistAuthorCacheToSession();
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach(clearDwellTimer);
    processQueue();
  }
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    persistAuthorCacheToSession();
  });

  window.addEventListener('storage', (e) => {
    if (!e || !e.key) return;
    if (e.key === STATUS_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (!parsed || typeof parsed !== 'object') return;
        const now = Date.now();
        for (const [key, val] of Object.entries(parsed)) {
          const lower = key.toLowerCase();
          applyHydratedAuthorRecord(lower, val, now);
          const entry = authorCache.get(lower);
          if (entry?.settledStatus) {
            syncAuthorListingButtonsInDom(lower, entry.settledStatus);
          } else if (entry?.hotResult) {
            syncAuthorListingButtonsInDom(lower, entry.hotResult);
          }
        }
      } catch {
        // Ignore malformed storage event payload.
      }
    } else if (e.key === BLOCKED_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          parsed.forEach((a) => {
            const lower = String(a).toLowerCase();
            blockedAuthors.add(lower);
            updateBlockButtons(lower);
          });
        }
      } catch {
        // Ignore malformed blocked list.
      }
    } else if (e.key === RATELIMIT_STORAGE_KEY && e.newValue) {
      hydrateRateLimitFromStorage();
      processQueue();
    }
  });
}

const dimmedPosts = new WeakMap();

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
    if (existing.dataset.author === author && existing.dataset.authorId === authorId) {
      applyCachedAuthorStatusToWrap(existing, author);
      if (detachedWraps.has(existing)) {
        detachedWraps.delete(existing);
        visibilityObserver.observe(existing);
      }
      return;
    }
    clearDwellTimer(existing);
    existing.dataset.nearby = 'false';
    visibilityObserver.unobserve(existing);
    existing.remove();
    processQueue();
  }

  if (!author || author === '[deleted]' || !bar) return;

  const wrap = createBtnGroup(author, authorId);
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

let rafScheduled = false;
const pendingPosts = new Set();

function collectPosts(node) {
  if (node.nodeType !== 1) return;
  if (node.matches(POST_SELECTOR)) pendingPosts.add(node);
  const parentPost = node.closest(POST_SELECTOR);
  if (parentPost) pendingPosts.add(parentPost);
  node.querySelectorAll(POST_SELECTOR).forEach((post) => pendingPosts.add(post));
}

function scheduleProcessPosts(mutations) {
  let detached = false;
  for (const mutation of mutations) {
    if (mutation.target.nodeType === 1 && mutation.target.closest(`.${WRAP_CLASS}`)) continue;
    if (mutation.type === 'attributes') {
      collectPosts(mutation.target);
      continue;
    }
    const parentPost =
      mutation.target.nodeType === 1 ? mutation.target.closest(POST_SELECTOR) : null;
    if (parentPost) pendingPosts.add(parentPost);
    mutation.addedNodes.forEach(collectPosts);
    mutation.removedNodes.forEach((node) => {\n      if (node.nodeType !== 1 || node.isConnected) return;
      const detach = (wrap) => {
        clearDwellTimer(wrap);
        wrap.dataset.nearby = 'false';
        visibilityObserver.unobserve(wrap);
        detachedWraps.add(wrap);
        detached = true;
      };
      if (node.matches(`.${WRAP_CLASS}`)) detach(node);
      node.querySelectorAll(`.${WRAP_CLASS}`).forEach(detach);
    });
  }
  if (detached) processQueue();
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
