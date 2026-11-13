# IvoryRedditButtons

Lightweight Manifest V3 Chrome extension for Reddit (Shreddit and Old Reddit). Adds three direct action buttons to every post header in feeds, post pages, and user profiles:

- **Posts** - opens `/user/<author>/submitted/?sort=hot` directly, bypassing the mixed Overview tab. Highlights in red (`✕ No posts`) and prevents navigation if the author has no visible hot posts.
- **Top posts** - opens `/user/<author>/submitted/?sort=top&t=all`. Highlights in red (`✕ No top`) and prevents navigation if the author has no visible top posts.
- **Block** - blocks the post author in one click directly from the feed without opening their profile.

## Key Features in v1.4.3

- **Atomic Red Empty-State Indicators (`✕ No posts` / `✕ No top`)**: Checks author submissions in a single atomic request, highlighting empty or deleted/shadowbanned (`HTTP 404`) profiles in red simultaneously, eliminating two-phase race conditions and split red/grey states.
- **Cross-Tab Shared Pacing & 429 Protection**: Enforces global request pacing across all open Reddit tabs (`2500ms` background, `300ms` hover priority), `1000ms` viewport dwell filter to prevent scrolling quota burn, defensive rate-limit header parsing, and safe 10-minute 429 backoff.
- **Robust Hydration & Cache Sync**: Prevents `<shreddit-post>` author-id hydration teardown, strictly syncs complete author statuses across tabs, and cleanses cache on scroll cancellations.

## Key Features in v1.4.2

- **Red Empty-State Indicators (`✕ No posts` / `✕ No top`)**: Checks author post listings near the viewport and on hover, highlighting empty or unavailable (`HTTP 404`) listings in red, prioritizing the `sort=top&t=all` continuation check (`unshift`), preserving partial `hasHot: false` state across scroll cancellations, and syncing all cards of the same author in the DOM.
- **Three-Tier Rate-Limit Protection (`HTTP 429` Prevention)**: Uses a `350ms` viewport dwell filter, `800ms` adaptive request pacing (`MAX_CONCURRENT = 1`), `X-Ratelimit-Remaining <= 25` background prefetch pause (`bgPausedUntil`), `X-Ratelimit-Remaining <= 5` hover reserve (`hoverPausedUntil`), and unblocked `Block` execution unless a hard `HTTP 429` (`rateLimitedUntil`) is active.
- **Cross-Tab Cache & Rate-Limit Sync**: Shares checked author statuses (`30 min` TTL), blocked authors, and rate-limit pause timers across all Reddit tabs via `localStorage` (`storage` event) with `sessionStorage` fallback and `500ms` debounced writes.
- **Crosspost-Safe DOM Injection & Reliable 1-Click Block**: Scopes header and button lookups to each post's own container so nested crossposts never collide, and uses DOM/cookie CSRF and cached modhash tokens with sequential `Block` queuing.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Reload open Reddit tabs.

## Repository Structure

- `manifest.json` - Chrome Extension Manifest V3 configuration.
- `content.js` - Content script for DOM button injection, empty-listing detection, and block API handling.
- `plans/CHANGES-1.4.3-gemini-3.8FH.md` - Root-cause analysis and v1.4.3 changelog.
- `plans/CHANGES-1.4.2-argon.md` - Root-cause analysis and v1.4.2 changelog (Issues #2, #3, #5, #6, #7, #8).
- `plans/CHANGES-1.4-argon.md` - Historical analysis of v1.3.8 rate-limit bugs and v1.4.0 / v1.4.1 changes.
- `CHANGES-1.3.md`, `CHANGES-1.2.md`, `REVIEW-2026-10-22.md` - Historical changelogs and audits from prior versions.
