const WRAP_CLASS = 'author-btns-wrap';
const POST_SELECTOR = 'shreddit-post, .thing.link';
const STORAGE_KEY = 'ivory_reddit_blocked_v1';

const BASE_BTN_STYLE =
  'position:relative;z-index:10;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;min-height:26px;max-height:26px;min-width:0;appearance:none;vertical-align:middle;gap:5px;margin:0;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;line-height:16px;text-decoration:none;white-space:nowrap;cursor:pointer;user-select:none;font-family:inherit;flex-shrink:0;transition:background 0.15s,border-color 0.15s,color 0.15s,opacity 0.15s;';

const NORMAL_THEME = {
  bg: '#272729',
  bgHover: '#343536',
  color: '#d7dadc',
  border: '#343536',
};

const ERROR_THEME = {
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

const REQUEST_TIMEOUT_MS = 12000;
const BLOCK_COOLDOWN_MS = 1500;
const ERROR_LOCK_MS = 2000;
const DEFAULT_RATE_LIMIT_MS = 60 * 1000;
const MIN_RATELIMIT_RESERVE = 5;

const blockedAuthors = loadBlockedAuthors();
const pendingBlocks = new Set();
const authorErrors = new Map();
const dimmedPosts = new WeakMap();

let rateLimitedUntil = 0;
let nextBlockAllowedAt = 0;
let cachedModhash = '';
let modhashPromise = null;
let blockChain = Promise.resolve();

function loadBlockedAuthors() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map((a) => String(a).toLowerCase())) : new Set();
  } catch {
    return new Set();
  }
}

function saveBlockedAuthors() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...blockedAuthors]));
  } catch {
    // Ignore storage quota or privacy mode errors.
  }
}

class RequestError extends Error {
  constructor(message, { status = 0, retryable = false, uncertain = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

function respectRateLimit(res) {
  const now = Date.now();
  if (res.status === 429) {
    const value = res.headers.get('Retry-After');
    const seconds = value === null ? NaN : Number(value);
    const retryAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
    rateLimitedUntil = Math.max(
      rateLimitedUntil,
      Number.isFinite(retryAt) ? retryAt : now + DEFAULT_RATE_LIMIT_MS
    );
  }
  const remaining = res.headers.get('X-Ratelimit-Remaining');
  const reset = Number(res.headers.get('X-Ratelimit-Reset'));
  if (
    remaining !== null &&
    Number(remaining) <= MIN_RATELIMIT_RESERVE &&
    Number.isFinite(reset) &&
    reset > 0
  ) {
    rateLimitedUntil = Math.max(rateLimitedUntil, now + reset * 1000);
  }
}

async function requestJson(url, options = {}) {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const waitSec = Math.ceil((rateLimitedUntil - now) / 1000);
    throw new RequestError(`Rate limited by Reddit. Wait ${waitSec}s.`, {
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
          ? 'Reddit rate limit (HTTP 429). Wait before retrying.'
          : res.status === 401 || res.status === 403
            ? `Reddit denied access (HTTP ${res.status}). Check login session.`
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
    if (res.status === 204) return {};
    const text = await res.text();
    if (!text || !text.trim()) return {};
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new RequestError('Reddit returned an unreadable response.', { uncertain: true });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new RequestError('Reddit returned an unexpected response.', { uncertain: true });
    }
    const errors = data.json?.errors ?? data.errors;
    if (Array.isArray(errors) && errors.length) {
      const details = errors
        .map((err) => (Array.isArray(err) ? err.slice(0, 2).join(': ') : String(err)))
        .join('; ');
      const limited = errors.some((err) => Array.isArray(err) && err[0] === 'RATELIMIT');
      if (limited) {
        const seconds = Number(data.json?.ratelimit);
        rateLimitedUntil = Math.max(
          rateLimitedUntil,
          Date.now() + (seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_MS)
        );
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
      { retryable: true, uncertain: true }
    );
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
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

  const activate = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
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
  const appToken =
    app?.csrfToken || app?.getAttribute('csrf-token') || app?.getAttribute('spp') || '';
  if (appToken) return appToken;
  return '';
}

async function getModhash(forceRefresh = false) {
  if (!forceRefresh) {
    const domUh = document.querySelector('input[name="uh"]')?.value;
    if (domUh) return domUh;
    if (cachedModhash) return cachedModhash;
  } else {
    cachedModhash = '';
    modhashPromise = null;
  }

  if (!modhashPromise) {
    modhashPromise = requestJson(`${location.origin}/api/me.json`)
      .then((d) => {
        const uh = d?.data?.modhash || '';
        if (uh) cachedModhash = uh;
        return uh;
      })
      .finally(() => {
        modhashPromise = null;
      });
  }
  return modhashPromise;
}

async function resolveAccountIdFallback(author) {
  const profile = await requestJson(
    `${location.origin}/user/${encodeURIComponent(author)}/about.json?raw_json=1`
  );
  const id = profile?.data?.id;
  return typeof id === 'string' && /^[a-z0-9]+$/i.test(id) ? `t2_${id}` : '';
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

  await requestJson(`${location.origin}/api/block_user`, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
}

async function blockAccountRequest(author, authorId) {
  const csrfToken = getCsrfCookie() || getDomToken();
  let uh = '';
  try {
    uh = await getModhash(false);
  } catch (err) {
    if (!csrfToken) throw err;
  }
  if (!uh && !csrfToken) {
    throw new RequestError('Not logged in (missing session token).');
  }

  const validInitialId = /^t2_[a-z0-9]+$/i.test(authorId || '') ? authorId : '';

  try {
    await sendBlockPost(author, validInitialId, uh, csrfToken);
  } catch (firstErr) {
    if (firstErr.status === 429) throw firstErr;
    // Fallback only if post card had no author-id and Reddit required account_id.
    if (!validInitialId) {
      const resolvedId = await resolveAccountIdFallback(author);
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

function setBtnLabel(btn, iconText, labelText) {
  btn.textContent = '';
  if (iconText) {
    const icon = document.createElement('span');
    icon.textContent = iconText;
    icon.style.cssText = 'font-size:12px;line-height:1;';
    btn.appendChild(icon);
  }
  const label = document.createElement('span');
  label.textContent = labelText;
  btn.appendChild(label);
}

function renderBlockButton(btn, author) {
  const key = author.toLowerCase();
  const error = authorErrors.get(key) || null;
  btn.title = '';
  btn.removeAttribute('aria-label');

  if (blockedAuthors.has(key)) {
    applyTheme(btn, BLOCKED_THEME);
    setBtnLabel(btn, '✓', 'Blocked');
    btn.style.cursor = 'default';
    btn.disabled = true;
    return;
  }

  if (pendingBlocks.has(key)) {
    applyTheme(btn, BLOCK_THEME);
    setBtnLabel(btn, '⋯', 'Blocking');
    btn.title = 'Sending block request to Reddit...';
    btn.style.cursor = 'wait';
    btn.disabled = true;
    return;
  }

  if (error) {
    applyTheme(btn, ERROR_THEME);
    const isLocked = btn.dataset.errorLocked === 'true';
    setBtnLabel(btn, '✕', isLocked ? 'Wait...' : 'Retry block');
    btn.title = `${error.message}${
      error.uncertain ? ' Check blocked accounts in Reddit settings before retrying.' : ''
    }`;
    btn.setAttribute('aria-label', btn.title);
    btn.disabled = isLocked;
    btn.style.cursor = isLocked ? 'not-allowed' : 'pointer';
    return;
  }

  btn.disabled = false;
  btn.style.cursor = 'pointer';
  applyTheme(btn, BLOCK_THEME);
  setBtnLabel(btn, '⊘', 'Block');
}

function updateBlockButtons(author) {
  const key = author.toLowerCase();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
    if ((wrap.dataset.author || '').toLowerCase() !== key) return;
    const blockBtn = wrap.querySelector('[data-role="block"]');
    if (blockBtn) renderBlockButton(blockBtn, author);
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

    try {
      await enqueueBlockTask(() => blockAccountRequest(author, authorId));
      blockedAuthors.add(key);
      saveBlockedAuthors();
    } catch (error) {
      authorErrors.set(key, error);
      if (error.status === 401 || error.status === 403) {
        cachedModhash = '';
      }
    } finally {
      pendingBlocks.delete(key);
      if (authorErrors.has(key)) {
        const err = authorErrors.get(key);
        const lockMs =
          err.status === 429
            ? Math.min(Math.max(rateLimitedUntil - Date.now(), ERROR_LOCK_MS), 15000)
            : ERROR_LOCK_MS;
        lockAuthorButtonsTemporarily(author, lockMs);
      } else {
        updateBlockButtons(author);
      }
    }
  });

  return btn;
}

function normalizeAuthor(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^u\//i, '');
}

function extractAuthorId(post, modern) {
  const direct = post.getAttribute(modern ? 'author-id' : 'data-author-fullname') || '';
  if (/^t2_[a-z0-9]+$/i.test(direct)) return direct;
  const hovercard = post.querySelector('[data-author-fullname], [author-id]');
  const nested =
    hovercard?.getAttribute('author-id') || hovercard?.getAttribute('data-author-fullname') || '';
  return /^t2_[a-z0-9]+$/i.test(nested) ? nested : '';
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

  return wrap;
}

function dimPost(post) {
  if (!dimmedPosts.has(post)) dimmedPosts.set(post, post.style.opacity);
  post.style.opacity = '0.35';
}

function processPost(post) {
  if (!post.isConnected) return;
  const modern = post.matches('shreddit-post');
  const author = normalizeAuthor(post.getAttribute(modern ? 'author' : 'data-author'));
  const authorId = extractAuthorId(post, modern);

  if (dimmedPosts.has(post) && !blockedAuthors.has(author.toLowerCase())) {
    post.style.opacity = dimmedPosts.get(post);
    dimmedPosts.delete(post);
  }

  const existing = post.querySelector(`.${WRAP_CLASS}`);
  if (existing) {
    if (existing.dataset.author === author && existing.dataset.authorId === authorId) {
      return;
    }
    existing.remove();
  }

  if (!author || author === '[deleted]') return;
  const bar = post.querySelector(modern ? '[slot="credit-bar"]' : 'p.tagline');
  if (!bar) return;

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
