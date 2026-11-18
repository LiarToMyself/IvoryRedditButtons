# Micro-report 01: Clean Top-to-Hot cascade and removal of queue bloat (Issue #13)

Date: 2026-11-17

## Bug description
In [`v1.4.3-gemini-ai-studio-argon`](https://github.com/LiarToMyself/IvoryRedditButtons/tree/v1.4.3-gemini-ai-studio-argon), empty profiles (`hasHot === false`) left a partial record (`settledStatus: null, hotResult: { hasHot: false }, retryAfterAt: 0`) in `authorCache` when scrolled or interrupted, and re-fired `sort=top&t=all` with `continuation: true` in a loop while bypassing `bgPausedUntil` and `getBgBudgetResumeAt`. This exhausted Reddit's 100-request 10-minute `.json` quota and triggered `HTTP 429` lockouts for 400+ seconds. In addition, `if (hot.hasHot === true)` skipped checking `Top posts`, `children.length > 0` failed to filter moderator-removed placeholder items, `if (rateLimitedUntil > now || bgPausedUntil > now) return;` dropped visible cards during pauses, and subsequent branches (`BUGFIXES1`, `BUGFIXES2`, `v1.4.3`, `v1.4.3-gemini-3.8FH`) broke independent `Posts` and `Top posts` coloring by collapsing both buttons into a single query.

## Changed files
- [`content.js`](https://github.com/LiarToMyself/IvoryRedditButtons/blob/v1.4.3-clean-cascade/content.js) (commit [`422d61b`](https://github.com/LiarToMyself/IvoryRedditButtons/commit/422d61b6ee04a561d59286b9394a4cb01a7e5872))

## Why the change helps
- **Cascade `Top posts` -> `Posts` check (`checkAuthorCascade`)**: Step 1 queries `/user/<author>/submitted.json?limit=5&sort=top&t=all&raw_json=1` with `isVisibleSubmissionItem` filtering (`removed_by_category`, `removed`, `spam`, `hidden`, `[deleted]`, `kind !== 't3'`). If visible top posts exist (~90% of Reddit authors), both `hasHot` and `hasTop` resolve to `true` in 1 request. If `HTTP 404` or `HTTP 403` is returned, both resolve to `false` in 1 request. Only when Step 1 returns `200 OK` with 0 visible top posts does `Top posts` turn red (`✕ No top`) and Step 2 query `sort=hot&limit=5&raw_json=1` through the normal queue to set `Posts` independently.
- **Removal of `preservedHot` and `continuation` bypass**: Partial statuses are never persisted to `authorCache` or `localStorage` (`ivory_reddit_author_status_v4`). Every listing request passes through `getBudgetBlockedUntil` (`REQUEST_INTERVAL_MS = 2400` ms, `MAX_PER_MIN = 7`, `MAX_PER_10MIN = 28`, `RATELIMIT_RESERVE = 20`, 600s fallback on `HTTP 429`).
- **Full-post observation and LIFO queue**: `visibilityObserver` (`rootMargin: '200px'`, `VIEWPORT_DWELL_MS = 900` ms) observes the post card and keeps visible items in `fetchQueue` across pauses without dropping them.

## What still needs a manual check
- Reload unpacked extension in `chrome://extensions/` and refresh a live Reddit tab (`F5`).
- Check that normal authors keep grey `Posts` and `Top posts` buttons, empty authors turn both buttons red (`✕ No posts` / `✕ No top`), authors with fresh posts but no top posts turn only `Top posts` red (`✕ No top`), and 1-click `⊘ Block` transitions to `✓ Blocked`.
