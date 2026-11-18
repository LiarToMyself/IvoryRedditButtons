# Changelog

All notable changes to IvoryRedditButtons will be documented in this file.

## [v1.4.4] - 2026-11-18

### Summary
Version 1.4.4 rewrites the core extension engine to eliminate HTTP 429 rate-limiting, separates UI styling into an external stylesheet, and speeds up feed and profile button updates.

### Added
- External `styles.css` (109 lines) for clean styling and MV3 CSP compliance.
- Complete architectural reference `EngineBlueprint.md`.
- Shreddit partial endpoint transport with fallback to JSON.
- Fast linked cascade for author post discovery (under 900ms).
- Stepped queue startup (4.5s initial delay) to halve first-screen latency without 429s.
- Isolated hover quota pool allowing instant checks regardless of background queue state.
- Cross-tab synchronization of empty status via `chrome.storage.local`.

### Fixed
- Fixed HTTP 429 flood caused by redundant polling of `/user/<author>/submitted.json`.
- Fixed false-red button states on empty profiles loaded with `sort=top`.
- Fixed false-green button states on posts with moderation removal banners.
- Fixed loss of second-step cascade requests on feed scroll.

### Changed
- Compact `content.js` reduced from 1129 to 514 lines.
- Extended cache TTL: 24 hours for authors with posts, 4 hours for empty profiles.
