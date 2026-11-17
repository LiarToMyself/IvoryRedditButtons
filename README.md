# IvoryRedditButtons

Lightweight Manifest V3 Chrome extension for Reddit (Shreddit and Old Reddit). Adds three direct action buttons to every post header in feeds, post pages, and user profiles:

- **Posts** - opens `/user/<author>/submitted/?sort=hot` directly, bypassing the mixed Overview tab. Highlights in red (`✕ No posts`) and prevents navigation if the author has no visible hot posts.
- **Top posts** - opens `/user/<author>/submitted/?sort=top&t=all`. Highlights in red (`✕ No top`) and prevents navigation if the author has no visible top posts.
- **Block** - blocks the post author in one click directly from the feed without opening their profile.

## Key Features in v1.4.4

- **Pre-Click Red Indicators (`✕ No posts` / `✕ No top`)**: Checks author listings before clicking, highlighting empty, removed, or unavailable accounts in red while preserving independent coloring for hot and top listings.
- **Native Shreddit Partial Transport with Fallback**: On `www.reddit.com`, listing checks query Reddit's internal Shreddit partial endpoint (`/svc/shreddit/profiles/profile_posts-more-posts/`), avoiding rudimentary `.json` bans, exposing real rate-limit headers (>220 requests per window), and filtering removed posts via `DOMParser`. Automatically falls back to `/user/<author>/submitted.json?limit=10` on `old.reddit.com` or unexpected responses.
- **Burst-Free Pacing & Protected Hover Reserve**: Smooth background spacing (`9.5s` / `14s` / `20s`, `5/min`, `24/10min`) eliminates queue freezes, while a dedicated priority lane (`7/min`, `30/10min`, `1.8s` gap) provides instant hover checks without letting background tasks starve user interactions.
- **Cross-Tab Quota Ledger & Post-429 Cooldown**: Coordinates rate limits across all Reddit tabs via `chrome.storage.local` and `navigator.locks`. Any `HTTP 429` triggers an immediate pause of at least 600 seconds and persists a 30-minute `slowUntil` flag, cutting request rates in half across all open and new tabs.
- **Zero-Request Profile Seeding & Safe Nested Crossposts**: On `/user/<owner>/submitted/`, all three buttons remain active, while the profile owner's status is seeded passively from DOM for zero network requests. Nested crossposts are verified on demand upon hover.
- **Reliable 1-Click Block**: Uses browser CSRF cookies and DOM tokens directly, avoiding redundant `/api/me.json` calls, checking rate limits prior to recording timestamps, and logging all Block network calls in the shared quota ledger.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Reload open Reddit tabs.
