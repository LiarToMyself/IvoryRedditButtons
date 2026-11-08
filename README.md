# IvoryRedditButtons

Lightweight Manifest V3 Chrome extension for Reddit (Shreddit and Old Reddit). Adds three direct action buttons to every post header in feeds, post pages, and user profiles:

- **Posts** - opens `/user/<author>/submitted/?sort=hot` directly, bypassing the mixed Overview tab. Highlights in red (`✕ No posts`) and prevents navigation if the author has no visible hot posts.
- **Top posts** - opens `/user/<author>/submitted/?sort=top&t=all`. Highlights in red (`✕ No top`) and prevents navigation if the author has no visible top posts.
- **Block** - blocks the post author in one click directly from the feed without opening their profile.

## Key Features in v1.4.1

- **Red Empty-State Indicators (`✕ No posts` / `✕ No top`)**: Automatically checks author post listings near the viewport and on hover, highlighting empty listings in red and preventing empty tab opens.
- **Rate-Limit Safe (`HTTP 429` Prevention)**: Uses a `180ms` viewport dwell filter (skipping fast-scrolled cards), `500ms` request pacing, `X-Ratelimit-Remaining <= 5` quota reserve, and `sessionStorage` caching across page loads.
- **Reliable 1-Click Block**: Uses DOM/cookie CSRF and cached modhash tokens, lazy `account_id` fallback, sequential request queuing, anti-spam cooldowns, and clear visual states (`⋯ Blocking`, `✓ Blocked`, `✕ Retry block`).
- **Fast Page Loads**: Injects at `document_idle` and persists blocked authors and checked statuses in `sessionStorage`.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Reload open Reddit tabs.

## Repository Structure

- `manifest.json` - Chrome Extension Manifest V3 configuration.
- `content.js` - Content script for DOM button injection, empty-listing detection, and block API handling.
- `plans/CHANGES-1.4-argon.md` - Root-cause analysis of v1.3.8 rate-limit bugs and v1.4.1 changelog.
- `CHANGES-1.3.md`, `CHANGES-1.2.md`, `REVIEW-2026-10-22.md` - Historical changelogs and audits from prior versions.
