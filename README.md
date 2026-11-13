# IvoryRedditButtons

Lightweight Manifest V3 Chrome extension for Reddit (Shreddit and Old Reddit). Adds three direct action buttons to every post header in feeds, post pages, and user profiles:

- **Posts** - opens `/user/<author>/submitted/?sort=hot` directly, bypassing the mixed Overview tab. Highlights in red (`✕ No posts`) and prevents navigation if the author has no visible posts.
- **Top posts** - opens `/user/<author>/submitted/?sort=top&t=all`. Highlights in red (`✕ No top`) and prevents navigation if the author has no visible top posts.
- **Block** - blocks the post author in one click directly from the feed without opening their profile.

## Key Features in v1.4.3

- **Accurate Single-Query Empty-State Detection (`✕ No posts` / `✕ No top`)**: Queries `/user/<author>/submitted.json?limit=5&sort=hot&raw_json=1` (1 request per author instead of 2), filters out removed/spam/hidden/deleted placeholder items (`isVisibleSubmissionItem`), treats `HTTP 403` / `HTTP 404` as empty, and updates both buttons atomically across all cards of the author.
- **Zero Rate-Limit Lockouts (`HTTP 429` Prevention)**: Halves background request volume, uses LIFO viewport prioritization (`VIEWPORT_DWELL_MS = 120ms`, `PREFETCH_MARGIN_PX = 350px`), preserves button wrappers across Shreddit `author-id` hydration, caps transient quota pauses in memory without freezing future sessions in `localStorage`, and keeps a 1-hour cross-tab `localStorage` status cache (`ivory_reddit_author_status_v2`).
- **Crosspost-Safe DOM Injection & Reliable 1-Click Block**: Scopes header and button lookups to each post's own container so nested crossposts never collide, dynamically reads hydrated `author-id` on click, and uses DOM/cookie CSRF and cached modhash tokens with sequential `Block` queuing.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Reload open Reddit tabs.

## Repository Structure

- `manifest.json` - Chrome Extension Manifest V3 configuration.
- `content.js` - Content script for DOM button injection, empty-listing detection, and block API handling.
- `icon.png` - Extension icon (128x128).
- `plans/CHANGES-1.4.3.md` - Root-cause analysis of v1.4.2 bugs and v1.4.3 changelog (Issue #10).
- `plans/CHANGES-1.4.2-argon.md`, `plans/CHANGES-1.4-argon.md`, `plans/CHANGES-1.3.md`, `plans/CHANGES-1.2.md`, `plans/REVIEW-2026-10-22.md` - Historical changelogs and audits from prior versions.
