# IvoryRedditButtons

Lightweight Manifest V3 Chrome extension for Reddit (Shreddit and Old Reddit). Adds three direct action buttons to every post header in feeds, post pages, and user profiles:

- **Posts** - opens `/user/<author>/submitted/?sort=hot` directly, bypassing the mixed Overview tab.
- **Top posts** - opens `/user/<author>/submitted/?sort=top&t=all`.
- **Block** - blocks the post author in one click directly from the feed without opening their profile.

## Key Features in v1.4.0

- **Zero Background Network Traffic**: `Posts` and `Top posts` operate as pure links with zero background `.json` polling on scroll or hover, preventing Reddit session rate-limiting (`HTTP 429`) and page slowdowns.
- **Fast Page Loads**: Injects at `document_idle` with minimal `MutationObserver` overhead.
- **Reliable 1-Click Block**: Uses DOM/cookie CSRF and cached modhash tokens, sequential request queuing, `X-Ratelimit-Remaining` reserve protection, anti-spam cooldowns, and clear visual states (`⋯ Blocking`, `✓ Blocked`, `✕ Retry block`).
- **Session Persistence**: Remembers blocked authors in `sessionStorage` across page navigations and dims their posts automatically.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Reload open Reddit tabs.

## Repository Structure

- `manifest.json` - Chrome Extension Manifest V3 configuration.
- `content.js` - Content script for DOM button injection and block API handling.
- `plans/CHANGES-1.4-argon.md` - Detailed root-cause analysis of v1.3.8 rate-limit bugs and v1.4.0 changelog.
- `CHANGES-1.3.md`, `CHANGES-1.2.md`, `REVIEW-2026-10-22.md` - Historical changelogs and audits from prior versions.
