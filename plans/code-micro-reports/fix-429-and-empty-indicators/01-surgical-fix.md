# Micro-report 01: Surgical fix for Reddit HTTP 429 rate limit and empty post red indicators

Date: 2026-11-17

## Bug description
Users encountered two related failures during browsing sessions:
1. After approximately 20 minutes of browsing and visiting two Reddit user profiles, Reddit locked the session out with HTTP 429 for over 400 seconds. This occurred because background prefetching ran with an aggressive 10-minute quota consumption (45 requests per 10 minutes), while two-phase checks (hot followed by top) doubled requests on empty authors. In addition, secondary queries used continuation flags that bypassed background rate limit reserves, draining the browser session budget down to five requests. Visiting user profiles then exhausted the remaining quota, triggering Reddit's 10-minute sliding window lockout.
2. An author with no top posts had neither button turn red; both Posts and Top posts remained grey. This occurred because checkListingHasPosts only verified that children.length was greater than zero without filtering for removed, deleted, spam, or hidden posts, and forced include_over_18=on. Removed or spam placeholder items caused hasHot to evaluate to true, which short-circuited hasTop to true. Furthermore, HTTP 403 responses for suspended or private accounts were treated as network errors rather than empty listings, leaving buttons grey.

## Changed files
- content.js

## Why the change helps
- Single atomic query: The author status check now queries `/user/<author>/submitted.json?limit=5&sort=hot&raw_json=1` once. Both /submitted/?sort=hot and /submitted/?sort=top&t=all display the exact same submission pool. A single query eliminates race conditions, removes continuation bypasses, and cuts background network calls in half.
- Submission filtering: Added isVisibleSubmissionItem to ignore removed, spam-filtered, hidden, or deleted posts. If zero visible posts remain, or if Reddit responds with HTTP 404 or HTTP 403, both hasHot and hasTop are atomically set to false, turning both Posts and Top posts buttons red synchronously.
- Strict session-safe pacing: Set REQUEST_INTERVAL_MS to 2500ms, set PRIORITY_INTERVAL_MS to 400ms for hover, and set VIEWPORT_DWELL_MS to 1000ms. Lowered BG_MAX_PER_MIN to 3 and BG_MAX_PER_10MIN to 18, ensuring the extension uses at most 18 percent of Reddit's 100-request 10-minute session budget. Raised BG_RATELIMIT_RESERVE to 30 and MIN_RATELIMIT_RESERVE to 10.
- Soft pause capping: Capped transient quota pauses in memory to a maximum of 120 seconds rather than freezing background checks across tabs for 10 minutes.
- Continuation bypass removed: Dropped continuation flags from getEntryBlockedUntil and queue logic so secondary checks never drain rate limit reserves.
- Surgical scope: No refactoring or signature changes of existing visibilityObserver, createBtnGroup, or scheduleProcessPosts functions.

## What still needs a manual check
- Load unpacked extension in Chrome developer mode and verify in live Reddit feeds (Shreddit and Old Reddit).
- Verify that clicking Posts and Top posts on an author with no submissions displays red buttons ("✕ No posts" and "✕ No top") and prevents navigation.
- Verify that clicking Block on an author blocks the user and updates the button to "✓ Blocked" without triggering rate-limit errors.
