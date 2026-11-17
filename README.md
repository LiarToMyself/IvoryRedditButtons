# IvoryRedditButtons

Lightweight Manifest V3 Chrome extension for Reddit (Shreddit and Old Reddit). Adds three direct action buttons to every post header in feeds, post pages, and user profiles:

- **Posts** - opens `/user/<author>/submitted/?sort=hot` directly, bypassing the mixed Overview tab. Highlights in red (`✕ No posts`) and prevents navigation if the author has no visible posts.
- **Top posts** - opens `/user/<author>/submitted/?sort=top&t=all`. Highlights in red (`✕ No top`) and prevents navigation if the author has no visible top posts.
- **Block** - blocks the post author in one click directly from the feed without opening their profile.

## Key Features in v1.4.4

- **Independent Red Empty-State Indicators (`✕ No posts` / `✕ No top`)**: Uses a `sort=top&t=all` -> `sort=hot` cascade (`limit=10`) with visible-post filtering (`isVisiblePost`), resolving ~90% of authors in 1 request while coloring `Posts` and `Top posts` independently when only top posts are empty.
- **Zero HTTP 429 Rate-Limit Lockouts**: Coordinates cross-tab pacing with `navigator.locks` (`ivory_reddit_quota_v5`), migrates prior request history across reloads, disables off-screen prefetching (`rootMargin: '0px'`), disables background polling on `/user/*` pages and nested crossposts, and seeds profile owner status directly from the loaded profile DOM for 0 network requests.
- **Instant Hover & Tab Return Recovery**: Reserves a dedicated fast lane for hover checks and the second cascade step so buttons turn red in the feed before clicking, and re-observes feed cards when returning from a profile tab.
- **Reliable 1-Click Block**: Uses DOM/cookie CSRF and cached modhash tokens, lazy `account_id` fallback, sequential queuing, and cross-tab blocked-author dimming.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Reload open Reddit tabs.
